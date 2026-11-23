// Leitura dos dados convertidos (minigames/sports/assets/, gerados por tools/*.py com NW4R_TARGET=web).
// Todos os caminhos dos JSON (sidecars, cenas, animações, efeitos, UI, textos) são relativos a essa raiz.
// Cache por caminho: o mesmo .json/.png/.glb é baixado uma vez só, mesmo com pedidos simultâneos.
import { runtime } from '../../lib/runtime.js';

const DEFAULT_BASE = new URL('../../assets/', import.meta.url).href;

export class AssetStore {
  /**
   * @param {object} [o]
   * @param {string} [o.base]   raiz dos dados (padrão: minigames/sports/assets/ ao lado deste módulo)
   * @param {Function} [o.fetch] fetch alternativo (testes em Node: lê do disco)
   */
  constructor({ base = DEFAULT_BASE, fetch: f = null } = {}) {
    this.base = base.endsWith('/') ? base : base + '/';
    this.fetchImpl = f || ((u) => fetch(u));
    this.cache = new Map();
  }

  url(path) { return new URL(path, this.base).href; }

  once(key, make) {
    let p = this.cache.get(key);
    if (!p) {
      p = make();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key)); // um erro de rede não fica preso no cache
    }
    return p;
  }

  async response(path) {
    const r = await this.fetchImpl(this.url(path));
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r;
  }

  json(path) { return this.once('json:' + path, async () => (await this.response(path)).json()); }

  text(path) { return this.once('text:' + path, async () => (await this.response(path)).text()); }

  arrayBuffer(path) { return this.once('bin:' + path, async () => (await this.response(path)).arrayBuffer()); }

  /** Imagem decodificada (ImageBitmap no navegador; para canvas 2D e texturas). */
  image(path) {
    return this.once('img:' + path, async () => {
      const blob = await (await this.response(path)).blob();
      if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
      throw new Error('createImageBitmap indisponível');
    });
  }

  /**
   * Textura de cor (sRGB) para materiais 3D. flipY = false: a convenção de UV do Wii é a mesma do glTF.
   * wrap: 'clamp' | 'repeat' | 'mirror' (GX 0/1/2).
   */
  texture(path, { wrapS = 'repeat', wrapT = 'repeat', color = true } = {}) {
    return this.once(`tex:${path}|${wrapS}|${wrapT}|${color}`, async () => {
      const T = runtime.THREE;
      const img = await this.image(path);
      const tex = new T.Texture(img);
      tex.flipY = false;
      tex.colorSpace = color ? T.SRGBColorSpace : T.NoColorSpace;
      tex.wrapS = wrapMode(T, wrapS);
      tex.wrapT = wrapMode(T, wrapT);
      tex.name = path.split('/').pop();
      tex.needsUpdate = true;
      return tex;
    });
  }

  /** .glb pelo GLTFLoader do WEBC. Devolve o resultado do loader (scene, parser...). Cada chamada é uma cópia nova. */
  async gltf(path, plugins = []) {
    const buf = await this.arrayBuffer(path);
    const loader = new runtime.GLTFLoader();
    for (const p of plugins) loader.register(p);
    return loader.parseAsync(buf.slice(0), this.url(path).replace(/[^/]*$/, ''));
  }
}

export function wrapMode(T, w) {
  if (w === 'clamp' || w === 0) return T.ClampToEdgeWrapping;
  if (w === 'mirror' || w === 2) return T.MirroredRepeatWrapping;
  return T.RepeatWrapping;
}

/** Store padrão compartilhado pelos módulos (troque com setDefaultStore em testes ou outra hospedagem). */
let shared = null;
export function defaultStore() { return shared || (shared = new AssetStore()); }
export function setDefaultStore(store) { shared = store; }
