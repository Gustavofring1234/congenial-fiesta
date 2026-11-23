// Curvas das animações NW4R G3D convertidas por tools/nw4r/anim.py (Animations/**.json):
//   {type:'const', value}
//   {type:'hermite', keys:[[quadro, valor, tangente], ...]}  tangente em unidades por quadro (Hermite cúbica)
//   {type:'linear', values:[v0, v1, ...]}                     um valor por quadro, interpolação linear
// Quadros a 60 Hz. Amostragem idêntica à do player C# (Nw4rAnimationData.cs) e à do Python (anim.py).

export function sampleCurve(c, frame) {
  if (!c) return undefined;
  if (c.type === 'const') return c.value;
  if (c.type === 'linear') {
    const v = c.values;
    if (!v.length) return 0;
    if (frame <= 0) return v[0];
    if (frame >= v.length - 1) return v[v.length - 1];
    const i = Math.floor(frame), f = frame - i;
    return v[i] + (v[i + 1] - v[i]) * f;
  }
  const k = c.keys;
  const n = k.length;
  if (!n) return 0;
  if (frame <= k[0][0]) return k[0][1];
  if (frame >= k[n - 1][0]) return k[n - 1][1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (k[mid][0] <= frame) lo = mid; else hi = mid; }
  const [f0, v0, t0] = k[lo], [f1, v1, t1] = k[hi];
  const dt = f1 - f0;
  if (dt <= 0) return v1;
  const s = (frame - f0) / dt, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * dt * t0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * dt * t1;
}

export const isConst = (c) => !c || c.type === 'const';

/** Quadros inteiros 0..frames (inclusive) usados para virar keyframes do three.js. */
export function frameTimes(frames, fps = 60) {
  const n = Math.max(1, Math.round(frames));
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = i / fps;
  return t;
}

/** Cor RGBA (0-255) de um alvo CLR0 no quadro (sem interpolação: um valor por quadro, como no GX). */
export function sampleClr(target, frame) {
  if (target.const) return target.const;
  const f = target.frames;
  if (!f || !f.length) return [255, 255, 255, 255];
  const i = Math.max(0, Math.min(f.length - 1, Math.floor(frame)));
  const j = Math.min(f.length - 1, i + 1), a = frame - Math.floor(frame);
  return f[i].map((v, k) => v + (f[j][k] - v) * (j === i ? 0 : a));
}

/** Visibilidade VIS0 de um osso no quadro. */
export function sampleVis(bone, frame) {
  if (!bone.frames) return !!bone.const;
  const i = Math.max(0, Math.min(bone.frames.length - 1, Math.floor(frame)));
  return !!bone.frames[i];
}
