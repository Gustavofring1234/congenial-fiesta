import { makeAssetId } from '../core/ids.ts';
import { parseBrlan, type AnimKey } from '../parsers/brlan.ts';
import type { AnimMeta } from '../schemas/bundle.schema.ts';
import { type AssetOutput, type ConvertContext, displayName, jsonBytes, outputStem, r6 } from './types.ts';

export const NW4R_FPS = 60;

type Segment = NonNullable<AnimMeta['tracks'][number]['segments']>[number];

/**
 * Convert Hermite keys to cubic Bézier segments. For a segment (f0,v0,s0)->(f1,v1,s1)
 * with dt = f1 - f0, the equivalent Bézier control points are
 *   P1 = (f0 + dt/3, v0 + s0*dt/3),  P2 = (f1 - dt/3, v1 - s1*dt/3).
 * When v0 != v1 this is also expressible as a normalized CSS `cubic-bezier()` easing.
 */
export function hermiteToBezier(keys: AnimKey[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    const k0 = keys[i], k1 = keys[i + 1];
    const dt = k1.frame - k0.frame;
    if (dt <= 0) continue;
    const s0 = k0.slope ?? 0, s1 = k1.slope ?? 0;
    const p1v = k0.value + (s0 * dt) / 3;
    const p2v = k1.value - (s1 * dt) / 3;
    const dv = k1.value - k0.value;
    let easing: string | null;
    if (Math.abs(dv) > 1e-9) {
      easing = `cubic-bezier(0.333333, ${r6((p1v - k0.value) / dv)}, 0.666667, ${r6((p2v - k0.value) / dv)})`;
    } else {
      easing = s0 === 0 && s1 === 0 ? 'linear' : null;
    }
    segs.push({
      p0: [r6(k0.frame), r6(k0.value)],
      p1: [r6(k0.frame + dt / 3), r6(p1v)],
      p2: [r6(k1.frame - dt / 3), r6(p2v)],
      p3: [r6(k1.frame), r6(k1.value)],
      easing,
    });
  }
  return segs;
}

/** .brlan (and split variants .brlpa/.brlvi/.brlmc/...) -> .anim.json */
export function convertBrlan(data: Uint8Array, ctx: ConvertContext): AssetOutput {
  const lan = parseBrlan(data);
  const assetId = makeAssetId('animation', ctx.sourcePath);
  const metaPath = `${outputStem(ctx.sourcePath)}.anim.json`;

  const textures: AnimMeta['textures'] = lan.textures.map((name) => ({
    name,
    assetId: ctx.resolveTexture?.(name, ctx.sourcePath) ?? null,
  }));

  const tracks: AnimMeta['tracks'] = [];
  for (const entry of lan.entries) {
    for (const tag of entry.tags) {
      for (const t of tag.targets) {
        const keys = t.keys.map((k) => (t.curve === 'hermite'
          ? { frame: r6(k.frame), value: r6(k.value), slope: r6(k.slope ?? 0) }
          : { frame: r6(k.frame), value: k.value }));
        tracks.push({
          target: entry.name,
          targetKind: entry.kind,
          group: tag.group,
          property: t.property,
          index: t.index,
          interpolation: t.curve,
          keys,
          ...(t.curve === 'hermite' ? { segments: hermiteToBezier(keys) } : {}),
        });
      }
    }
  }

  const meta: AnimMeta = {
    format: 'nw4r-web/anim',
    version: 1,
    assetId,
    name: displayName(ctx.sourcePath),
    source: ctx.sourcePath,
    fps: NW4R_FPS,
    frameCount: lan.frameCount,
    loop: lan.loop,
    textures,
    tracks,
  };

  const refs = [...new Set(textures.map((t) => t.assetId).filter((x): x is string => !!x))];
  const unresolvedRefs = textures.filter((t) => !t.assetId).map((t) => t.name);
  return {
    asset: {
      assetId,
      kind: 'animation',
      name: meta.name,
      sourcePath: ctx.sourcePath,
      sourceFormat: 'brlan',
      primary: metaPath,
      files: { meta: metaPath },
      refs,
      unresolvedRefs,
      summary: { frameCount: lan.frameCount, loop: lan.loop, trackCount: tracks.length, targets: [...new Set(lan.entries.map((e) => e.name))].length },
    },
    files: new Map([[metaPath, jsonBytes(meta)]]),
    warnings: unresolvedRefs.map((n) => `texture "${n}" referenced by animation was not found in the bundle`),
  };
}
