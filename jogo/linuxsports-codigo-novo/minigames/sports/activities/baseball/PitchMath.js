// Balística do arremesso (porte de Activities/Baseball/PitchMath.cs): cruzamento com o plano da base e mira por
// correção iterativa (6 voltas) da direção para a bola cruzar a base no alvo com o spin pedido.
import { v3, sub, dot, dist, norm, lerp, cross, rotateAxis, UP, scale } from '../common/vec3.js';
import { step } from '../common/BallFlight.js';

/** Onde (e quando) a bola cruza o plano da base (perpendicular a cf, passando por home). {point, time} */
export function plateCrossing(from, v, spin, home, cf, p, upm) {
  const s = { pos: { ...from }, vel: { ...v }, spin: { ...spin } };
  const dt = 1 / 480;
  for (let t = 0; t < 2; t += dt) {
    const prev = { ...s.pos };
    step(s, v3(), p, upm, dt);
    if (dot(sub(s.pos, home), cf) <= 0) {
      const a = dot(sub(prev, home), cf), b = dot(sub(s.pos, home), cf);
      const k = a / (a - b);
      return { point: lerp(prev, s.pos, k), time: t + dt * k };
    }
  }
  return { point: s.pos, time: 2 };
}

/** Velocidade (u/s) para cruzar a base no alvo, com o spin dado. */
export function solvePitch(release, target, speed, spin, home, cf, p, upm) {
  const side = norm(cross(UP, cf));
  const dir = norm(sub(target, release));
  const d = dist(release, target);
  let yaw = 0, pitch = 0;
  // pitch > 0 em torno de `side` levanta a bola (dir ≈ -cf); yaw > 0 em torno de up a leva para -side
  const aim = () => rotateAxis(rotateAxis(dir, side, pitch), UP, yaw);
  for (let it = 0; it < 6; it++) {
    const at = plateCrossing(release, scale(aim(), speed), spin, home, cf, p, upm).point;
    const err = sub(target, at);
    pitch += (dot(err, UP) / d) * (180 / Math.PI);
    yaw -= (dot(err, side) / d) * (180 / Math.PI);
  }
  return scale(aim(), speed);
}
