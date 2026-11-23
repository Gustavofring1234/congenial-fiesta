// Bola com física própria (BallFlight) e colisão contra o mundo da cena. Porte de Activities/Common/BallBody.cs:
// passos fixos (iguais em todo navegador), quique com restituição/atrito/spin por superfície, rolamento seguindo a
// inclinação e repouso. O "mundo" é uma interface pequena para a mesma física servir à malha BVH da cena
// (meshWorld, CollisionWorld da Etapa 1) ou a um plano (planeWorld, usado no tênis/beisebol e nos testes):
//   cast(from, to, radius) -> {pos, normal, surface, point} | null   primeira colisão da esfera no trajeto
//   ground(x, z, fromY)    -> {y, normal, surface} | null            chão sob o ponto
import { v3, add, sub, scale, dot, len, cross, norm, UP } from './vec3.js';
import { step, bounce, GRAVITY, BALLS } from './BallFlight.js';
import { runtime } from '../../lib/runtime.js';

/** Plano horizontal infinito em y (com superfície fixa). */
export function planeWorld(y = 0, surface = 'ground') {
  return {
    cast(from, to, radius) {
      if (to.y - radius >= y) return null;
      const t = from.y - to.y > 1e-9 ? Math.max(0, Math.min(1, (from.y - radius - y) / (from.y - to.y))) : 1;
      const pos = v3(from.x + (to.x - from.x) * t, y + radius, from.z + (to.z - from.z) * t);
      return { pos, normal: v3(0, 1, 0), surface, point: v3(pos.x, y, pos.z) };
    },
    ground(x, z) { return { y, normal: v3(0, 1, 0), surface }; },
  };
}

/** Adapta a CollisionWorld (MeshBVH) da cena. Superfícies do golfe: 'out' vira 'outOfBounds'. */
export function meshWorld(collision, { fallbackY = null } = {}) {
  const T = runtime.THREE;
  const o = new T.Vector3(), d = new T.Vector3(), c = new T.Vector3();
  const surf = (s) => (s === 'out' ? 'outOfBounds' : s || 'ground');
  const plane = fallbackY === null ? null : planeWorld(fallbackY);
  return {
    collision,
    cast(from, to, radius) {
      const dl = sub(to, from), L = len(dl);
      if (L > 1e-6) {
        o.set(from.x, from.y, from.z);
        d.set(dl.x / L, dl.y / L, dl.z / L);
        const h = collision.raycast(o, d, L + radius);
        if (h) {
          let n = v3(h.normal.x, h.normal.y, h.normal.z);
          if (dot(n, dl) > 0) n = scale(n, -1);
          // distância ao longo do raio até a esfera encostar no plano do triângulo
          const cos = Math.max(0.2, -dot(n, scale(dl, 1 / L)));
          const back = Math.max(0, h.distance - radius / cos - 0.01);
          return { pos: add(from, scale(dl, back / L)), normal: n, surface: surf(h.surface), point: v3(h.point.x, h.point.y, h.point.z) };
        }
      }
      c.set(to.x, to.y, to.z);
      const s = collision.sphereContact(c, radius);
      if (s && s.depth > 0) {
        const n = v3(s.normal.x, s.normal.y, s.normal.z);
        return { pos: add(to, scale(n, s.depth + 0.005)), normal: n, surface: surf(s.surface), point: v3(s.point.x, s.point.y, s.point.z) };
      }
      return plane ? plane.cast(from, to, radius) : null;
    },
    ground(x, z, fromY = 1e5) {
      const h = fromY >= 1e5 ? collision.groundAt(x, z) : collision.raycast(new T.Vector3(x, fromY, z), new T.Vector3(0, -1, 0));
      if (!h) return plane ? plane.ground(x, z) : null;
      let n = v3(h.normal.x, h.normal.y, h.normal.z);
      if (n.y < 0) n = scale(n, -1);
      return { y: h.point.y, normal: n, surface: surf(h.surface) };
    },
  };
}

export class BallBody {
  /**
   * @param {object} o
   * @param {object} o.params      BALLS.* (ou cópia ajustada)
   * @param {object} o.world       planeWorld/meshWorld
   * @param {number} [o.radius]    raio de colisão em unidades da cena
   */
  constructor({ params = BALLS.tennis, world = planeWorld(0), radius = 1, upm = 10, restSpeed = 0.6, maxSubstep = 1 / 240 } = {}) {
    this.params = params;
    this.world = world;
    this.radius = radius;
    this.upm = upm;
    this.restSpeed = restSpeed;
    this.maxSubstep = maxSubstep;
    this.wind = v3();
    this.pos = v3();
    this.vel = v3();
    this.spin = v3();
    this.simulating = false;
    this.rolling = false;
    this.atRest = false;
    this.bounces = 0;
    this.airTime = 0;
    this.normal = v3(0, 1, 0);
    this.surface = null;
    this.contactParams = params;
    this.visible = true;          // a bola aparece na tela (e vai no estado da sala)
    /** (point, normal, vn u/s, surface) */
    this.onBounce = null;
    this.onRest = null;
    /** (body, prevPos) -> true para pular a colisão neste subpasso (rede, buraco...) */
    this.interceptor = null;
    /** (surface) -> parâmetros de quique/rolamento */
    this.surfaceParams = null;
  }

  launch(pos, vel, spin = v3()) {
    this.pos = { ...pos }; this.vel = { ...vel }; this.spin = { ...spin };
    this.simulating = true; this.rolling = false; this.atRest = false;
    this.bounces = 0; this.airTime = 0; this.contactParams = this.params;
  }

  /** Põe a bola rolando (putt). */
  roll(pos, vel) {
    this.launch(pos, vel);
    this.rolling = true;
    this.normal = v3(0, 1, 0);
    const g = this.world.ground(pos.x, pos.z, pos.y + this.radius * 3);
    if (g) { this.normal = g.normal; this.surface = g.surface; this.contactParams = this._params(g.surface); this.pos.y = g.y + this.radius; }
  }

  hold(pos) {
    this.pos = { ...pos }; this.vel = v3(); this.spin = v3();
    this.simulating = false; this.rolling = false;
  }

  stop() { this.simulating = false; this.vel = v3(); }

  _params(surface) { return this.surfaceParams && surface ? this.surfaceParams(surface) : this.params; }

  update(dt) {
    if (!this.simulating) return;
    dt = Math.min(dt, 0.05);
    const steps = Math.max(1, Math.ceil(dt / this.maxSubstep));
    const h = dt / steps;
    for (let i = 0; i < steps && this.simulating; i++) this.substep(h);
  }

  substep(h) {
    const from = { ...this.pos };
    const s = { pos: { ...this.pos }, vel: { ...this.vel }, spin: { ...this.spin } };
    const upm = this.upm;
    if (!this.rolling) {
      this.airTime += h;
      step(s, this.wind, this.params, upm, h);
    } else {
      // rolamento: gravidade ao longo do plano + resistência ao rolamento
      const n = this.normal;
      const g = v3(0, -GRAVITY * upm, 0);
      const along = sub(g, scale(n, dot(g, n)));
      let vel = add(s.vel, scale(along, h));
      vel = sub(vel, scale(n, dot(vel, n)));
      const sp = len(vel);
      const decel = this.contactParams.rolling * GRAVITY * upm * h;
      vel = sp > decel ? scale(vel, (sp - decel) / sp) : v3();
      s.vel = vel;
      s.pos = add(s.pos, scale(vel, h));
      s.spin = scale(cross(n, vel), 1 / Math.max(0.001, this.radius));
    }
    this.pos = s.pos; this.vel = s.vel; this.spin = s.spin;
    if (this.interceptor && this.interceptor(this, from)) return;

    let contact = false;
    const hit = this.world.cast(from, this.pos, this.radius);
    if (hit) {
      contact = true;
      this.pos = hit.pos;
      this._resolve(hit.normal, hit.point, hit.surface);
    } else if (this.rolling) {
      // mantém contato no chão (descidas); saiu de uma borda: volta a voar
      const g = this.world.ground(this.pos.x, this.pos.z, this.pos.y + this.radius * 2);
      if (g && this.pos.y - this.radius - g.y < this.radius * 0.6) {
        this.pos.y = g.y + this.radius;
        this.normal = g.normal;
        if (g.surface !== this.surface) { this.surface = g.surface; this.contactParams = this._params(g.surface); }
      } else this.rolling = false;
    }
    const spd = len(this.vel);
    if (this.rolling && spd < this.restSpeed && this.normal.y > Math.cos((12 * Math.PI) / 180)) {
      this.vel = v3();
      this.simulating = false;
      this.atRest = true;
      if (this.onRest) this.onRest();
    }
    return contact;
  }

  _resolve(normal, point, surface) {
    const vn = -dot(this.vel, normal);
    this.normal = normal;
    this.surface = surface;
    this.contactParams = this._params(surface);
    if (vn <= 0) return;
    if (!this.rolling && vn > this.restSpeed * 4) {
      this.vel = bounce(this.vel, normal, this.spin, this.contactParams, this.upm);
      this.bounces++;
      if (this.onBounce) this.onBounce(point, normal, vn, surface);
      // quique muito fraco: passa a rolar
      if (dot(this.vel, normal) < GRAVITY * this.upm * 0.05 && normal.y > 0.5) this.rolling = true;
    } else {
      this.vel = sub(this.vel, scale(normal, dot(this.vel, normal)));
      if (normal.y > 0.5) this.rolling = true;
    }
  }

  get speed() { return len(this.vel); }
}

export { UP, norm };
