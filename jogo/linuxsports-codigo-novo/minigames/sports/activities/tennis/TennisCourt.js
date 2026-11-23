// Quadra e balística do tênis (porte de Activities/Tennis/TennisCourt.cs), medidas ITF em unidades da cena (a rede
// tns_net_a mede ~12,8 m e confere 10 u/m). Rede em z = 0; time 0 no lado +Z olhando para -Z (a direita dele é +X,
// referencial do Wii/three.js sem espelho). Saque cruzado: do lado direito (deuce) para a caixa à direita do recebedor.
import { v3, sub, add, scale, flat, flatLen, norm, dot, clamp01, mix } from '../common/vec3.js';
import { predictLanding, crossPlaneZ, backspinAxis } from '../common/BallFlight.js';

export const side = (team) => (team === 0 ? 1 : -1);

export class TennisCourt {
  constructor(geometry = {}, { doubles = false, upm = 10 } = {}) {
    this.halfLength = geometry.halfLength ?? 118.85;
    this.singlesHalfWidth = geometry.singlesHalfWidth ?? 41.15;
    this.doublesHalfWidth = geometry.doublesHalfWidth ?? 54.85;
    this.serviceLine = geometry.serviceLine ?? 64;
    this.netCenter = geometry.netHeightCenter ?? 9.14;
    this.netPost = geometry.netHeightPost ?? 10.7;
    this.netHalfWidth = geometry.netHalfWidth ?? 64;
    this.doubles = doubles;
    this.upm = upm;
  }

  get halfWidth() { return this.doubles ? this.doublesHalfWidth : this.singlesHalfWidth; }

  netHeight(x) { return mix(this.netCenter, this.netPost, clamp01(Math.abs(x) / this.netHalfWidth)); }

  inCourt(p, targetTeam, margin = 0.5) {
    const s = side(targetTeam);
    return p.z * s >= -margin && p.z * s <= this.halfLength + margin && Math.abs(p.x) <= this.halfWidth + margin;
  }

  /** Sinal de X da caixa de saque que recebe (deuce = cruzado a partir da direita do sacador). */
  _boxSign(receiverTeam, serveSide) {
    const serverSide = side(1 - receiverTeam);
    return -(serveSide === 0 ? 1 : -1) * serverSide;
  }

  inServiceBox(p, receiverTeam, serveSide, margin = 0.5) {
    const s = side(receiverTeam);
    if (p.z * s < -margin || p.z * s > this.serviceLine + margin) return false;
    const k = this._boxSign(receiverTeam, serveSide);
    return p.x * k >= -margin && p.x * k <= this.singlesHalfWidth + margin;
  }

  serviceBoxCenter(receiverTeam, serveSide) {
    return v3(this._boxSign(receiverTeam, serveSide) * this.singlesHalfWidth * 0.5, 0, side(receiverTeam) * this.serviceLine * 0.6);
  }

  /** Lugar do sacador: deuce = metade direita dele. */
  servePosition(team, serveSide) {
    const s = side(team);
    return v3((serveSide === 0 ? 1 : -1) * s * 12, 0, s * (this.halfLength + 4));
  }

  /** Velocidade para ir de `from` e cair em `target` com a rapidez dada (u/s), passando a rede (busca no ângulo). */
  solveShot(from, target, speed, topspin, p, radius) {
    const fl = flat(sub(target, from));
    const dir = norm(fl), want = flatLen(fl);
    const spin = scale(backspinAxis(dir), -topspin);
    for (let attempt = 0; attempt < 6; attempt++) {
      let lo = -15, hi = 50, best = v3(), ok = false;
      for (let it = 0; it < 22; it++) {
        const mid = 0.5 * (lo + hi);
        const v = velocity(dir, mid, speed);
        const land = predictLanding(from, v, spin, v3(), p, this.upm, radius, 6, 1 / 120).point;
        const got = dot(sub(land, from), dir);
        if (got < want) lo = mid; else hi = mid;
        best = v;
        ok = Math.abs(got - want) < 3;
      }
      if (ok && this.clearsNet(from, best, spin, p, radius)) return best;
      speed *= ok ? 0.9 : 1.15;     // bate na rede: menos força e mais ângulo; não alcança: mais força
    }
    return velocity(dir, 12, speed);
  }

  clearsNet(from, v, spin, p, radius) {
    if (Math.sign(from.z) === 0) return true;
    const c = crossPlaneZ(from, v, spin, v3(), p, this.upm, 0, 4);
    if (!c) return true;
    return c.point.y - radius > this.netHeight(c.point.x);
  }
}

function velocity(dir, elevDeg, speed) {
  const r = (elevDeg * Math.PI) / 180;
  return scale(add(scale(dir, Math.cos(r)), v3(0, Math.sin(r), 0)), speed);
}
