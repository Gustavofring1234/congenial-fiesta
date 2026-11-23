// Voo de bola em unidades da cena (10 u = 1 m): gravidade, arrasto quadrático e efeito Magnus S·(ω × v).
// Porte de Activities/Common/BallFlight.cs. Integração semi-implícita de Euler em passos fixos (determinística).
// Produtos vetoriais são fórmulas de coordenadas: o mesmo spin dá a mesma curva no referencial do Wii/three.js
// (backspinAxis(dir) gera sustentação para cima em qualquer direção de voo).
import { v3, add, sub, scale, cross, dot, len, norm, lerp, clamp01, invLerp } from './vec3.js';

export const AIR_DENSITY = 1.2;
export const GRAVITY = 9.81;

/** Parâmetros físicos por bola (raio/massa reais; quique e rolamento calibrados no Unity, tests/csharp). */
export const BALLS = Object.freeze({
  golf: { radiusM: 0.02135, massKg: 0.04593, dragCd: 0.25, magnus: 0.000025, spinDecay: 0.25, restitution: 0.38, friction: 0.35, rolling: 0.11 },
  tennis: { radiusM: 0.0335, massKg: 0.058, dragCd: 0.55, magnus: 0.000045, spinDecay: 0.15, restitution: 0.75, friction: 0.25, rolling: 0.25 },
  baseball: { radiusM: 0.0366, massKg: 0.145, dragCd: 0.33, magnus: 0.00008, spinDecay: 0.1, restitution: 0.45, friction: 0.4, rolling: 0.3 },
  bowling: { radiusM: 0.109, massKg: 6.8, dragCd: 0.47, magnus: 0, spinDecay: 0.02, restitution: 0.1, friction: 0.04, rolling: 0.012 },
});

export const ballArea = (p) => Math.PI * p.radiusM * p.radiusM;

/** Aceleração (u/s²). vel e wind em u/s, spin em rad/s. */
export function acceleration(vel, spin, wind, p, upm = 10) {
  const vRel = scale(sub(vel, wind), 1 / upm); // m/s
  const speed = len(vRel);
  let ax = 0, ay = -GRAVITY, az = 0;
  if (speed > 1e-5) {
    const k = (-0.5 * AIR_DENSITY * p.dragCd * ballArea(p) * speed) / p.massKg;
    ax += k * vRel.x; ay += k * vRel.y; az += k * vRel.z;
  }
  if (p.magnus > 0) {
    const l = cross(spin, vRel);
    ax += (p.magnus * l.x) / p.massKg; ay += (p.magnus * l.y) / p.massKg; az += (p.magnus * l.z) / p.massKg;
  }
  return v3(ax * upm, ay * upm, az * upm);
}

/** Um passo: altera s.pos, s.vel, s.spin no lugar. */
export function step(s, wind, p, upm, dt) {
  const a = acceleration(s.vel, s.spin, wind, p, upm);
  s.vel.x += a.x * dt; s.vel.y += a.y * dt; s.vel.z += a.z * dt;
  s.pos.x += s.vel.x * dt; s.pos.y += s.vel.y * dt; s.pos.z += s.vel.z * dt;
  const k = Math.max(0, 1 - p.spinDecay * dt);
  s.spin.x *= k; s.spin.y *= k; s.spin.z *= k;
}

const state = (pos, vel, spin) => ({ pos: { ...pos }, vel: { ...vel }, spin: { ...spin } });

/** Simula sem colisão até descer abaixo de groundY. {point, time}. */
export function predictLanding(pos, vel, spin, wind, p, upm, groundY, maxTime = 15, dt = 1 / 120) {
  const s = state(pos, vel, spin);
  let time = 0;
  while (time < maxTime) {
    const prev = { ...s.pos };
    step(s, wind, p, upm, dt);
    time += dt;
    if (s.pos.y <= groundY && s.vel.y < 0) return { point: lerp(prev, s.pos, invLerp(prev.y, s.pos.y, groundY)), time };
  }
  return { point: s.pos, time };
}

/** Onde a bola cruza o plano z = planeZ ({point, time}) ou null. */
export function crossPlaneZ(pos, vel, spin, wind, p, upm, planeZ, maxTime = 5, dt = 1 / 240) {
  const s = state(pos, vel, spin);
  const side = Math.sign(s.pos.z - planeZ);
  let time = 0;
  while (time < maxTime) {
    const prev = { ...s.pos };
    step(s, wind, p, upm, dt);
    time += dt;
    if (Math.sign(s.pos.z - planeZ) !== side) return { point: lerp(prev, s.pos, invLerp(prev.z, s.pos.z, planeZ)), time };
  }
  return null;
}

/** Eixo do backspin para a direção de voo (ω × v aponta para cima). Topspin = eixo oposto. */
export function backspinAxis(dir) {
  let h = v3(dir.x, 0, dir.z);
  if (h.x * h.x + h.z * h.z < 1e-8) h = v3(0, 0, -1);
  return norm(cross(norm(h), v3(0, 1, 0)));
}

/** Rapidez de lançamento (u/s) para cair a `distance` (u) no plano, com o ângulo dado (busca binária). */
export function solveSpeed(distance, launchDeg, backspin, p, upm, heightDelta = 0, maxSpeedMS = 90) {
  let lo = 0.5, hi = maxSpeedMS;
  const r = (launchDeg * Math.PI) / 180;
  const dir = v3(0, 0, -1);
  const spin = scale(backspinAxis(dir), backspin);
  for (let it = 0; it < 28; it++) {
    const mid = 0.5 * (lo + hi);
    const v = v3(0, Math.sin(r) * mid * upm, -Math.cos(r) * mid * upm);
    const land = predictLanding(v3(), v, spin, v3(), p, upm, heightDelta).point;
    if (-land.z < distance) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi) * upm;
}

/**
 * Quique numa superfície de normal n: componente normal invertida com restituição, tangencial reduzida pelo atrito;
 * parte do spin vira velocidade tangencial. Altera `spin` no lugar; devolve a nova velocidade.
 */
export function bounce(vel, normal, spin, p, upm) {
  const vn = dot(vel, normal);
  if (vn >= 0) return { ...vel };
  const vN = scale(normal, vn);
  const vT = sub(vel, vN);
  const contact = cross(spin, scale(normal, -p.radiusM * upm));
  const slip = add(vT, contact);
  const f = clamp01(p.friction);
  const newT = sub(vT, scale(slip, f));
  spin.x *= 1 - f; spin.y *= 1 - f; spin.z *= 1 - f;
  return sub(newT, scale(vN, p.restitution));
}
