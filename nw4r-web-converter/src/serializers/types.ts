import type { ManifestAsset } from '../schemas/bundle.schema.ts';
import { basename, extname, stripExt } from '../core/ids.ts';

export interface TextureLookup {
  /** Resolve a texture name used by an animation (e.g. "ist_Window8_00.tpl") to an assetId. */
  (name: string, fromSourcePath: string): string | null;
}

export interface ConvertContext {
  /** Bundle-relative POSIX source path, e.g. "results.arc/timg/a.tpl". */
  sourcePath: string;
  resolveTexture?: TextureLookup;
}

export interface AssetOutput {
  asset: ManifestAsset;
  files: Map<string, Uint8Array>;
  warnings: string[];
}

const CANONICAL_EXT = new Set(['.tpl', '.brfnt', '.brlan', '.kcl']);

/**
 * Output path stem for a source file. Canonical extensions are dropped
 * ("timg/a.tpl" -> "timg/a"); others are kept so that split animations such as
 * "a.brlpa" / "a.brlvi" never collide ("anim/a.brlpa").
 */
export function outputStem(sourcePath: string): string {
  return CANONICAL_EXT.has(extname(sourcePath)) ? stripExt(sourcePath) : sourcePath;
}

export function displayName(sourcePath: string): string {
  return basename(sourcePath);
}

export const jsonBytes = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/** Round to 6 decimals so JSON output is compact and stable across runtimes. */
export const r6 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0);
