// Etapa 1 no three.js: vínculo textura-material, rig dos modelos, cenas + .pmp + BVH, textos e layouts 2D.
// Rode: node --test tests/sports/
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, mod, json } from './helpers.mjs';

const { THREE, store } = await setup();
const { loadModel, wiiMatrix } = await mod('engine/assets/ModelLoader.js');
const { baseLayerIndex } = await mod('engine/assets/Nw4rMaterial.js');
const { SceneLoader } = await mod('engine/scene/SceneLoader.js');
const { TextManager } = await mod('ui/TextManager.js');
const { createLayoutState, bindAnimation, applyAnimationFrame } = await mod('ui/LayoutPlayer.js');

async function allSidecars() {
  const idx = await json('Scenes/scenes_index.json');
  const set = new Set();
  for (const s of idx.scenes) for (const m of (await json(s.file)).models) if (m.sidecar) set.add(m.sidecar);
  const anims = await json('animations_manifest.json');
  for (const a of anims.animations) for (const m of a.models) set.add(m.sidecar);
  return [...set].sort();
}

test('259 modelos: materiais do glTF casam 1:1 com o sidecar e cada camada base tem PNG', async () => {
  const paths = await allSidecars();
  assert.equal(paths.length, 259);
  let mats = 0, unmatched = 0, withBase = 0, untextured = 0, lost = 0, bound = 0;
  for (const p of paths) {
    const model = await loadModel(store, p, { textures: false });
    const info = model.userData.nw4r;
    unmatched += info.unmatchedMaterials.length;
    for (const def of info.sidecar.materials) {
      mats++;
      if (baseLayerIndex(def) >= 0) withBase++;
      else if (!def.layers.length) untextured++;   // material sem textura no MDL0 (ex.: M_Kiwa_Black, col_WATER)
      else lost++;                                 // tinha camada e perdeu o PNG: vínculo quebrado
    }
    model.traverse((o) => { if (o.isMesh && o.material?.userData?.nw4r) bound++; });
  }
  assert.equal(mats, 914);
  assert.equal(unmatched, 0);
  assert.equal(lost, 0);
  assert.equal(withBase + untextured, 914);
  assert.equal(withBase, 888);
  assert.ok(bound > 0);
});

test('ossos: SRT local composto com Euler ZYX reproduz a matriz de mundo do MDL0 (1.249 ossos)', async () => {
  const paths = await allSidecars();
  let n = 0, worst = 0;
  const m = new THREE.Matrix4();
  for (const p of paths) {
    const sc = await json(p);
    if (!sc.bones?.length) continue;
    const model = await loadModel(store, sc, { textures: false });
    model.updateMatrixWorld(true);
    for (const bone of model.userData.nw4r.bones) {
      const ref = wiiMatrix(sc.bones.find((b) => b.name === bone.name).world, m);
      const a = bone.matrixWorld.elements, b = ref.elements;
      for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      n++;
    }
  }
  assert.equal(n, 1249);
  assert.ok(worst < 1e-3, `maior diferença ${worst}`);
});

test('skin: corpo Mii vira SkinnedMesh, pesos somam 1 e CHR0 nos ossos move os vértices', async () => {
  const p = (await allSidecars()).find((x) => x.includes('ava_bodyA1__'));
  const model = await loadModel(store, p, { textures: false });
  const mesh = model.userData.nw4r.meshes[0];
  assert.ok(mesh.isSkinnedMesh);
  const w = mesh.geometry.attributes.skinWeight;
  for (let i = 0; i < w.count; i += 37) assert.ok(Math.abs(w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i) - 1) < 1e-4);
  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3();
  model.updateMatrixWorld(true);
  mesh.getVertexPosition(0, v0).applyMatrix4(mesh.matrixWorld);
  const raw = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, 0);
  assert.ok(v0.distanceTo(raw) < 1e-3, 'na pose de repouso o vértice skinado = vértice do .glb');
  model.userData.nw4r.boneByName.get('skl_root').position.y += 2;
  model.updateMatrixWorld(true);
  mesh.getVertexPosition(0, v1).applyMatrix4(mesh.matrixWorld);
  assert.ok(Math.abs(v1.y - v0.y - 2) < 1e-3);
});

test('cenas: 32 cenas, 21 colisões em MeshBVH; objetos .pmp sobre o terreno e tee -> pinos', async () => {
  const loader = new SceneLoader(store);
  const list = await loader.list();
  assert.equal(list.length, 32);
  const golf = list.filter((s) => s.objects > 0);
  let on = 0, total = 0, aligned = 0, tees = 0;
  const dys = [];
  const glbs = new Set();
  for (const s of list) for (const c of (await json(s.file)).collision) if (c.glb) glbs.add(c.glb);
  assert.equal(glbs.size, 21);
  for (const entry of golf) {
    const sc = await loader.load(entry, { textures: false });
    assert.ok(sc.collision.triangleCount > 0);
    for (const o of sc.objects) {
      total++;
      const g = sc.collision.heightNear(o.position.x, o.position.z, o.position.y);
      if (g) { on++; dys.push(o.position.y - g.point.y); }
    }
    const tee = sc.objects.filter((o) => o.userData.pmp.kind === 'tee');
    const pins = sc.objects.filter((o) => o.userData.pmp.kind === 'pin');
    if (tee.length === 1 && pins.length) {
      tees++;
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(tee[0].quaternion);
      const c = pins.reduce((a, p) => a.add(p.position), new THREE.Vector3()).divideScalar(pins.length).sub(tee[0].position);
      if (fwd.x * c.x + fwd.z * c.z > 0) aligned++;
      // superfície sob o tee pela flag do KCL
      const g = sc.collision.groundAt(tee[0].position.x, tee[0].position.z, tee[0].position.y + 50);
      assert.equal(g.surface, 'tee', `${entry.name}: superfície sob o tee = ${g.surface}`);
    }
  }
  dys.sort((a, b) => a - b);
  assert.equal(total, 1361);
  assert.ok(on >= 1355, `sobre a colisão: ${on}`);
  assert.ok(Math.abs(dys[dys.length >> 1]) < 1, `mediana da altura ${dys[dys.length >> 1]}`);
  assert.equal(aligned, tees);
});

test('textos: en pelo .bmg, pt/ja caem no inglês quando não traduzidos, format e busca', async () => {
  const en = await TextManager.load('en', store);
  assert.equal(en.format('common_message', 10752, 'Wii Sports'), 'Please insert the Wii Sports\nGame Disc.');
  assert.equal(en.format('common_message', 999999), '[common_message#999999]');
  assert.ok(en.search('bowling').length > 0);
  const pt = await TextManager.load('pt', store);
  const m = pt.get('common_message', 10752);
  assert.ok(m && m.text.includes('{0}'));
  assert.equal(pt.language, 'pt');
});

test('layouts: 138 layouts, 647 animações; alvos ausentes (47 animações) ignorados sem exceção', async () => {
  const man = await json('UI/ui_manifest.json');
  assert.equal(man.layouts.length, 138);
  let anims = 0, withMissing = 0, applied = 0;
  for (const l of man.layouts) {
    const meta = await json('UI/' + l.file);
    const state = createLayoutState(meta);
    for (const a of l.animations) {
      anims++;
      const anim = await json('UI/' + a.file);
      const b = bindAnimation(anim, state);
      if (b.missing.length) withMissing++;
      for (const f of [0, (anim.frameSize || 1) / 2, anim.frameSize || 1]) applyAnimationFrame(b, f, []);
      applied++;
    }
  }
  assert.equal(anims, 647);
  assert.equal(applied, 647);
  assert.equal(withMissing, 47);
});
