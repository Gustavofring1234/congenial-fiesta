// Física da pista de boliche (no lugar dos Rigidbody/PhysX do Unity): bola e pinos como discos no plano da pista,
// colisões elásticas com restituição, pinos que tombam ao receber um impulso acima do limiar e, já caídos, deslizam e
// derrubam outros (o "pin action"), batendo nas laterais (kickbacks). O gancho só pega no último terço seco, como no
// padrão de óleo real (BowlingBallSpin.cs). Passos fixos de 1/240 s: o mesmo arremesso dá o mesmo resultado.
// Referencial do Wii/three.js: linha de falta em z = 0, pista para -Z, a direita de quem joga é +X.
import { pinColumn, pinRow } from './BowlingScore.js';
import { GRAVITY } from '../common/BallFlight.js';

export const BOWLING_DEFAULTS = {
  headPinZ: -182.821, laneHalfWidth: 10.54, pinSpacing: 3.048, pinHeight: 3.822, pinRadius: 0.637, ballRadius: 1.09,
  laneEndZ: -260, gutterWidth: 2.35,
};

const BALL_MASS = 6.8, PIN_MASS = 1.55;
const TOPPLE_SPEED = 9;        // u/s (0,9 m/s) de impulso para o pino tombar
const DRY_Z = -115;            // início do trecho seco (último terço)

export class BowlingLane {
  constructor(geometry = {}, upm = 10) {
    const g = { ...BOWLING_DEFAULTS, ...geometry };
    this.g = g;
    this.upm = upm;
    this.headPinZ = g.headPinZ;
    this.laneHalf = g.laneHalfWidth;
    this.wallX = g.laneHalfWidth + g.gutterWidth + 0.4;
    this.pitZ = g.headPinZ - 12;
    this.rowStep = g.pinSpacing * 0.8660254;
    this.pins = [];
    for (let i = 0; i < 10; i++) {
      const home = { x: pinColumn(i) * g.pinSpacing * 0.5, z: g.headPinZ - pinRow(i) * this.rowStep };
      this.pins.push({ index: i, home, x: home.x, z: home.z, vx: 0, vz: 0, active: true, fallen: false, tilt: 0, tiltX: 0, tiltZ: 1, out: false });
    }
    this.ball = { x: 0, y: g.ballRadius, z: 4, vx: 0, vz: 0, spin: 0, rolling: false, gutter: false, done: true, roll: 0 };
    this.hits = [];          // impactos do último passo ({kind, speed, x, z}) para som/efeito
    this.time = 0;
  }

  /** Arma os pinos da máscara (os demais somem, como o varredor do jogo). */
  resetPins(mask) {
    for (const p of this.pins) {
      p.active = ((mask >> p.index) & 1) !== 0;
      p.x = p.home.x; p.z = p.home.z; p.vx = 0; p.vz = 0;
      p.fallen = false; p.tilt = 0; p.out = false;
    }
  }

  /**
   * Solta a bola em (x, z) com ângulo (graus, + = para a direita), rapidez em m/s e efeito -1..1 (+ = curva para a
   * direita).
   */
  release(x, angleDeg, speedMS, spin, z = 4) {
    const a = (angleDeg * Math.PI) / 180, v = speedMS * this.upm;
    Object.assign(this.ball, { x, y: this.g.ballRadius, z, vx: Math.sin(a) * v, vz: -Math.cos(a) * v, spin, rolling: true, gutter: false, done: false, roll: 0 });
    this.time = 0;
  }

  /** Pinos em pé. */
  standingMask() {
    let m = 0;
    for (const p of this.pins) if (p.active && !p.fallen) m |= 1 << p.index;
    return m;
  }

  /** Algo ainda se mexe? */
  get moving() {
    if (!this.ball.done) return true;
    for (const p of this.pins) if (p.active && (Math.hypot(p.vx, p.vz) > 2 || (p.fallen && p.tilt < 1))) return true;
    return false;
  }

  update(dt) {
    this.hits.length = 0;
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this._step(h);
  }

  _step(h) {
    const g = this.g, b = this.ball, R = g.ballRadius, r = g.pinRadius;
    this.time += h;
    if (!b.done) {
      const forward = -b.vz;
      if (!b.gutter) {
        // gancho: derrapa no óleo, morde no seco, mais forte quanto mais lenta
        if (forward > 0.5 && Math.abs(b.x) < this.laneHalf - R * 0.3) {
          const grip = b.z < DRY_Z ? 1 : Math.min(1, Math.max(0, b.z / DRY_Z)) * 0.15;
          b.vx += b.spin * grip * 34 * Math.min(1.6, Math.max(0.6, 80 / forward)) * h;
        }
        if (Math.abs(b.x) > this.laneHalf && b.z > this.headPinZ + 2) {
          // caiu na canaleta: corre pelo canal até o fosso, sem tocar nos pinos
          b.gutter = true;
          b.x = Math.sign(b.x) * (this.laneHalf + g.gutterWidth * 0.5);
          b.vx = 0;
          b.y = R - 0.6;
          this.hits.push({ kind: 'gutter', speed: forward, x: b.x, z: b.z });
        }
      }
      // resistência ao rolamento (0,012 g) e ar
      const sp = Math.hypot(b.vx, b.vz);
      const dec = 0.012 * GRAVITY * this.upm * h;
      if (sp > dec) { b.vx *= (sp - dec) / sp; b.vz *= (sp - dec) / sp; } else { b.vx = 0; b.vz = 0; }
      b.x += b.vx * h; b.z += b.vz * h;
      b.roll += (sp * h) / R;
      if (!b.gutter && Math.abs(b.x) > this.wallX - R) { b.x = Math.sign(b.x) * (this.wallX - R); b.vx *= -0.3; }
      if (b.z < this.pitZ - 6 || sp < 1) { b.done = true; b.rolling = false; }
    }
    for (const p of this.pins) {
      if (!p.active) continue;
      // bola contra pino
      if (!b.done && !b.gutter) this._collide(b, BALL_MASS, R, p, PIN_MASS, p.fallen ? r * 1.6 : r, 0.55, 'ball');
      if (p.fallen && p.tilt < 1) p.tilt = Math.min(1, p.tilt + h / 0.3);
    }
    for (let i = 0; i < 10; i++) {
      const a = this.pins[i];
      if (!a.active) continue;
      for (let j = i + 1; j < 10; j++) {
        const c = this.pins[j];
        if (!c.active) continue;
        this._collide(a, PIN_MASS, a.fallen ? r * 1.6 : r, c, PIN_MASS, c.fallen ? r * 1.6 : r, 0.5, 'pin');
      }
    }
    for (const p of this.pins) {
      if (!p.active) continue;
      const sp = Math.hypot(p.vx, p.vz);
      if (sp > 0) {
        // atrito no piso: pino em pé escorrega pouco; caído rola/desliza
        const dec = (p.fallen ? 0.25 : 0.6) * GRAVITY * this.upm * h;
        if (sp > dec) { p.vx *= (sp - dec) / sp; p.vz *= (sp - dec) / sp; } else { p.vx = 0; p.vz = 0; }
        p.x += p.vx * h; p.z += p.vz * h;
      }
      // laterais devolvem os pinos (kickback); fosso e canaletas tiram o pino do jogo
      if (Math.abs(p.x) > this.wallX - r) { p.x = Math.sign(p.x) * (this.wallX - r); p.vx *= -0.45; this.hits.push({ kind: 'wall', speed: Math.abs(p.vx), x: p.x, z: p.z }); }
      if (!p.fallen && (Math.abs(p.x) > this.laneHalf + 0.5 || p.z < this.pitZ + 2 || p.z > this.headPinZ + 4)) this._topple(p, p.vx, p.vz);
      if (p.z < this.pitZ - 8) { p.vx = 0; p.vz = 0; p.out = true; }
    }
  }

  _topple(p, dx, dz) {
    if (p.fallen) return;
    p.fallen = true;
    const l = Math.hypot(dx, dz) || 1;
    p.tiltX = dx / l; p.tiltZ = dz / l;
  }

  _collide(a, ma, ra, c, mc, rc, e, kind) {
    const dx = c.x - a.x, dz = c.z - a.z;
    const d = Math.hypot(dx, dz), min = ra + rc;
    if (d >= min || d < 1e-6) return;
    const nx = dx / d, nz = dz / d;
    // separa
    const push = (min - d) / (ma + mc);
    a.x -= nx * push * mc; a.z -= nz * push * mc;
    c.x += nx * push * ma; c.z += nz * push * ma;
    const rv = (c.vx - a.vx) * nx + (c.vz - a.vz) * nz;
    if (rv >= 0) return;
    const j = (-(1 + e) * rv) / (1 / ma + 1 / mc);
    a.vx -= (j / ma) * nx; a.vz -= (j / ma) * nz;
    c.vx += (j / mc) * nx; c.vz += (j / mc) * nz;
    const dvc = j / mc, dva = j / ma;
    this.hits.push({ kind, speed: -rv, x: c.x, z: c.z });
    if (dvc > TOPPLE_SPEED && c.index !== undefined) this._topple(c, c.vx, c.vz);
    if (a.index !== undefined && dva > TOPPLE_SPEED) this._topple(a, a.vx, a.vz);
  }

  /** Estado compacto (sala): bola + pinos [x, z, tombado, inclinação]. */
  pack() {
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      b: [r1(this.ball.x), r1(this.ball.y), r1(this.ball.z), this.ball.done ? 1 : 0, Math.round(this.ball.roll * 100) / 100],
      p: this.pins.map((p) => (p.active ? [r1(p.x), r1(p.z), p.fallen ? Math.round(p.tilt * 100) / 100 : 0, Math.round(p.tiltX * 100) / 100, Math.round(p.tiltZ * 100) / 100] : 0)),
    };
  }
}
