// Vetores 3D mínimos ({x, y, z} simples) para a física e as regras das modalidades. Sem three.js de propósito: a
// simulação roda igual no navegador, no Node (testes) e no anfitrião da sala, e é barata de copiar e serializar.
// Referencial do Wii = glTF = three.js: destro, Y para cima, 10 unidades = 1 metro. Quem olha para a direção f tem a
// direita em cross(f, up) (olhando para -Z, a direita é +X).

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const copy = (a) => ({ x: a.x, y: a.y, z: a.z });
export const set = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const addScaled = (a, b, s) => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const flat = (a) => ({ x: a.x, y: 0, z: a.z });
export const flatLen = (a) => Math.hypot(a.x, a.z);
export const flatDist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
export function norm(a) {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}
export const UP = Object.freeze({ x: 0, y: 1, z: 0 });
export const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });

/** Direita de quem olha para f (no plano): cross(f, up). */
export const rightOf = (f) => norm(cross(flat(f), UP));

/** Gira v em torno do eixo (unitário) pelo ângulo em graus (Rodrigues; regra da mão direita). */
export function rotateAxis(v, axis, deg) {
  const k = norm(axis), a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return { x: v.x * c + kv.x * s + k.x * kd, y: v.y * c + kv.y * s + k.y * kd, z: v.z * c + kv.z * s + k.z * kd };
}

/** Gira no plano horizontal: graus positivos viram para a DIREITA de quem olha na direção v. */
export const turnRight = (v, deg) => rotateAxis(v, UP, -deg);

/** Direção horizontal pelo ângulo em graus entre dois eixos (a em 0°, b em 90°). */
export function between(a, b, deg) {
  const r = (deg * Math.PI) / 180;
  return norm({ x: a.x * Math.cos(r) + b.x * Math.sin(r), y: 0, z: a.z * Math.cos(r) + b.z * Math.sin(r) });
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const mix = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (a === b ? 0 : clamp01((v - a) / (b - a)));
/** Arredonda para n casas (estado compacto da sala). */
export const round = (v, n = 2) => { const k = 10 ** n; return Math.round(v * k) / k; };
export const pack = (a, n = 2) => [round(a.x, n), round(a.y, n), round(a.z, n)];
export const unpack = (p) => (Array.isArray(p) ? { x: +p[0] || 0, y: +p[1] || 0, z: +p[2] || 0 } : v3());
