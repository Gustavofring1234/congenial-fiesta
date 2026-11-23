// Colisão das cenas: as 21 malhas .glb (convertidas do KCL) indexadas numa MeshBVH (three-mesh-bvh, a mesma
// que o pacote vendor do WEBC traz em CompanhiaVRM.MeshBVH). Sem alterar Mesh.prototype.raycast: as consultas
// vão direto à árvore.
//
// Cada .glb guarda um nó collision_0xNNNN por flag de superfície do KCL. A malha unificada guarda a flag em cada
// VÉRTICE (vertexFlags): a MeshBVH reordena o índice de triângulos ao construir a árvore, mas cada triângulo
// continua com os seus três vértices, então flagOf(faceIndex) segue certo depois da construção. SURFACES traduz as dos campos de golfe
// (index/gameplay-export.json: 1 tee, 6/11 green confirmados pelos objetos .pmp; 2/3/4/5/7/12/13 inferidos).
import { runtime } from '../../lib/runtime.js';

export const SURFACES = {
  1: 'tee', 2: 'fairway', 3: 'bunker', 4: 'rough', 5: 'deepRough', 6: 'green', 7: 'out',
  8: 'rough', 9: 'green', 10: 'rough', 11: 'green', 12: 'water', 13: 'out',
};

export function flagFromName(name) {
  const m = /collision_0x([0-9a-f]+)/i.exec(name || '');
  return m ? parseInt(m[1], 16) : 0;
}

export class CollisionWorld {
  constructor() {
    const T = runtime.THREE;
    this.geometry = null;
    this.bvh = null;
    this.vertexFlags = new Uint16Array(0);
    this.triangles = 0;
    this.sources = [];
    this._ray = new T.Ray();
    this._v = new T.Vector3();
    this._n = new T.Vector3();
    this._tri = new T.Triangle();
  }

  /** Lê as malhas de colisão (caminhos relativos à raiz dos dados) e monta a árvore. */
  static async load(store, glbPaths) {
    const w = new CollisionWorld();
    const parts = [];
    for (const p of glbPaths.filter(Boolean)) {
      const g = await store.gltf(p);
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => { if (o.isMesh) parts.push({ geometry: o.geometry, matrix: o.matrixWorld.clone(), flag: flagFromName(o.name), source: p }); });
      w.sources.push(p);
    }
    w.build(parts);
    return w;
  }

  /** parts: [{geometry, matrix?, flag}] -> uma geometria indexada com flags por triângulo. */
  build(parts) {
    const T = runtime.THREE;
    let nv = 0, nt = 0;
    for (const p of parts) {
      nv += p.geometry.attributes.position.count;
      nt += (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count) / 3;
    }
    const pos = new Float32Array(nv * 3);
    const idx = new Uint32Array(nt * 3);
    const flags = new Uint16Array(nv);
    const v = new T.Vector3();
    let vo = 0, to = 0;
    for (const p of parts) {
      const a = p.geometry.attributes.position;
      for (let i = 0; i < a.count; i++) {
        v.fromBufferAttribute(a, i);
        if (p.matrix) v.applyMatrix4(p.matrix);
        pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
      }
      const ix = p.geometry.index;
      const n = ix ? ix.count : a.count;
      for (let k = 0; k < n; k++) idx[to * 3 + k] = vo + (ix ? ix.getX(k) : k);
      flags.fill(p.flag || 0, vo, vo + a.count);
      vo += a.count;
      to += n / 3;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setIndex(new T.BufferAttribute(idx, 1));
    this.geometry = g;
    this.vertexFlags = flags;
    this.triangles = nt;
    this.bvh = nt ? new runtime.MeshBVH(g) : null;
    if (this.bvh) g.boundsTree = this.bvh;
    return this;
  }

  get triangleCount() { return this.triangles; }

  /** Flag KCL do triângulo (índice depois da construção da árvore). */
  flagOf(faceIndex) { return this.vertexFlags[this.geometry.index.getX(faceIndex * 3)] || 0; }

  _hit(h) {
    if (!h) return null;
    const flag = this.flagOf(h.faceIndex);
    const normal = h.face ? h.face.normal.clone() : this.faceNormal(h.faceIndex);
    return { point: h.point.clone(), distance: h.distance, faceIndex: h.faceIndex, normal, flag, surface: SURFACES[flag] || null };
  }

  faceNormal(faceIndex, out) {
    const T = runtime.THREE;
    const i = this.geometry.index, p = this.geometry.attributes.position;
    const a = new T.Vector3().fromBufferAttribute(p, i.getX(faceIndex * 3));
    const b = new T.Vector3().fromBufferAttribute(p, i.getX(faceIndex * 3 + 1));
    const c = new T.Vector3().fromBufferAttribute(p, i.getX(faceIndex * 3 + 2));
    this._tri.set(a, b, c);
    return this._tri.getNormal(out || new T.Vector3());
  }

  /** Primeiro triângulo no raio (origin, dir normalizado) até far. Os dois lados contam. */
  raycast(origin, dir, far = Infinity) {
    if (!this.bvh) return null;
    const T = runtime.THREE;
    this._ray.origin.copy(origin);
    this._ray.direction.copy(dir).normalize();
    const h = this.bvh.raycastFirst(this._ray, T.DoubleSide, 0, far);
    return h && h.distance <= far ? this._hit(h) : null;
  }

  /** Chão sob (x, z): o triângulo mais alto abaixo de fromY (padrão: 10 km acima). */
  groundAt(x, z, fromY = 1e5) {
    const T = runtime.THREE;
    return this.raycast(new T.Vector3(x, fromY, z), new T.Vector3(0, -1, 0));
  }

  /** Entre todas as superfícies na vertical de (x, z), a de altura mais próxima de nearY (pontes, marquises, níveis). */
  heightNear(x, z, nearY) {
    if (!this.bvh) return null;
    const T = runtime.THREE;
    this._ray.origin.set(x, 1e5, z);
    this._ray.direction.set(0, -1, 0);
    const hits = this.bvh.raycast(this._ray, T.DoubleSide);
    let best = null;
    for (const h of hits) if (!best || Math.abs(h.point.y - nearY) < Math.abs(best.point.y - nearY)) best = h;
    return this._hit(best);
  }

  /** Esfera contra a malha: {point, normal (da superfície para o centro), depth, flag, surface} ou null. */
  sphereContact(center, radius) {
    if (!this.bvh) return null;
    const T = runtime.THREE;
    const r = this.bvh.closestPointToPoint(center, {}, 0, radius);
    if (!r || r.distance > radius) return null;
    const point = r.point.clone();
    const normal = new T.Vector3().subVectors(center, point);
    const len = normal.length();
    if (len > 1e-6) normal.divideScalar(len); else this.faceNormal(r.faceIndex, normal);
    const flag = this.flagOf(r.faceIndex);
    return { point, normal, depth: radius - r.distance, faceIndex: r.faceIndex, flag, surface: SURFACES[flag] || null };
  }

  /** Malha invisível para depuração (wireframe). */
  debugMesh(color = 0x00ff88) {
    const T = runtime.THREE;
    const m = new T.Mesh(this.geometry, new T.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.25 }));
    m.name = 'collision-debug';
    return m;
  }
}
