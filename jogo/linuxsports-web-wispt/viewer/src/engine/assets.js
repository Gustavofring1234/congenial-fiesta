// Acesso aos dados da pasta web (manifest, JSONs, imagens), com cache.
// A raiz do projeto é relativa a este módulo (viewer/src/engine/), não à página.
export const ROOT = new URL('../../../', import.meta.url);
export const url = (p) => new URL(p, ROOT).href;

const jsonCache = new Map();
const imgCache = new Map();

export function getJson(p) {
  if (!jsonCache.has(p)) {
    jsonCache.set(p, fetch(url(p)).then((r) => {
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      return r.json();
    }));
  }
  return jsonCache.get(p);
}

export function getImage(p) {
  if (!imgCache.has(p)) {
    imgCache.set(p, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`imagem não carregou: ${p}`));
      img.src = url(p);
    }));
  }
  return imgCache.get(p);
}

export class Lib {
  static async load() {
    const lib = new Lib();
    lib.manifest = await getJson('manifest.json');
    lib.byId = new Map(lib.manifest.assets.map((a) => [a.assetId, a]));
    lib.bySource = new Map(lib.manifest.assets.map((a) => [a.source, a]));
    const opt = (p, d) => getJson(p).catch(() => d);
    [lib.layoutAnims, lib.aliases, lib.missingTargets] = await Promise.all([
      opt('index/layout-animations.json', {}), opt('index/texture-aliases.json', {}), opt('index/anim-missing-targets.json', []),
    ]);
    return lib;
  }

  of(kind) { return this.manifest.assets.filter((a) => a.kind === kind); }

  /** textura: { meta, img } (img = primeira imagem) */
  async texture(id) {
    const a = this.byId.get(id);
    if (!a) return null;
    const meta = await getJson(a.main);
    return { asset: a, meta, img: await getImage(meta.images[0].file) };
  }

  /** fonte: { meta, img, glyph(codePoint) } */
  async font(id) {
    const a = this.byId.get(id);
    if (!a) return null;
    const meta = await getJson(a.main);
    const map = new Map(meta.chars.map((c) => [c.id, c]));
    return { asset: a, meta, img: await getImage(meta.pages[0]), glyph: (cp) => map.get(cp) };
  }
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export const short = (p) => p.split('/').slice(-1)[0];
export const fmtBytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);
