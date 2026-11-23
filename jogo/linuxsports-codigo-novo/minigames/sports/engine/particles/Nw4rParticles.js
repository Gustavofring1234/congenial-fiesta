// Partículas NW4R (.breff decodificado de linuxsports-web + texturas .breft de linuxsports-web-wispt, por
// tools/export_effects.py -> Effects/<pacote>/<pacote>.effect.json + PNGs) num emissor leve de three.js 0.180:
// um THREE.Points por emissor, atributos por partícula (posição, cor RGBA, tamanho, rotação) e simulação na CPU.
//
// Unidades: quadros a 60 Hz e unidades de mundo do jogo (as das cenas). vida (quadros)/60 = s; velocidade
// (u/quadro)·60 = u/s; gravidade de campo (u/quadro²)·3600 = u/s²; resistência do ar k: v *= k^(dt·60).
// Curvas de partícula: color0/alpha0/scale/rotate ao longo da vida (chaves interpoladas linearmente; t = quadro /
// comprimento, com comprimento = `length` quando relativeToLife, senão a vida da partícula), como o player Unity.
// Formas: point, disc (plano XZ), sphere, cube, line, cylinder, torus; form8/form9 (não identificadas) = ponto.
// Mistura aditiva para as categorias spark/glow/trail (os bytes de "draw settings" ficam brutos no JSON).
import { runtime, NW4R_FPS } from '../../lib/runtime.js';
import { defaultStore } from '../assets/AssetStore.js';

const ADDITIVE = new Set(['spark', 'glow', 'trail']);

const VERT = `
attribute vec4 pColor;
attribute float pSize;
attribute float pRot;
varying vec4 vColor;
varying float vRot;
uniform float uScale;
void main() {
  vColor = pColor;
  vRot = pRot;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = pSize * uScale / max(0.001, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform sampler2D uMap;
uniform float uHasMap;
varying vec4 vColor;
varying float vRot;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  vec2 uv = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  vec4 t = uHasMap > 0.5 ? texture2D(uMap, vec2(uv.x, 1.0 - uv.y)) : vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(0.3, 0.5, length(p)));
  gl_FragColor = t * vColor;
  if (gl_FragColor.a < 0.004) discard;
  #include <colorspace_fragment>
}`;

/** Chaves de uma curva de partícula -> [{t, v:[...]}] ordenadas (t em 0..1 da vida). */
function curveKeys(c, life) {
  const len = Math.max(1, c.relativeToLife ? Math.max(c.length || 1, 1) : life);
  return (c.keys || []).map((k) => ({ t: Math.min(1, Math.max(0, k.frame / len)), v: k.values })).sort((a, b) => a.t - b.t);
}

function evalKeys(keys, t, i = 0) {
  if (!keys || !keys.length) return undefined;
  if (t <= keys[0].t) return keys[0].v[i] ?? keys[0].v[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v[i] ?? last.v[0];
  let k = 0;
  while (k + 1 < keys.length && keys[k + 1].t <= t) k++;
  const a = keys[k], b = keys[k + 1];
  const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
  const va = a.v[i] ?? a.v[0], vb = b.v[i] ?? b.v[0];
  return va + (vb - va) * f;
}

/** Converte um emissor do JSON nos parâmetros da simulação (puro: testável sem WebGL). */
export function emitterParams(em) {
  const e = em.emitter || {}, p = em.particle || {}, vel = e.velocity || {};
  const life = Math.max(1, e.particleLife || 30);
  const interval = Math.max(0, e.emitInterval || 0);
  const emitLife = e.emitLife ?? 0;
  const infinite = emitLife >= 0xffff || emitLife === 0;
  const curves = {};
  let gravity = 0, air = 1;
  for (const c of em.curves || []) {
    if (!c.keys?.length) continue;
    if (c.target === 'fieldGravity') gravity = c.keys[0].values[0];
    else if (c.target === 'fieldAirResistance') air = Math.min(1.5, Math.max(0, c.keys[0].values[0]));
    else if (['color0', 'alpha0', 'scale', 'rotate'].includes(c.target)) curves[c.target] = curveKeys(c, life);
  }
  const size = p.size || [1, 1], pscale = p.scale || [1, 1];
  const scale = e.scale || [1, 1, 1];
  const radius = Math.max(1e-4, Math.max(Math.abs(scale[0]), Math.abs(scale[2] ?? scale[0])));
  let dir = [0, vel.yAxis || 0, 0];
  if (Math.abs(vel.specified || 0) > 1e-6 && vel.specifiedDirection?.length >= 3) {
    // a direção especificada vem como ângulos (rad) de um vetor +Y (Euler XYZ)
    const [ax, ay, az] = vel.specifiedDirection;
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    // R = Rz·Ry·Rx aplicado a (0,1,0)
    const v = [-sz * cx + cz * sy * sx, cz * cx + sz * sy * sx, cy * sx];
    dir = [dir[0] + v[0] * vel.specified, dir[1] + v[1] * vel.specified, dir[2] + v[2] * vel.specified];
  }
  return {
    name: em.name, category: em.category || 'other', additive: ADDITIVE.has(em.category),
    life, lifeRandom: Math.min(1, Math.abs(e.particleLifeRandomPct || 0) / 100),
    interval, emitCount: Math.max(0, e.emitCount ?? 1), emitLife, infinite,
    burst: !infinite && emitLife <= interval + 1,
    duration: infinite ? Infinity : Math.max(1, emitLife) / NW4R_FPS,
    form: e.form || 'point', radius, boxScale: scale,
    translate: e.translate || [0, 0, 0],
    radialSpeed: ((vel.radial || 0) + (vel.normal || 0)) * NW4R_FPS,
    randomSpeed: Math.abs(vel.random || 0) * NW4R_FPS,
    velRandom: Math.min(1, Math.abs(e.velocityInitRandomPct || 0) / 100),
    impulse: dir.map((x) => x * NW4R_FPS),
    gravity: gravity * NW4R_FPS * NW4R_FPS, air,
    size: [size[0] * pscale[0], (size[1] ?? size[0]) * (pscale[1] ?? pscale[0])],
    color: p.color0Primary || [255, 255, 255, 255],
    rotation: ((p.rotate || [0, 0, 0])[2] || 0),
    texture: (p.textureResources || [])[0] || null,
    curves,
  };
}

function shapePoint(P, rnd, out) {
  const r = P.radius;
  switch (P.form) {
    case 'disc': { const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r; out.set(Math.cos(a) * d, 0, Math.sin(a) * d); break; }
    case 'sphere': { const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, d = Math.cbrt(rnd()) * r, s = Math.sqrt(1 - u * u); out.set(s * Math.cos(a) * d, u * d, s * Math.sin(a) * d); break; }
    case 'cube': out.set((rnd() - 0.5) * P.boxScale[0], (rnd() - 0.5) * P.boxScale[1], (rnd() - 0.5) * P.boxScale[2]); break;
    case 'line': out.set((rnd() - 0.5) * 2 * r, 0, 0); break;
    case 'cylinder': { const a = rnd() * Math.PI * 2; out.set(Math.cos(a) * r, (rnd() - 0.5) * P.boxScale[1], Math.sin(a) * r); break; }
    case 'torus': { const a = rnd() * Math.PI * 2, b = rnd() * Math.PI * 2, rr = r * 0.25; out.set((r + rr * Math.cos(b)) * Math.cos(a), rr * Math.sin(b), (r + rr * Math.cos(b)) * Math.sin(a)); break; }
    default: out.set(0, 0, 0);
  }
  out.x += P.translate[0]; out.y += P.translate[1]; out.z += P.translate[2];
  return out;
}

export class ParticleEmitter {
  /**
   * @param {object} params  emitterParams(em)
   * @param {THREE.Texture|null} map
   * @param {object} [o] { max: limite de partículas, random: () => [0,1), pixelScale: altura do canvas / (2·tan(fov/2)) }
   */
  constructor(params, map = null, { max, random = Math.random, pixelScale = 600 } = {}) {
    const T = runtime.THREE;
    this.P = params;
    this.rnd = random;
    const perFrame = params.emitCount / (params.interval + 1);
    this.max = max || Math.min(4000, Math.max(8, Math.ceil(params.burst ? params.emitCount : perFrame * params.life * (1 + params.lifeRandom)) + 8));
    const n = this.max;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.lifeOf = new Float32Array(n).fill(-1);
    this.col = new Float32Array(n * 4);
    this.siz = new Float32Array(n);
    this.rot = new Float32Array(n);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(this.pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('pColor', new T.BufferAttribute(this.col, 4).setUsage(T.DynamicDrawUsage));
    g.setAttribute('pSize', new T.BufferAttribute(this.siz, 1).setUsage(T.DynamicDrawUsage));
    g.setAttribute('pRot', new T.BufferAttribute(this.rot, 1).setUsage(T.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const mat = new T.ShaderMaterial({
      uniforms: { uMap: { value: map }, uHasMap: { value: map ? 1 : 0 }, uScale: { value: pixelScale } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: params.additive ? T.AdditiveBlending : T.NormalBlending,
    });
    this.points = new T.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.name = `nw4r:${params.name}`;
    this.points.userData.emitter = this;
    this.object = this.points;
    this.time = 0;
    this.carry = 0;
    this.live = 0;
    this.emitting = true;
    this.burstDone = false;
    this._v = new T.Vector3();
    this._w = new T.Vector3();
    this._c = new T.Color();
  }

  /** Para de emitir; some quando a última partícula morre. */
  stop() { this.emitting = false; }

  get finished() { return !this.emitting && this.live === 0; }

  setPixelScale(s) { this.points.material.uniforms.uScale.value = s; }

  spawnOne() {
    const P = this.P;
    let i = -1;
    for (let k = 0; k < this.max; k++) if (this.lifeOf[k] < 0) { i = k; break; }
    if (i < 0) return;
    const p = shapePoint(P, this.rnd, this._v);
    // as partículas vivem no espaço do mundo: a posição nasce pela matriz do emissor
    this._w.copy(p).applyMatrix4(this.points.matrixWorld);
    this.pos[i * 3] = this._w.x; this.pos[i * 3 + 1] = this._w.y; this.pos[i * 3 + 2] = this._w.z;
    const outward = p.lengthSq() > 1e-10 ? p.clone().normalize() : new runtime.THREE.Vector3(this.rnd() - 0.5, this.rnd() - 0.5, this.rnd() - 0.5).normalize();
    const sp = P.radialSpeed * (1 - P.velRandom * this.rnd());
    const v = this._v.set(
      outward.x * sp + P.impulse[0] + (this.rnd() - 0.5) * 2 * P.randomSpeed,
      outward.y * sp + P.impulse[1] + (this.rnd() - 0.5) * 2 * P.randomSpeed,
      outward.z * sp + P.impulse[2] + (this.rnd() - 0.5) * 2 * P.randomSpeed,
    );
    const speed = v.length();
    if (speed > 0) v.transformDirection(this.points.matrixWorld).multiplyScalar(speed); // gira com o emissor, mantém a velocidade
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.age[i] = 0;
    this.lifeOf[i] = (P.life * (1 - P.lifeRandom * this.rnd())) / NW4R_FPS;
    this.rot[i] = P.rotation * Math.PI / 180;
    this.live++;
  }

  update(dt) {
    const P = this.P;
    this.points.updateMatrixWorld();
    if (this.emitting) {
      if (P.burst) {
        if (!this.burstDone) { for (let k = 0; k < Math.max(1, Math.round(P.emitCount)); k++) this.spawnOne(); this.burstDone = true; }
        this.emitting = false;
      } else {
        this.carry += dt * NW4R_FPS * P.emitCount / (P.interval + 1);
        while (this.carry >= 1) { this.spawnOne(); this.carry -= 1; }
      }
      this.time += dt;
      if (this.time >= P.duration) this.emitting = false;
    }
    const drag = P.air < 0.9999 ? Math.pow(Math.max(P.air, 1e-4), dt * NW4R_FPS) : 1;
    const c0 = P.color, cv = P.curves;
    let top = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.lifeOf[i] < 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.lifeOf[i]) { this.lifeOf[i] = -1; this.live--; this.col[i * 4 + 3] = 0; this.siz[i] = 0; continue; }
      top = i + 1;
      const t = this.age[i] / this.lifeOf[i];
      this.vel[i * 3 + 1] -= P.gravity * dt;
      this.vel[i * 3] *= drag; this.vel[i * 3 + 1] *= drag; this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const r = cv.color0 ? evalKeys(cv.color0, t, 0) : c0[0];
      const g = cv.color0 ? evalKeys(cv.color0, t, 1) : c0[1];
      const b = cv.color0 ? evalKeys(cv.color0, t, 2) : c0[2];
      const a = cv.alpha0 ? evalKeys(cv.alpha0, t, 0) : c0[3];
      this._c.setRGB(r / 255, g / 255, b / 255, runtime.THREE.SRGBColorSpace);
      this.col[i * 4] = this._c.r; this.col[i * 4 + 1] = this._c.g; this.col[i * 4 + 2] = this._c.b; this.col[i * 4 + 3] = a / 255;
      const s = cv.scale ? evalKeys(cv.scale, t, 0) : 1;
      this.siz[i] = Math.max(P.size[0], P.size[1]) * s;
      if (cv.rotate) this.rot[i] = evalKeys(cv.rotate, t, cv.rotate[0].v.length - 1) * Math.PI / 180;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, top);
    for (const n of ['position', 'pColor', 'pSize', 'pRot']) g.attributes[n].needsUpdate = true;
  }

  dispose() { this.points.geometry.dispose(); this.points.material.dispose(); this.points.removeFromParent(); }
}

/** Os 10 pacotes / 380 emissores: spawn por nome, atualização e limpeza dos emissores ativos. */
export class EffectLibrary {
  constructor(store = defaultStore()) {
    this.store = store;
    this.index = null;
    this.packs = new Map();     // pacote -> JSON
    this.byName = new Map();    // emissor -> {pack, em}
    this.active = new Set();
    this.pixelScale = 600;
  }

  async load(packs = null) {
    if (!this.index) this.index = await this.store.json('Effects/effects_index.json');
    const want = this.index.packs.filter((p) => !packs || packs.includes(p.pack));
    await Promise.all(want.map(async (p) => {
      if (this.packs.has(p.pack)) return;
      const doc = await this.store.json(`${p.resource}.effect.json`);
      this.packs.set(p.pack, doc);
      for (const em of doc.emitters) if (!this.byName.has(em.name)) this.byName.set(em.name, { pack: p.pack, em });
    }));
    return this;
  }

  get names() { return [...this.byName.keys()]; }

  /** Ajusta o tamanho dos pontos à câmera (chame ao redimensionar). */
  setCamera(camera, heightPx) {
    const fov = (camera.fov || 50) * Math.PI / 180;
    this.pixelScale = heightPx / (2 * Math.tan(fov / 2));
    for (const e of this.active) e.setPixelScale(this.pixelScale);
  }

  /**
   * Cria e liga um emissor. `at`: Vector3 ou Object3D (o emissor vira filho dele). Devolve o ParticleEmitter
   * (ou null se o nome não existe), já adicionado a `parent` quando dado.
   */
  async spawn(name, { parent = null, at = null, random } = {}) {
    if (!this.byName.has(name)) await this.load();
    const hit = this.byName.get(name);
    if (!hit) return null;
    const P = emitterParams(hit.em);
    let map = null;
    if (P.texture) map = await this.store.texture(`${P.texture}.png`, { wrapS: 'clamp', wrapT: 'clamp' }).catch(() => null);
    const em = new ParticleEmitter(P, map, { random, pixelScale: this.pixelScale });
    if (at && at.isObject3D) at.add(em.object);
    else { if (at) em.object.position.copy(at); if (parent) parent.add(em.object); }
    this.active.add(em);
    return em;
  }

  update(dt) {
    for (const e of this.active) {
      e.update(dt);
      if (e.finished) { e.dispose(); this.active.delete(e); }
    }
  }

  clear() { for (const e of this.active) e.dispose(); this.active.clear(); }
}
