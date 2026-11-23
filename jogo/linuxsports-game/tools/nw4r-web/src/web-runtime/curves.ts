/** Avaliação das curvas NW4R (Hermite e degrau) e conversão para Bézier / Web Animations. */
import type { AnimJson } from '../schemas/bundle.schema.ts';

type Track = AnimJson['targets'][number]['tracks'][number];
type Key = Track['keys'][number];

/** Valor da trilha no quadro `frame` (mesma regra do NW4R: fora do intervalo, mantém a ponta). */
export function evaluateTrack(track: Track, frame: number): number {
  const k = track.keys;
  if (k.length === 1 || frame <= k[0].frame) return k[0].value;
  const last = k[k.length - 1];
  if (frame >= last.frame) return last.value;
  let i = 0;
  while (i < k.length - 2 && frame >= k[i + 1].frame) i++;
  const a = k[i], b = k[i + 1];
  if (track.interpolation === 'step') return a.value;
  return hermite(a, b, frame);
}

export function hermite(a: Key, b: Key, frame: number): number {
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  const t = (frame - a.frame) / span;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * a.slope * span
    + (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * b.slope * span;
}

/** Segmento Hermite como Bézier cúbica no plano (quadro, valor) — útil para GSAP/CSS customizado. */
export function hermiteToBezier(a: Key, b: Key): [[number, number], [number, number], [number, number], [number, number]] {
  const span = b.frame - a.frame;
  return [
    [a.frame, a.value],
    [a.frame + span / 3, a.value + (a.slope * span) / 3],
    [b.frame - span / 3, b.value - (b.slope * span) / 3],
    [b.frame, b.value],
  ];
}

/** Amostra a trilha em quadros inteiros: [{offset 0..1, value}] para Web Animations API. */
export function sampleTrack(track: Track, frameSize: number, step = 1): { offset: number; value: number }[] {
  const n = Math.max(1, frameSize);
  const out: { offset: number; value: number }[] = [];
  for (let f = 0; f <= n; f += step) out.push({ offset: f / n, value: evaluateTrack(track, f) });
  if (out[out.length - 1].offset !== 1) out.push({ offset: 1, value: evaluateTrack(track, n) });
  return out;
}


/** Keyframes CSS (Element.animate) para as trilhas de um pane, combinando posição/escala/rotação/alfa. */
export function paneKeyframes(anim: AnimJson, paneName: string, fps = 60): { keyframes: Keyframe[]; options: KeyframeAnimationOptions } | null {
  const target = anim.targets.find((t) => t.name === paneName && t.kind === 'pane');
  if (!target) return null;
  const get = (p: string) => target.tracks.find((t) => t.property === p);
  const n = Math.max(1, anim.frameSize);
  const keyframes: Keyframe[] = [];
  for (let f = 0; f <= n; f++) {
    const v = (p: string, d: number) => { const t = get(p); return t ? evaluateTrack(t, f) : d; };
    const kf: Keyframe = {
      offset: f / n,
      // NW4R: Y para cima e rotação anti-horária; CSS: Y para baixo e rotação horária
      transform: `translate(${v('translateX', 0)}px, ${-v('translateY', 0)}px) rotate(${-v('rotateZ', 0)}deg) scale(${v('scaleX', 1)}, ${v('scaleY', 1)})`,
    };
    const alpha = get('alpha');
    if (alpha) kf.opacity = evaluateTrack(alpha, f) / 255;
    keyframes.push(kf);
  }

  return { keyframes, options: { duration: (n / fps) * 1000, iterations: anim.loop ? Infinity : 1, fill: 'forwards' } };
}
