/**
 * WebAssetLoader — browser / Web Worker / Node runtime for converted bundles.
 *
 *   import { WebAssetLoader } from 'nw4r-web-converter/web-runtime';
 *   const loader = await WebAssetLoader.fromZip(await fetch('/assets/font.zip').then(r => r.arrayBuffer()));
 *   // or: await WebAssetLoader.fromManifestUrl('/assets/font/manifest.json');
 *   const anim = await loader.getAnimation('animation-0123456789abcdef');
 *   anim.textures[0]?.getImageBitmap();      // cross-references resolved in memory
 *
 * Only depends on fflate (pure JS) and the shared Zod schema.
 */
import { unzipSync } from 'fflate';
import { dirname, joinPath, normalizePath } from '../core/ids.ts';
import {
  AnimMeta,
  type BundleIssue,
  FontMeta,
  Manifest,
  type ManifestAsset,
  TextureMeta,
  validateBundle,
} from '../schemas/bundle.schema.ts';
import { type SampledPose, sampleAnimation } from './anim-sampler.ts';

export interface BundleSource {
  read(path: string): Promise<Uint8Array>;
  /** Synchronous existence check when the whole bundle is in memory (zip). */
  has?(path: string): boolean;
}

interface BaseResolved {
  asset: ManifestAsset;
}

export interface ResolvedImage {
  path: string;
  bytes: Uint8Array;
  blob(): Blob;
  /** Object URL (revoked by loader.dispose()). Browser only. */
  objectUrl(): string;
  /** Decoded bitmap for Canvas/WebGL. Browser / Worker only. */
  imageBitmap(): Promise<ImageBitmap>;
}

export interface ResolvedTexture extends BaseResolved {
  kind: 'texture';
  meta: TextureMeta;
  images: ResolvedImage[];
  getImageBitmap(index?: number): Promise<ImageBitmap>;
}

export interface ResolvedFont extends BaseResolved {
  kind: 'font';
  meta: FontMeta;
  atlas: ResolvedImage;
  glyph(char: string | number): FontMeta['chars'][number] | undefined;
  /** Pixel width of a single-line string using xadvance (fallback glyph for missing chars). */
  measure(text: string): number;
}

export interface ResolvedAnimation extends BaseResolved {
  kind: 'animation';
  meta: AnimMeta;
  /** Same order as meta.textures; null when the reference was unresolved at conversion time. */
  textures: Array<ResolvedTexture | null>;
  sample(frame: number): SampledPose;
}

export interface ResolvedCollision extends BaseResolved {
  kind: 'collision';
  glb: Uint8Array;
  /** glTF JSON chunk (meshes[].extras carry collision flags). */
  gltf: any;
}

export interface ResolvedRaw extends BaseResolved {
  kind: 'raw';
  bytes: Uint8Array;
}

export type ResolvedAsset = ResolvedTexture | ResolvedFont | ResolvedAnimation | ResolvedCollision | ResolvedRaw;

export class AssetLoadError extends Error {
  constructor(message: string, readonly issues: BundleIssue[] = []) {
    super(message);
    this.name = 'AssetLoadError';
  }
}

const decoder = new TextDecoder();

export class WebAssetLoader {
  readonly manifest: Manifest;
  private readonly byId = new Map<string, ManifestAsset>();
  private readonly byPath = new Map<string, ManifestAsset>();
  private readonly cache = new Map<string, Promise<ResolvedAsset>>();
  private readonly objectUrls: string[] = [];

  private constructor(manifest: Manifest, private readonly source: BundleSource) {
    this.manifest = manifest;
    for (const a of manifest.assets) {
      this.byId.set(a.assetId, a);
      this.byPath.set(a.sourcePath.toLowerCase(), a);
    }
  }

  /** Load from a .zip (ArrayBuffer, Uint8Array or Blob). The whole bundle is validated up front. */
  static async fromZip(zip: ArrayBuffer | Uint8Array | Blob, opts: { strict?: boolean } = {}): Promise<WebAssetLoader> {
    const bytes = zip instanceof Uint8Array ? zip : new Uint8Array(zip instanceof Blob ? await zip.arrayBuffer() : zip);
    const entries = unzipSync(bytes);
    const files = new Map(Object.entries(entries).map(([k, v]) => [normalizePath(k), v]));
    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes) throw new AssetLoadError('zip has no manifest.json at its root');
    const raw = JSON.parse(decoder.decode(manifestBytes));
    const { manifest, issues } = validateBundle(raw, {
      has: (p) => files.has(p),
      readText: (p) => (files.has(p) ? decoder.decode(files.get(p)!) : undefined),
    });
    const errors = issues.filter((i) => i.severity === 'error');
    if (!manifest || (opts.strict !== false && errors.length)) {
      throw new AssetLoadError(`invalid bundle: ${errors.length} error(s)${errors[0] ? ` — ${errors[0].path}: ${errors[0].message}` : ''}`, issues);
    }
    return new WebAssetLoader(manifest, {
      has: (p) => files.has(p),
      read: async (p) => {
        const b = files.get(p);
        if (!b) throw new AssetLoadError(`missing file in zip: ${p}`);
        return b;
      },
    });
  }

  /** Load a bundle served as loose files; `url` points at its manifest.json. */
  static async fromManifestUrl(url: string | URL, fetchImpl: typeof fetch = fetch): Promise<WebAssetLoader> {
    const manifestUrl = new URL(url, (globalThis as any).location?.href ?? 'http://localhost/');
    const res = await fetchImpl(manifestUrl);
    if (!res.ok) throw new AssetLoadError(`failed to fetch manifest (${res.status}) ${manifestUrl}`);
    const parsed = Manifest.safeParse(await res.json());
    if (!parsed.success) throw new AssetLoadError(`invalid manifest: ${parsed.error.issues[0]?.message}`);
    // Structural checks only (file existence is verified lazily on first read).
    const { issues } = validateBundle(parsed.data, { has: () => true, readText: () => undefined });
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new AssetLoadError(`invalid manifest: ${errors[0].message}`, issues);
    return new WebAssetLoader(parsed.data, {
      read: async (p) => {
        const r = await fetchImpl(new URL(p, manifestUrl));
        if (!r.ok) throw new AssetLoadError(`failed to fetch ${p} (${r.status})`);
        return new Uint8Array(await r.arrayBuffer());
      },
    });
  }

  /** Use any custom storage (IndexedDB, OPFS, a Map...). */
  static fromSource(manifest: unknown, source: BundleSource): WebAssetLoader {
    return new WebAssetLoader(Manifest.parse(manifest), source);
  }

  list(kind?: ManifestAsset['kind']): ManifestAsset[] {
    return kind ? this.manifest.assets.filter((a) => a.kind === kind) : [...this.manifest.assets];
  }

  info(assetId: string): ManifestAsset | undefined {
    return this.byId.get(assetId);
  }

  /** Look up an asset by its original archive path, e.g. "results.arc/timg/a.tpl". */
  findBySourcePath(sourcePath: string): ManifestAsset | undefined {
    return this.byPath.get(normalizePath(sourcePath).toLowerCase());
  }

  load(assetId: string): Promise<ResolvedAsset> {
    let p = this.cache.get(assetId);
    if (!p) {
      p = this.resolve(assetId);
      this.cache.set(assetId, p);
      p.catch(() => this.cache.delete(assetId));
    }
    return p;
  }

  async getTexture(id: string): Promise<ResolvedTexture> { return this.expect(id, 'texture'); }
  async getFont(id: string): Promise<ResolvedFont> { return this.expect(id, 'font'); }
  async getAnimation(id: string): Promise<ResolvedAnimation> { return this.expect(id, 'animation'); }
  async getCollision(id: string): Promise<ResolvedCollision> { return this.expect(id, 'collision'); }

  /** Resolve every asset (and therefore every cross reference). */
  async loadAll(): Promise<Map<string, ResolvedAsset>> {
    const entries = await Promise.all(this.manifest.assets.map(async (a) => [a.assetId, await this.load(a.assetId)] as const));
    return new Map(entries);
  }

  /** Revoke object URLs created by ResolvedImage.objectUrl(). */
  dispose(): void {
    for (const u of this.objectUrls.splice(0)) URL.revokeObjectURL(u);
    this.cache.clear();
  }

  // ------------------------------------------------------------------ internals

  private async expect<K extends ResolvedAsset['kind']>(id: string, kind: K): Promise<Extract<ResolvedAsset, { kind: K }>> {
    const a = await this.load(id);
    if (a.kind !== kind) throw new AssetLoadError(`${id} is a ${a.kind}, not a ${kind}`);
    return a as Extract<ResolvedAsset, { kind: K }>;
  }

  private async readJson(path: string): Promise<unknown> {
    return JSON.parse(decoder.decode(await this.source.read(path)));
  }

  private image(path: string, bytes: Uint8Array): ResolvedImage {
    let blob: Blob | undefined;
    const getBlob = () => (blob ??= new Blob([bytes as BlobPart], { type: 'image/png' }));
    return {
      path,
      bytes,
      blob: getBlob,
      objectUrl: () => {
        const u = URL.createObjectURL(getBlob());
        this.objectUrls.push(u);
        return u;
      },
      imageBitmap: () => {
        if (typeof createImageBitmap !== 'function') throw new AssetLoadError('createImageBitmap is not available in this runtime');
        return createImageBitmap(getBlob());
      },
    };
  }

  private async resolve(assetId: string): Promise<ResolvedAsset> {
    const asset = this.byId.get(assetId);
    if (!asset) throw new AssetLoadError(`unknown assetId ${assetId}`);
    const base = dirname(asset.primary);

    switch (asset.kind) {
      case 'texture': {
        const meta = TextureMeta.parse(await this.readJson(asset.files.meta));
        const images = await Promise.all(
          meta.images.map(async (img) => {
            const p = joinPath(base, img.file);
            return this.image(p, await this.source.read(p));
          }),
        );
        return { kind: 'texture', asset, meta, images, getImageBitmap: (i = 0) => images[i].imageBitmap() };
      }
      case 'font': {
        const meta = FontMeta.parse(await this.readJson(asset.files.meta));
        const atlasPath = joinPath(base, meta.pages[0]);
        const atlas = this.image(atlasPath, await this.source.read(atlasPath));
        const byCode = new Map(meta.chars.map((c) => [c.id, c]));
        const fallback = meta.nw4r.fallbackChar !== null ? byCode.get(meta.nw4r.fallbackChar) : undefined;
        const glyph = (c: string | number) => byCode.get(typeof c === 'number' ? c : c.codePointAt(0)!);
        return {
          kind: 'font',
          asset,
          meta,
          atlas,
          glyph,
          measure: (text) => [...text].reduce((w, ch) => w + ((glyph(ch) ?? fallback)?.xadvance ?? meta.nw4r.defaultWidth.charWidth), 0),
        };
      }
      case 'animation': {
        const meta = AnimMeta.parse(await this.readJson(asset.files.meta));
        const textures = await Promise.all(meta.textures.map((t) => (t.assetId ? this.getTexture(t.assetId) : Promise.resolve(null))));
        return { kind: 'animation', asset, meta, textures, sample: (frame) => sampleAnimation(meta, frame) };
      }
      case 'collision': {
        const glb = await this.source.read(asset.files.model);
        const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
        const jsonLen = dv.getUint32(12, true);
        const gltf = JSON.parse(decoder.decode(glb.subarray(20, 20 + jsonLen)));
        return { kind: 'collision', asset, glb, gltf };
      }
      default:
        return { kind: 'raw', asset, bytes: await this.source.read(asset.files.data) };
    }
  }
}
