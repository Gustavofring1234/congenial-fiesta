// Modelo NW4R completo em three.js: .glb (geometria e UVs) + sidecar .nw4r.json (materiais, ossos, skin, morphs).
//
// Os .glb do wispt não têm esqueleto: os vértices estão na pose de ligação (espaço do modelo). O sidecar traz:
//   bones[]  name, parent, flags, scale, rotate (graus; R = Rz·Ry·Rx, ou seja Euler 'ZYX' do three), translate, world (3x4)
//            flags & 0x20 = segment scale compensate (aplicado em sscUpdateMatrix)
//   meshes[] binding 'static' | 'rigid' (bone) | 'skinned' (skin: base64 de N × [4×u16 osso, 4×f32 peso])
//            morphs[] {name, deltas: base64 de N × 3×f32} (SHP0, morph relativo)
// Malhas rígidas e com skin viram SkinnedMesh com boneInverses = inverso de `world` (a pose de ligação do MDL0),
// então CHR0 nos ossos move tudo sem recalcular vértices. O referencial do Wii é o do three.js: nada é espelhado.
import { runtime } from '../../lib/runtime.js';
import { bindModelMaterials } from './Nw4rMaterial.js';

function b64(s) {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  const buf = globalThis.Buffer.from(s, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Matriz 3x4 do Wii (linhas; translação na 4ª coluna) -> Matrix4. */
export function wiiMatrix(rows, out) {
  const T = runtime.THREE;
  const m = out || new T.Matrix4();
  m.set(
    rows[0][0], rows[0][1], rows[0][2], rows[0][3],
    rows[1][0], rows[1][1], rows[1][2], rows[1][3],
    rows[2][0], rows[2][1], rows[2][2], rows[2][3],
    0, 0, 0, 1,
  );
  return m;
}

const DEG = Math.PI / 180;

/** Quaternion da rotação NW4R (graus, aplica X, depois Y, depois Z). */
export function nw4rQuaternion(rx, ry, rz, out) {
  const T = runtime.THREE;
  const e = new T.Euler(rx * DEG, ry * DEG, rz * DEG, 'ZYX');
  return (out || new T.Quaternion()).setFromEuler(e);
}

/** Flag do osso no MDL0: compensa a escala do pai (Maya "segment scale compensate"). */
export const SSC_APPLY = 0x20;

/**
 * Matriz local com segment scale compensate: M = T · S_pai⁻¹ · R · S. A posição do filho continua no espaço
 * escalado do pai (o cotovelo se afasta quando o braço estica), mas a rotação e a escala do filho não herdam a
 * escala do pai (sem cisalhamento). É o que os braços dos Mii do boxe usam (arm_*1/2 com escala X = 2).
 */
function sscUpdateMatrix() {
  const p = this.parent;
  if (!p || !p.isBone) { this.matrix.compose(this.position, this.quaternion, this.scale); }
  else {
    const T = runtime.THREE;
    const m = this.userData._ssc || (this.userData._ssc = { inv: new T.Matrix4(), zero: new T.Vector3() });
    this.matrix.compose(m.zero, this.quaternion, this.scale);
    m.inv.makeScale(1 / (p.scale.x || 1e-6), 1 / (p.scale.y || 1e-6), 1 / (p.scale.z || 1e-6));
    this.matrix.premultiply(m.inv);
    this.matrix.setPosition(this.position);
  }
  this.matrixWorldNeedsUpdate = true;
}

/** Ossos (Bone) a partir do sidecar, na pose de repouso (SRT locais). Devolve {bones, roots}. */
export function buildSkeletonBones(sidecar) {
  const T = runtime.THREE;
  const bones = (sidecar.bones || []).map((b) => {
    const bone = new T.Bone();
    bone.name = b.name;
    bone.position.fromArray(b.translate);
    nw4rQuaternion(b.rotate[0], b.rotate[1], b.rotate[2], bone.quaternion);
    bone.scale.fromArray(b.scale);
    bone.userData.nw4r = { rest: { t: [...b.translate], r: [...b.rotate], s: [...b.scale] }, billboard: b.billboard, flags: b.flags ?? 0 };
    if ((b.flags ?? 0) & SSC_APPLY) bone.updateMatrix = sscUpdateMatrix;
    return bone;
  });
  const roots = [];
  (sidecar.bones || []).forEach((b, i) => {
    if (b.parent >= 0 && bones[b.parent]) bones[b.parent].add(bones[i]);
    else roots.push(bones[i]);
  });
  return { bones, roots };
}

function skinAttributes(T, mesh, count) {
  const idx = new Uint16Array(count * 4);
  const w = new Float32Array(count * 4);
  if (mesh.binding === 'rigid') {
    for (let v = 0; v < count; v++) { idx[v * 4] = mesh.bone; w[v * 4] = 1; }
  } else {
    const dv = new DataView(b64(mesh.skin));
    if (dv.byteLength !== count * 24) throw new Error(`${mesh.name}: skin com ${dv.byteLength} bytes, esperado ${count * 24}`);
    for (let v = 0; v < count; v++) {
      const o = v * 24;
      for (let k = 0; k < 4; k++) {
        idx[v * 4 + k] = dv.getUint16(o + k * 2, true);
        w[v * 4 + k] = dv.getFloat32(o + 8 + k * 4, true);
      }
    }
  }
  return { skinIndex: new T.Uint16BufferAttribute(idx, 4), skinWeight: new T.Float32BufferAttribute(w, 4) };
}

function addMorphs(T, geometry, morphs) {
  const list = [];
  const names = {};
  const count = geometry.attributes.position.count;
  for (const m of morphs) {
    const arr = new Float32Array(b64(m.deltas));
    if (arr.length !== count * 3) continue;
    names[m.name] = list.length;
    const attr = new T.Float32BufferAttribute(arr, 3);
    attr.name = m.name;
    list.push(attr);
  }
  if (!list.length) return null;
  geometry.morphAttributes.position = list;
  geometry.morphTargetsRelative = true;
  return names;
}

/**
 * Carrega um modelo. Devolve um Group com userData.nw4r = {sidecar, bones, boneByName, meshes, materials, skeleton}.
 * @param {AssetStore} store
 * @param {string|object} sidecarOrPath  caminho do .nw4r.json (relativo à raiz dos dados) ou o objeto já lido
 * @param {object} [o] { textures: true }
 */
export async function loadModel(store, sidecarOrPath, { textures = true } = {}) {
  const T = runtime.THREE;
  const sidecar = typeof sidecarOrPath === 'string' ? await store.json(sidecarOrPath) : sidecarOrPath;
  const gltf = await store.gltf(sidecar.glb);
  const root = new T.Group();
  // a raiz NÃO pode ter o nome de um osso: o PropertyBinding testa a raiz antes dos filhos (ex.: glf_pin1)
  root.name = `mdl:${sidecar.model}`;
  const { bones, roots } = buildSkeletonBones(sidecar);
  roots.forEach((b) => root.add(b));
  const boneInverses = (sidecar.bones || []).map((b) => wiiMatrix(b.world).invert());
  const skeleton = bones.length ? new T.Skeleton(bones, boneInverses) : null;

  // malhas do glTF na ordem de gltf.meshes (= sidecar.meshes)
  const byMeshIndex = new Map();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const a = gltf.parser.associations.get(o);
    const mi = a && a.meshes !== undefined ? a.meshes : null;
    if (mi === null) return;
    if (!byMeshIndex.has(mi)) byMeshIndex.set(mi, []);
    byMeshIndex.get(mi).push(o);
  });

  const meshes = [];
  const meshesByBone = new Map();
  (sidecar.meshes || []).forEach((sm, i) => {
    for (const src of byMeshIndex.get(i) || []) {
      const geometry = src.geometry;
      geometry.applyMatrix4(src.matrixWorld); // o nó do glTF costuma ser identidade; garante espaço do modelo
      const morphNames = sm.morphs ? addMorphs(T, geometry, sm.morphs) : null;
      let mesh;
      if (skeleton && (sm.binding === 'rigid' || sm.binding === 'skinned')) {
        const { skinIndex, skinWeight } = skinAttributes(T, sm, geometry.attributes.position.count);
        geometry.setAttribute('skinIndex', skinIndex);
        geometry.setAttribute('skinWeight', skinWeight);
        mesh = new T.SkinnedMesh(geometry, src.material);
        mesh.bind(skeleton, new T.Matrix4());
        mesh.frustumCulled = false; // a caixa da pose de ligação não acompanha a animação
      } else {
        mesh = new T.Mesh(geometry, src.material);
      }
      mesh.name = sm.name;
      if (morphNames) { mesh.morphTargetDictionary = morphNames; mesh.morphTargetInfluences = new Array(Object.keys(morphNames).length).fill(0); }
      mesh.userData.nw4r = { binding: sm.binding, bone: sm.bone ?? null, translucent: sm.translucent };
      root.add(mesh);
      meshes.push(mesh);
      // malhas que o VIS0 esconde junto com o osso (rígidas: o próprio osso)
      if (sm.binding === 'rigid' && bones[sm.bone]) {
        const n = bones[sm.bone].name;
        if (!meshesByBone.has(n)) meshesByBone.set(n, []);
        meshesByBone.get(n).push(mesh);
      }
    }
  });

  const report = await bindModelMaterials(root, sidecar, store, { textures });
  root.userData.nw4r = {
    sidecar, assetId: sidecar.assetId, model: sidecar.model, bones, skeleton,
    boneByName: new Map(bones.map((b) => [b.name, b])), meshes, meshesByBone,
    materials: report.materials, unmatchedMaterials: report.unmatched,
  };
  return root;
}

/** Volta todos os ossos à pose de repouso do sidecar. */
export function resetPose(model) {
  for (const bone of model.userData.nw4r?.bones || []) {
    const r = bone.userData.nw4r.rest;
    bone.position.fromArray(r.t);
    nw4rQuaternion(r.r[0], r.r[1], r.r[2], bone.quaternion);
    bone.scale.fromArray(r.s);
  }
}
