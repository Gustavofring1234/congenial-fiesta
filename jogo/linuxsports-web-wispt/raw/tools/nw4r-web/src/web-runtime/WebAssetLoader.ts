/**
 * Carregador de bundles para o frontend (browser ou Web Worker; também funciona no Node).
 * Aceita o .zip inteiro ou a URL do manifest.json e resolve as referências cruzadas em memória.
 *
 *   const lib = await WebAssetLoader.fromZip(await (await fetch('menu.zip')).arrayBuffer());
 *   const anim = await lib.resolveAnimation('anm_...');   // anim.textures[i].image -> ImageBitmap
 */
import { unzipSync } from 'fflate';
import {
  AnimJson, FontJson, LayoutJson, Manifest, ModelJson, SceneJson, TexJson, validateBundle,
  type AssetEntry, type ValidationResult,
} from '../schemas/bundle.schema.ts';

export type FileSource = (path: string) => Promise<Uint8Array | undefined>;

export interface ResolvedTexture { asset: AssetEntry; meta: TexJson; images: (ImageBitmap | Blob | Uint8Array)[] }
export interface ResolvedFont { asset: AssetEntry; meta: FontJson; pages: (ImageBitmap | Blob | Uint8Array)[]; glyph(char: string): FontJson['chars'][number] | undefined }
export interface ResolvedAnimation { asset: AssetEntry; meta: AnimJson; textures: { name: string; texture: ResolvedTexture | null }[]; layout: ResolvedLayout | null }
export interface ResolvedLayout { asset: AssetEntry; meta: LayoutJson; textures: { name: string; texture: ResolvedTexture | null }[]; fonts: { name: string; font: ResolvedFont | null }[] }

export interface ResolvedModel { asset: AssetEntry; meta: ModelJson; /** .glb (use com GLTFLoader.parse do three.js) */ glb: Uint8Array }
export interface ResolvedScene {
  asset: AssetEntry; meta: SceneJson;
  models: ResolvedModel[];
  /** .glb de colisão de cada .kcl da cena */
  collision: { name: string; glb: Uint8Array | null }[];
  /** binários sem conversor (luz, mapa de luz, bloom...) */
  data: { role: string; name: string; bytes: Uint8Array | null }[];
}

export class WebAssetLoader {
  private readonly byId = new Map<string, AssetEntry>();
  private readonly bySource = new Map<string, AssetEntry>();
  private readonly cache = new Map<string, Promise<unknown>>();

  private constructor(readonly manifest: Manifest, private readonly read: FileSource, private readonly sync?: (p: string) => Uint8Array | undefined) {
    for (const a of manifest.assets) { this.byId.set(a.assetId, a); this.bySource.set(a.source, a); }
  }

  /** A partir dos bytes do .zip (ArrayBuffer/Uint8Array). Valida o bundle por padrão. */
  static async fromZip(zip: ArrayBuffer | Uint8Array, { validate = true } = {}): Promise<WebAssetLoader> {
    const files = unzipSync(zip instanceof Uint8Array ? zip : new Uint8Array(zip));
    const mf = files['manifest.json'];
    if (!mf) throw new Error('manifest.json não encontrado no zip');
    const manifest = Manifest.parse(JSON.parse(new TextDecoder().decode(mf)));
    const get = (p: string) => files[p];
    const loader = new WebAssetLoader(manifest, async (p) => get(p), get);
    if (validate) loader.assertValid();
    return loader;
  }

  /** A partir de um manifest.json servido via HTTP (arquivos relativos a ele). */
  static async fromUrl(manifestUrl: string, fetchFn: typeof fetch = fetch): Promise<WebAssetLoader> {
    const res = await fetchFn(manifestUrl);
    if (!res.ok) throw new Error(`falha ao baixar ${manifestUrl}: ${res.status}`);
    const manifest = Manifest.parse(await res.json());
    return new WebAssetLoader(manifest, async (p) => {
      const r = await fetchFn(new URL(p, new URL(manifestUrl, globalThis.location?.href ?? 'http://localhost/')).toString());
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined;
    });
  }

  /** Validação cruzada completa (disponível quando o zip inteiro está em memória). */
  validate(): ValidationResult {
    if (!this.sync) return { ok: true, errors: [], warnings: ['validação completa só está disponível em fromZip'] };
    return validateBundle(this.manifest, this.sync);
  }

  assertValid(): void {
    const r = this.validate();
    if (!r.ok) throw new Error(`bundle inválido:\n${r.errors.slice(0, 20).join('\n')}`);
  }

  get assets(): readonly AssetEntry[] { return this.manifest.assets; }
  get(id: string): AssetEntry | undefined { return this.byId.get(id); }
  getBySource(source: string): AssetEntry | undefined { return this.bySource.get(source); }
  list(kind: AssetEntry['kind']): AssetEntry[] { return this.manifest.assets.filter((a) => a.kind === kind); }

  async bytes(path: string): Promise<Uint8Array> {
    const b = await this.read(path);
    if (!b) throw new Error(`arquivo não encontrado no bundle: ${path}`);
    return b;
  }

  async json<T>(path: string): Promise<T> {
    return JSON.parse(new TextDecoder().decode(await this.bytes(path))) as T;
  }

  /** PNG -> ImageBitmap (browser/worker), Blob (sem createImageBitmap) ou bytes (Node). */
  async image(path: string): Promise<ImageBitmap | Blob | Uint8Array> {
    return this.memo(`img:${path}`, async () => {
      const b = await this.bytes(path);
      if (typeof Blob === 'undefined') return b;
      const blob = new Blob([b], { type: 'image/png' });
      return typeof createImageBitmap === 'function' ? createImageBitmap(blob) : blob;
    });
  }

  private memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key) as Promise<T>;
  }

  private need(id: string, kind: AssetEntry['kind']): AssetEntry {
    const a = this.byId.get(id);
    if (!a) throw new Error(`asset inexistente: ${id}`);
    if (a.kind !== kind) throw new Error(`asset ${id} é "${a.kind}", esperado "${kind}"`);
    return a;
  }

  async resolveTexture(id: string): Promise<ResolvedTexture> {
    return this.memo(`tex:${id}`, async () => {
      const asset = this.need(id, 'texture');
      const meta = TexJson.parse(await this.json(asset.main));
      return { asset, meta, images: await Promise.all(meta.images.map((i) => this.image(i.file))) };
    });
  }

  async resolveFont(id: string): Promise<ResolvedFont> {
    return this.memo(`fnt:${id}`, async () => {
      const asset = this.need(id, 'font');
      const meta = FontJson.parse(await this.json(asset.main));
      const map = new Map(meta.chars.map((c) => [c.id, c]));
      return { asset, meta, pages: await Promise.all(meta.pages.map((p) => this.image(p))), glyph: (ch: string) => map.get(ch.codePointAt(0) ?? -1) };
    });
  }

  async resolveLayout(id: string): Promise<ResolvedLayout> {
    return this.memo(`lyt:${id}`, async () => {
      const asset = this.need(id, 'layout');
      const meta = LayoutJson.parse(await this.json(asset.main));
      return {
        asset, meta,
        textures: await Promise.all(meta.textures.map(async (t) => ({ name: t.name, texture: t.ref ? await this.resolveTexture(t.ref) : null }))),
        fonts: await Promise.all(meta.fonts.map(async (f) => ({ name: f.name, font: f.ref ? await this.resolveFont(f.ref) : null }))),
      };
    });
  }

  async resolveAnimation(id: string): Promise<ResolvedAnimation> {
    return this.memo(`anm:${id}`, async () => {
      const asset = this.need(id, 'animation');
      const meta = AnimJson.parse(await this.json(asset.main));
      return {
        asset, meta,
        textures: await Promise.all(meta.textures.map(async (t) => ({ name: t.name, texture: t.ref ? await this.resolveTexture(t.ref) : null }))),
        layout: meta.layout?.ref ? await this.resolveLayout(meta.layout.ref) : null,
      };
    });
  }

  async resolveModel(id: string): Promise<ResolvedModel> {
    return this.memo(`mdl:${id}`, async () => {
      const asset = this.need(id, 'model');
      const meta = ModelJson.parse(await this.json(asset.main));
      return { asset, meta, glb: await this.bytes(meta.glb) };
    });
  }

  async resolveScene(id: string): Promise<ResolvedScene> {
    return this.memo(`scn:${id}`, async () => {
      const asset = this.need(id, 'scene');
      const meta = SceneJson.parse(await this.json(asset.main));
      return {
        asset, meta,
        models: await Promise.all(meta.models.filter((m) => m.ref).map((m) => this.resolveModel(m.ref!))),
        collision: await Promise.all(meta.collision.map(async (c) => ({ name: c.name, glb: c.ref ? await this.collision(c.ref) : null }))),
        data: await Promise.all(meta.data.map(async (d) => ({ role: d.role, name: d.name, bytes: d.ref ? await this.bytes(this.need(d.ref, 'binary').main) : null }))),
      };
    });
  }

  /** Animações que apontam para um layout (índice reverso pelas refs do manifest). */
  animationsFor(layoutId: string): AssetEntry[] {
    return this.manifest.assets.filter((a) => a.kind === 'animation' && a.refs.includes(layoutId));
  }

  /** Asset pelo caminho de origem no jogo (ex.: "src/.../blyt/menu_00.brlyt"). */
  bySourcePath(source: string): AssetEntry | undefined {
    return this.bySource.get(source);
  }

  /** .glb de colisão (bytes; use com three.js GLTFLoader.parse ou similar). */
  async collision(id: string): Promise<Uint8Array> {
    return this.bytes(this.need(id, 'collision').main);
  }
}
