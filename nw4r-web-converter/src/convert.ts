import { zipSync, type Zippable } from 'fflate';
import { toBytes } from './core/binary.ts';
import { basename, dirname, extname, joinPath, makeAssetId, normalizePath } from './core/ids.ts';
import { isBrfnt } from './parsers/brfnt.ts';
import { isBrlan } from './parsers/brlan.ts';
import { looksLikeKcl } from './parsers/kcl.ts';
import { isTpl } from './parsers/tpl.ts';
import { isU8, parseU8 } from './parsers/u8.ts';
import { decompressYaz0, isYaz0 } from './parsers/yaz0.ts';
import { BUNDLE_FORMAT, type Manifest, type ManifestAsset, SCHEMA_VERSION } from './schemas/bundle.schema.ts';
import { convertBrlan } from './serializers/anim.ts';
import { convertKcl } from './serializers/collision.ts';
import { convertBrfnt } from './serializers/font.ts';
import { convertTpl } from './serializers/texture.ts';
import { type AssetOutput, type ConvertContext, jsonBytes } from './serializers/types.ts';

export const GENERATOR = { name: 'nw4r-web-converter', version: '0.1.0' };

export type DetectedFormat = 'yaz0' | 'u8' | 'tpl' | 'brfnt' | 'brlan' | 'kcl' | 'raw';

/** Detect by magic first; KCL (no magic) needs the extension plus a header sanity check. */
export function detectFormat(name: string, data: Uint8Array): DetectedFormat {
  if (isYaz0(data)) return 'yaz0';
  if (isU8(data)) return 'u8';
  if (isTpl(data)) return 'tpl';
  if (isBrfnt(data)) return 'brfnt';
  if (isBrlan(data)) return 'brlan';
  if (extname(name) === '.kcl' && looksLikeKcl(data)) return 'kcl';
  return 'raw';
}

export interface InputFile {
  path: string;
  data: Uint8Array;
}

export interface Bundle {
  manifest: Manifest;
  /** Every output file keyed by bundle-relative POSIX path (manifest.json included). */
  files: Map<string, Uint8Array>;
}

export interface ConvertOptions {
  /** Expand nested U8/Yaz0 archives found inside the input (default true). */
  expandNested?: boolean;
  /** Called for every converted asset (progress reporting). */
  onAsset?: (asset: ManifestAsset) => void;
}

/** Recursively flatten Yaz0/U8 layers into a list of plain files. */
export function flattenArchive(files: InputFile[], opts: ConvertOptions = {}, depth = 0): InputFile[] {
  const out: InputFile[] = [];
  for (const f of files) {
    let data = f.data;
    let fmt = detectFormat(f.path, data);
    if (fmt === 'yaz0' && opts.expandNested !== false && depth < 8) {
      data = decompressYaz0(data);
      fmt = detectFormat(f.path, data);
    }
    if (fmt === 'u8' && opts.expandNested !== false && depth < 8) {
      const arc = parseU8(data);
      out.push(...flattenArchive(arc.files.map((e) => ({ path: joinPath(f.path, e.path), data: e.data })), opts, depth + 1));
    } else {
      out.push({ path: normalizePath(f.path), data });
    }
  }
  return out;
}

/**
 * Build a texture lookup over the bundle's source paths, mirroring how NW4R's
 * layout resource accessor finds "timg/<name>" inside the same archive.
 */
export function makeTextureResolver(sourcePaths: string[]) {
  const textures = sourcePaths.filter((p) => extname(p) === '.tpl');
  const byLower = new Map(textures.map((p) => [p.toLowerCase(), p]));
  const byBase = new Map<string, string[]>();
  for (const p of textures) {
    const b = basename(p).toLowerCase();
    byBase.set(b, [...(byBase.get(b) ?? []), p]);
  }
  return (name: string, from: string): string | null => {
    const n = normalizePath(name);
    const candidates = [n, n.toLowerCase().endsWith('.tpl') ? null : `${n}.tpl`].filter(Boolean) as string[];
    const animDir = dirname(from);
    const arcRoot = /(^|\/)anim$/i.test(animDir) ? dirname(animDir) : animDir;
    for (const c of candidates) {
      for (const p of [joinPath(arcRoot, 'timg', c), joinPath(animDir, c), joinPath(arcRoot, c)]) {
        const hit = byLower.get(p.toLowerCase());
        if (hit) return makeAssetId('texture', hit);
      }
    }
    for (const c of candidates) {
      const list = byBase.get(basename(c).toLowerCase());
      if (!list?.length) continue;
      // Prefer the texture sharing the longest directory prefix with the animation.
      const score = (p: string) => {
        const a = from.split('/'), b = p.split('/');
        let i = 0;
        while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
        return i;
      };
      const best = [...list].sort((x, y) => score(y) - score(x) || x.localeCompare(y))[0];
      return makeAssetId('texture', best);
    }
    return null;
  };
}

function convertOne(file: InputFile, ctx: ConvertContext): AssetOutput {
  switch (detectFormat(file.path, file.data)) {
    case 'tpl': return convertTpl(file.data, ctx);
    case 'brfnt': return convertBrfnt(file.data, ctx);
    case 'brlan': return convertBrlan(file.data, ctx);
    case 'kcl': return convertKcl(file.data, ctx);
    default: return rawAsset(file);
  }
}

function rawAsset(file: InputFile, reason?: string): AssetOutput {
  const assetId = makeAssetId('raw', file.path);
  return {
    asset: {
      assetId,
      kind: 'raw',
      name: basename(file.path),
      sourcePath: file.path,
      sourceFormat: extname(file.path).slice(1) || 'bin',
      primary: file.path,
      files: { data: file.path },
      refs: [],
      unresolvedRefs: [],
      summary: { byteLength: file.data.length },
    },
    files: new Map([[file.path, file.data]]),
    warnings: reason ? [reason] : [],
  };
}

/**
 * Convert a set of (already flattened) files into a bundle. Conversion failures
 * never abort the bundle: the original bytes are kept as a `raw` asset and a
 * warning is recorded in the manifest.
 */
export function buildBundle(files: InputFile[], source: Manifest['source'], opts: ConvertOptions = {}): Bundle {
  const flat = flattenArchive(files, opts);
  const resolveTexture = makeTextureResolver(flat.map((f) => f.path));
  const out = new Map<string, Uint8Array>();
  const assets: ManifestAsset[] = [];
  const warnings: Manifest['warnings'] = [];
  const reserved = new Set(['manifest.json']);

  for (const file of [...flat].sort((a, b) => a.path.localeCompare(b.path))) {
    let result: AssetOutput;
    try {
      result = convertOne(file, { sourcePath: file.path, resolveTexture });
    } catch (e) {
      result = rawAsset(file, `conversion failed, kept original bytes: ${(e as Error).message}`);
    }
    const clash = [...result.files.keys()].find((p) => reserved.has(p) || out.has(p));
    if (clash) {
      warnings.push({ path: file.path, message: `output path "${clash}" already used; asset skipped` });
      continue;
    }
    for (const [p, b] of result.files) out.set(p, b);
    for (const p of result.files.keys()) reserved.add(p);
    for (const w of result.warnings) warnings.push({ path: file.path, message: w });
    assets.push(result.asset);
    opts.onAsset?.(result.asset);
  }

  const manifest: Manifest = {
    format: BUNDLE_FORMAT,
    version: SCHEMA_VERSION,
    generator: GENERATOR,
    source,
    assets,
    warnings,
  };
  out.set('manifest.json', jsonBytes(manifest));
  return { manifest, files: out };
}

/**
 * Convert any supported input. Archives (.carc/.arc/.szs, Yaz0 and/or U8) are
 * expanded so the bundle mirrors the archive's directory tree; a single file
 * yields a one-asset bundle.
 */
export function convertFile(name: string, input: ArrayBuffer | ArrayBufferView, opts: ConvertOptions = {}): Bundle {
  const bytes = toBytes(input);
  let data = bytes;
  let compression: 'none' | 'yaz0' = 'none';
  if (isYaz0(data)) {
    data = decompressYaz0(data);
    compression = 'yaz0';
  }
  const fmt = detectFormat(name, data);
  const source = { name: basename(name), format: fmt, compression, byteLength: bytes.length };
  if (fmt === 'u8') {
    return buildBundle(parseU8(data).files.map((f) => ({ path: f.path, data: f.data })), source, opts);
  }
  // Single (possibly Yaz0-wrapped) file: strip ".szs"-style wrappers from the name.
  const inner = compression === 'yaz0' && /\.(szs|yaz0|carc)$/i.test(name) ? basename(name).replace(/\.(szs|yaz0|carc)$/i, '') : basename(name);
  return buildBundle([{ path: inner, data }], source, opts);
}

/** Package a bundle as a .zip with manifest.json at the root (deterministic: fixed mtime). */
export function bundleToZip(bundle: Bundle, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const tree: Zippable = {};
  const mtime = new Date(Date.UTC(2000, 0, 1));
  const names = [...bundle.files.keys()].sort((a, b) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a.localeCompare(b)));
  for (const p of names) {
    const already = /\.(png|zip)$/i.test(p);
    tree[p] = [bundle.files.get(p)!, { level: already ? 0 : level, mtime }];
  }
  return zipSync(tree);
}
