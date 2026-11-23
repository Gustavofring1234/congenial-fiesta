/**
 * Unified schema for every JSON file emitted by the converters, plus a
 * cross-reference validator that guarantees a bundle has no broken links.
 *
 * Conventions:
 *  - Paths in manifest.json are bundle-root relative POSIX paths.
 *  - Paths inside *.tex.json / *.font.json are relative to that JSON file's directory.
 *  - assetId = `${kind}-${fnv1a64(kind + ':' + lowercase(sourcePath))}` (deterministic).
 */

// zod/mini: same validation as classic Zod, ~20x smaller in browser bundles (no locale tables).
import * as z from 'zod/mini';
import { ASSET_ID_PATTERN, dirname, joinPath, makeAssetId, normalizePath } from '../core/ids.ts';

const int = () => z.int();
const nonneg = () => z.int().check(z.nonnegative());
const positive = () => z.int().check(z.positive());
const num = () => z.number();
const vec2 = () => z.tuple([num(), num()]);

export const BUNDLE_FORMAT = 'nw4r-web-bundle';
export const SCHEMA_VERSION = 1;

export const RelPath = z.string().check(
  z.minLength(1),
  z.refine((p: string) => normalizePath(p) === p && !p.includes('\\'), { message: 'must be a normalized relative POSIX path' }),
);

/** Like RelPath but allows "../" segments (paths relative to a JSON file). */
export const RelRef = z.string().check(
  z.minLength(1),
  z.refine((p: string) => !p.includes('\\') && !p.startsWith('/'), { message: 'must be a relative POSIX path' }),
);

export const AssetId = z.string().check(z.regex(ASSET_ID_PATTERN, 'invalid assetId'));
export const AssetKind = z.enum(['texture', 'font', 'animation', 'collision', 'raw']);

// ---------------------------------------------------------------- manifest

export const ManifestAsset = z.object({
  assetId: AssetId,
  kind: AssetKind,
  name: z.string().check(z.minLength(1)),
  /** Original path inside the source archive (or the source file name). */
  sourcePath: RelPath,
  /** Detected binary format: tpl, brfnt, brlan, kcl, or the extension for raw files. */
  sourceFormat: z.string(),
  /** Main file for this asset (meta JSON, or the GLB/raw data). */
  primary: RelPath,
  /** Every output file of this asset keyed by role: meta, image, image1.., atlas, model, data. */
  files: z.record(z.string(), RelPath),
  /** assetIds this asset depends on (all must exist in the manifest). */
  refs: z.array(AssetId),
  /** References that could not be resolved (kept for diagnostics, never dangling ids). */
  unresolvedRefs: z.array(z.string()),
  /** Small kind-specific summary (dimensions, frame count, triangle count, ...). */
  summary: z.optional(z.record(z.string(), z.unknown())),
});
export type ManifestAsset = z.infer<typeof ManifestAsset>;

export const Manifest = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(SCHEMA_VERSION),
  generator: z.object({ name: z.string(), version: z.string() }),
  source: z.object({
    name: z.string(),
    format: z.string(),
    compression: z.enum(['none', 'yaz0']),
    byteLength: nonneg(),
  }),
  assets: z.array(ManifestAsset),
  warnings: z.array(z.object({ path: z.string(), message: z.string() })),
});
export type Manifest = z.infer<typeof Manifest>;

// ---------------------------------------------------------------- texture (.tex.json)

export const WrapMode = z.enum(['CLAMP', 'REPEAT', 'MIRROR']);
export const FilterMode = z.enum(['NEAR', 'LINEAR', 'NEAR_MIP_NEAR', 'LIN_MIP_NEAR', 'NEAR_MIP_LIN', 'LIN_MIP_LIN']);

export const TextureImage = z.object({
  index: nonneg(),
  file: RelRef,
  width: positive(),
  height: positive(),
  gxFormat: z.string(),
  gxFormatId: int(),
  sampler: z.object({
    wrapS: WrapMode,
    wrapT: WrapMode,
    minFilter: FilterMode,
    magFilter: FilterMode,
    lodBias: num(),
    edgeLodEnable: z.boolean(),
    minLod: num(),
    maxLod: num(),
    webgl: z.object({ wrapS: z.string(), wrapT: z.string(), minFilter: z.string(), magFilter: z.string() }),
  }),
  mipmaps: z.array(z.object({ level: int(), width: int(), height: int() })),
  palette: z.nullable(z.object({ format: z.string(), entryCount: int() })),
});

export const TextureMeta = z.object({
  format: z.literal('nw4r-web/texture'),
  version: z.literal(SCHEMA_VERSION),
  assetId: AssetId,
  name: z.string(),
  source: RelPath,
  images: z.array(TextureImage).check(z.minLength(1)),
});
export type TextureMeta = z.infer<typeof TextureMeta>;

// ---------------------------------------------------------------- font (.font.json, BMFont JSON layout)

export const FontChar = z.object({
  id: nonneg(),
  char: z.string(),
  /** Glyph index inside the original font (NW4R). */
  index: nonneg(),
  x: int(),
  y: int(),
  width: nonneg(),
  height: nonneg(),
  xoffset: int(),
  yoffset: int(),
  xadvance: int(),
  page: nonneg(),
  chnl: int(),
  /** Normalized UV rectangle [u0, v0, u1, v1], v pointing down (top-left origin). */
  uv: z.tuple([num(), num(), num(), num()]),
});

export const FontMeta = z.object({
  format: z.literal('nw4r-web/font'),
  version: z.literal(SCHEMA_VERSION),
  assetId: AssetId,
  name: z.string(),
  source: RelPath,
  pages: z.array(RelRef).check(z.minLength(1)),
  info: z.object({
    face: z.string(),
    size: int(),
    bold: int(),
    italic: int(),
    charset: z.string(),
    unicode: int(),
    stretchH: int(),
    smooth: int(),
    aa: int(),
    padding: z.tuple([num(), num(), num(), num()]),
    spacing: vec2(),
  }),
  common: z.object({
    lineHeight: int(),
    base: int(),
    scaleW: positive(),
    scaleH: positive(),
    pages: positive(),
    packed: int(),
  }),
  chars: z.array(FontChar),
  kernings: z.array(z.object({ first: int(), second: int(), amount: int() })),
  nw4r: z.object({
    encoding: z.string(),
    fontType: int(),
    sheetFormat: z.string(),
    cellWidth: int(),
    cellHeight: int(),
    baselinePos: int(),
    maxCharWidth: int(),
    ascent: int(),
    defaultWidth: z.object({ left: num(), glyphWidth: num(), charWidth: num() }),
    /** Code point of the fallback ("alter") glyph, if mapped. */
    fallbackChar: z.nullable(int()),
    /** How each sheet was placed in the atlas. */
    sheets: z.array(z.object({ x: int(), y: int(), width: int(), height: int() })),
  }),
});
export type FontMeta = z.infer<typeof FontMeta>;

// ---------------------------------------------------------------- animation (.anim.json)

export const AnimKey = z.object({ frame: num(), value: num(), slope: z.optional(num()) });

/** Cubic Bézier segment equivalent to a Hermite segment, absolute (frame, value) control points. */
export const BezierSegment = z.object({
  p0: vec2(),
  p1: vec2(),
  p2: vec2(),
  p3: vec2(),
  /** CSS/WAAPI/GSAP easing between key values when expressible (null if v0 == v1 but curve bulges). */
  easing: z.nullable(z.string()),
});

export const AnimTrack = z.object({
  target: z.string(),
  targetKind: z.enum(['pane', 'material']),
  group: z.enum(['paneSRT', 'textureSRT', 'visibility', 'vertexColor', 'materialColor', 'texturePattern', 'indirectSRT', 'unknown']),
  property: z.string(),
  /** Sub-resource index (texture SRT slot, texmap slot...). */
  index: nonneg(),
  interpolation: z.enum(['step', 'hermite']),
  keys: z.array(AnimKey),
  segments: z.optional(z.array(BezierSegment)),
});

export const AnimTextureRef = z.object({
  name: z.string(),
  assetId: z.nullable(AssetId),
});

export const AnimMeta = z.object({
  format: z.literal('nw4r-web/anim'),
  version: z.literal(SCHEMA_VERSION),
  assetId: AssetId,
  name: z.string(),
  source: RelPath,
  fps: num().check(z.positive()),
  frameCount: nonneg(),
  loop: z.boolean(),
  /** Texture pattern table: `texture` track values index into this array. */
  textures: z.array(AnimTextureRef),
  tracks: z.array(AnimTrack),
});
export type AnimMeta = z.infer<typeof AnimMeta>;

// ---------------------------------------------------------------- collision summary (mesh.extras)

export const CollisionMeshExtras = z.object({
  collisionFlag: int(),
  collisionFlagHex: z.string(),
  triangleCount: int(),
});

// ---------------------------------------------------------------- cross validation

export interface BundleIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface BundleFiles {
  has(path: string): boolean;
  readText(path: string): string | undefined;
}

export function bundleFilesFromMap(files: Map<string, Uint8Array> | Record<string, Uint8Array>): BundleFiles {
  const map = files instanceof Map ? files : new Map(Object.entries(files));
  const dec = new TextDecoder();
  return {
    has: (p) => map.has(p),
    readText: (p) => {
      const b = map.get(p);
      return b ? dec.decode(b) : undefined;
    },
  };
}

const META_SCHEMAS = { texture: TextureMeta, font: FontMeta, animation: AnimMeta } as const;

/**
 * Validate a manifest and every file it references. Returns all issues found;
 * an empty error list means every relative path and every assetId resolves.
 */
export function validateBundle(manifestInput: unknown, files: BundleFiles): { manifest?: Manifest; issues: BundleIssue[] } {
  const issues: BundleIssue[] = [];
  const err = (path: string, message: string) => issues.push({ severity: 'error', path, message });

  const parsed = Manifest.safeParse(manifestInput);
  if (!parsed.success) {
    for (const i of parsed.error.issues) err(`manifest.json#/${i.path.join('/')}`, i.message);
    return { issues };
  }
  const manifest = parsed.data;
  const byId = new Map<string, ManifestAsset>();
  const fileOwner = new Map<string, string>();

  for (const a of manifest.assets) {
    if (byId.has(a.assetId)) err('manifest.json', `duplicate assetId ${a.assetId}`);
    byId.set(a.assetId, a);
    const expected = makeAssetId(a.kind, a.sourcePath);
    if (expected !== a.assetId) err('manifest.json', `${a.assetId} is not deterministic for ${a.kind}:${a.sourcePath} (expected ${expected})`);
    if (!Object.values(a.files).includes(a.primary)) err('manifest.json', `${a.assetId}: primary "${a.primary}" not listed in files`);
    for (const f of Object.values(a.files)) {
      if (!files.has(f)) err(f, `missing file referenced by ${a.assetId}`);
      const owner = fileOwner.get(f);
      if (owner && owner !== a.assetId) err(f, `file claimed by both ${owner} and ${a.assetId}`);
      fileOwner.set(f, a.assetId);
    }
  }

  for (const a of manifest.assets) {
    for (const ref of a.refs) {
      if (!byId.has(ref)) err('manifest.json', `${a.assetId} references unknown asset ${ref}`);
    }
    for (const u of a.unresolvedRefs) issues.push({ severity: 'warning', path: a.sourcePath, message: `unresolved reference "${u}"` });

    const schema = META_SCHEMAS[a.kind as keyof typeof META_SCHEMAS];
    if (!schema) continue;
    const metaPath = a.files.meta;
    if (!metaPath) { err('manifest.json', `${a.assetId}: ${a.kind} asset has no "meta" file`); continue; }
    const text = files.readText(metaPath);
    if (text === undefined) continue; // already reported as missing
    let json: unknown;
    try { json = JSON.parse(text); } catch (e) { err(metaPath, `invalid JSON: ${(e as Error).message}`); continue; }
    const meta = schema.safeParse(json);
    if (!meta.success) {
      for (const i of meta.error.issues) err(`${metaPath}#/${i.path.join('/')}`, i.message);
      continue;
    }
    const data = meta.data as TextureMeta | FontMeta | AnimMeta;
    if (data.assetId !== a.assetId) err(metaPath, `assetId ${data.assetId} does not match manifest ${a.assetId}`);
    const base = dirname(metaPath);
    const checkRel = (rel: string) => {
      const target = joinPath(base, rel);
      if (!files.has(target)) err(metaPath, `relative path "${rel}" resolves to missing "${target}"`);
      else if (fileOwner.get(target) !== a.assetId) err(metaPath, `"${target}" is not listed in ${a.assetId}.files`);
    };
    if (data.format === 'nw4r-web/texture') data.images.forEach((img) => checkRel(img.file));
    if (data.format === 'nw4r-web/font') {
      data.pages.forEach(checkRel);
      data.chars.forEach((c) => { if (c.page >= data.pages.length) err(metaPath, `char ${c.id} uses missing page ${c.page}`); });
    }
    if (data.format === 'nw4r-web/anim') {
      for (const t of data.textures) {
        if (!t.assetId) continue;
        const target = byId.get(t.assetId);
        if (!target) err(metaPath, `texture "${t.name}" -> unknown asset ${t.assetId}`);
        else if (target.kind !== 'texture') err(metaPath, `texture "${t.name}" -> ${t.assetId} is a ${target.kind}`);
        if (!a.refs.includes(t.assetId)) err(metaPath, `texture ${t.assetId} missing from manifest refs`);
      }
      for (const tr of data.tracks) {
        if (tr.group !== 'texturePattern') continue;
        for (const k of tr.keys) {
          if (k.value < 0 || k.value >= data.textures.length) err(metaPath, `${tr.target}: texture index ${k.value} out of range`);
        }
      }
    }
  }
  return { manifest, issues };
}
