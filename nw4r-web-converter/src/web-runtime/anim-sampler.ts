import type { AnimMeta } from '../schemas/bundle.schema.ts';

type Track = AnimMeta['tracks'][number];
type Key = Track['keys'][number];

/**
 * Evaluate a track at `frame`, matching NW4R semantics:
 *  - before the first / after the last key the edge value is held;
 *  - step tracks hold the last key whose frame <= `frame`;
 *  - hermite tracks use the cubic Hermite basis with per-key slopes (value/frame).
 */
export function sampleTrack(track: Pick<Track, 'interpolation' | 'keys'>, frame: number): number {
  const keys = track.keys;
  if (keys.length === 0) return 0;
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;

  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].frame <= frame) lo = mid; else hi = mid;
  }
  const k0: Key = keys[lo], k1: Key = keys[hi];
  if (track.interpolation === 'step') return k0.value;
  const dt = k1.frame - k0.frame;
  if (dt <= 0) return k1.value;
  const t = (frame - k0.frame) / dt;
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * k0.value + h10 * dt * (k0.slope ?? 0) + h01 * k1.value + h11 * dt * (k1.slope ?? 0);
}

export interface SampledPose {
  /** target name -> property -> value (index > 0 is suffixed as `property[index]`). */
  [target: string]: Record<string, number>;
}

/** Sample every track of an animation at one frame. Ideal for Canvas/WebGL render loops. */
export function sampleAnimation(anim: Pick<AnimMeta, 'tracks' | 'frameCount' | 'loop'>, frame: number): SampledPose {
  const f = anim.loop && anim.frameCount > 0 ? ((frame % anim.frameCount) + anim.frameCount) % anim.frameCount : frame;
  const pose: SampledPose = {};
  for (const tr of anim.tracks) {
    const key = tr.index ? `${tr.property}[${tr.index}]` : tr.property;
    (pose[tr.target] ??= {})[key] = sampleTrack(tr, f);
  }
  return pose;
}

/**
 * Bake one track into Web Animations API keyframes ({ offset, value, easing }).
 * Hermite segments carry their exact `cubic-bezier()` easing when expressible;
 * otherwise the segment is densely sampled so the result stays faithful.
 */
export function toWaapiKeyframes(
  track: Track,
  frameCount: number,
  samplesPerSegment = 8,
): Array<{ offset: number; value: number; easing: string }> {
  const total = Math.max(1, frameCount);
  const clamp = (f: number) => Math.min(1, Math.max(0, f / total));
  const out: Array<{ offset: number; value: number; easing: string }> = [];
  const keys = track.keys;
  if (!keys.length) return out;
  if (track.interpolation === 'step') {
    for (const k of keys) out.push({ offset: clamp(k.frame), value: k.value, easing: 'steps(1, end)' });
    return dedupeOffsets(out);
  }
  const segs = track.segments ?? [];
  segs.forEach((s, i) => {
    if (s.easing) {
      out.push({ offset: clamp(s.p0[0]), value: s.p0[1], easing: s.easing });
    } else {
      for (let j = 0; j < samplesPerSegment; j++) {
        const f = s.p0[0] + ((s.p3[0] - s.p0[0]) * j) / samplesPerSegment;
        out.push({ offset: clamp(f), value: sampleTrack(track, f), easing: 'linear' });
      }
    }
    if (i === segs.length - 1) out.push({ offset: clamp(s.p3[0]), value: s.p3[1], easing: 'linear' });
  });
  if (!out.length) out.push({ offset: clamp(keys[0].frame), value: keys[0].value, easing: 'linear' });
  return dedupeOffsets(out);
}

function dedupeOffsets<T extends { offset: number }>(list: T[]): T[] {
  const res: T[] = [];
  for (const k of list) {
    if (res.length && res[res.length - 1].offset === k.offset) res[res.length - 1] = k;
    else if (!res.length || k.offset > res[res.length - 1].offset) res.push(k);
  }
  return res;
}
