/**
 * .carc / .arc / conjunto de arquivos -> .zip com manifest.json.
 * Descompacta Yaz0, abre U8 (inclusive .arc aninhados) e converte cada arquivo interno.
 */
import { zipSync, type Zippable } from 'fflate';
import { isYaz0, yaz0Decompress } from '../parsers/yaz0.ts';
import { isU8, parseU8, type U8File } from '../parsers/u8.ts';
import { isTpl } from '../parsers/tpl.ts';
import { isBrfnt } from '../parsers/brfnt.ts';
import { BRLAN_EXTENSIONS, isBrlan } from '../parsers/brlan.ts';
import { flattenPanes, isBrlyt, parseBrlyt } from '../parsers/brlyt.ts';
import { textureToWeb } from './texture.ts';
import { fontToWeb } from './font.ts';
import { animToWeb } from './anim.ts';
import { collisionToWeb } from './collision.ts';
import { type AssetKind, basename, makeAssetId, stripExt, toPosixPath } from '../binary/ids.ts';
import { SCHEMA_VERSION, type AssetEntry, type LayoutJson, type Manifest } from '../schemas/bundle.schema.ts';
import { toBytes } from '../binary/reader.ts';

export const GENERATOR = 'nw4r-web 0.1.0';

export interface BundleOptions {
  /** guarda os binários originais em raw/ (padrão: true) */
  includeRaw?: boolean;
}
export interface Bundle { manifest: Manifest; files: Map<string, Uint8Array> }

export function detectKind(path: string, data: Uint8Array): AssetKind {
  const ext = path.toLowerCase().slice(path.lastIndexOf('.'));
  if (ext === '.tpl' && isTpl(data)) return 'texture';
  if (ext === '.brfnt' && isBrfnt(data)) return 'font';
  if (BRLAN_EXTENSIONS.includes(ext) && isBrlan(data)) return 'animation';
  if (ext === '.brlyt' && isBrlyt(data)) return 'layout';
  if (ext === '.kcl') return 'collision';
  return 'binary';
}

/** Abre o contêiner (Yaz0 opcional + U8) e expande .arc aninhados em "<nome>.d/". */
export function unpackContainer(data: Uint8Array): { files: U8File[]; compression: 'yaz0' | 'none'; container: 'u8' | 'file' } {
  let bytes = data;
  let compression: 'yaz0' | 'none' = 'none';
  if (isYaz0(bytes)) { bytes = yaz0Decompress(bytes); compression = 'yaz0'; }
  if (!isU8(bytes)) return { files: [], compression, container: 'file' };
  return { files: parseU8(bytes).files, compression, container: 'u8' };
}

export function expandNested(files: U8File[], depth = 0): U8File[] {
  const out: U8File[] = [];
  for (const f of files) {
    let d = f.data;
    if (depth < 4 && isYaz0(d)) { try { d = yaz0Decompress(d); } catch { /* mantém como binário */ } }
    if (depth < 4 && isU8(d)) {
      const inner = expandNested(parseU8(d).files, depth + 1);
      out.push(...inner.map((x) => ({ path: `${f.path}.d/${x.path}`, data: x.data })));
    } else {
      out.push({ path: f.path, data: f.data });
    }
  }
  return out;
}

const commonPrefix = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

/** Converte um conjunto de arquivos (já desempacotados) em bundle web. */
export function convertFileSet(name: string, input: U8File[], meta: Omit<Manifest['source'], 'name'>, opts: BundleOptions = {}): Bundle {
  const includeRaw = opts.includeRaw ?? true;
  const items = expandNested(input)
    .map((f) => ({ path: toPosixPath(f.path), data: f.data }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // fase 1: IDs determinísticos e índice de nomes para resolver referências
  type Item = { path: string; data: Uint8Array; kind: AssetKind; id: string };
  const all: Item[] = items.map((f) => {
    const kind = detectKind(f.path, f.data);
    return { ...f, kind, id: makeAssetId(kind, f.path) };
  });
  const byName = new Map<string, Item[]>();
  for (const it of all) {
    const k = `${it.kind}:${basename(it.path).toLowerCase()}`;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(it);
  }
  const resolverFor = (from: string) => (refName: string, kind: 'texture' | 'font' | 'layout'): string | null => {
    const cands = byName.get(`${kind}:${basename(refName).toLowerCase()}`);
    if (!cands?.length) return null;
    // prefere o candidato mais próximo na árvore (mesmo .arc)
    return [...cands].sort((a, b) => commonPrefix(b.path, from) - commonPrefix(a.path, from) || (a.path < b.path ? -1 : 1))[0].id;
  };
  const layoutFor = (animPath: string): string | null => {
    const stem = stripExt(basename(animPath)).toLowerCase();
    let best: Item | null = null;
    for (const it of all) {
      if (it.kind !== 'layout') continue;
      const ls = stripExt(basename(it.path)).toLowerCase();
      if (stem.startsWith(ls) && (!best || ls.length > stripExt(basename(best.path)).length
        || (ls.length === stripExt(basename(best.path)).length && commonPrefix(it.path, animPath) > commonPrefix(best.path, animPath)))) best = it;
    }
    return best ? basename(best.path) : null;
  };

  // nomes-base iguais (ex.: a.tpl e a.brfnt) usam o nome completo para não colidir
  const stemCount = new Map<string, number>();
  for (const it of all) stemCount.set(stripExt(it.path).toLowerCase(), (stemCount.get(stripExt(it.path).toLowerCase()) ?? 0) + 1);

  // fase 2: conversão
  const files = new Map<string, Uint8Array>();
  const assets: AssetEntry[] = [];
  const enc = new TextEncoder();
  for (const it of all) {
    const outBase = `assets/${(stemCount.get(stripExt(it.path).toLowerCase()) ?? 0) > 1 ? it.path : stripExt(it.path)}`;
    const raw = includeRaw || it.kind === 'binary' ? `raw/${it.path}` : null;
    if (raw) files.set(raw, it.data);
    const resolve = resolverFor(it.path);
    const entry: AssetEntry = { assetId: it.id, kind: it.kind, source: it.path, main: raw ?? `raw/${it.path}`, files: [], refs: [], unresolved: [], raw };
    try {
      let conv: { main: string; files: Map<string, Uint8Array> } | null = null;
      if (it.kind === 'texture') conv = textureToWeb(it.data, it.path, outBase);
      else if (it.kind === 'font') conv = fontToWeb(it.data, it.path, outBase);
      else if (it.kind === 'collision') conv = collisionToWeb(it.data, it.path, outBase);
      else if (it.kind === 'animation') {
        const r = animToWeb(it.data, it.path, outBase, resolve, layoutFor(it.path));
        for (const t of r.json.textures) t.ref ? entry.refs.push(t.ref) : entry.unresolved.push(t.name);
        if (r.json.layout) r.json.layout.ref ? entry.refs.push(r.json.layout.ref) : entry.unresolved.push(r.json.layout.name);
        conv = r;
      } else if (it.kind === 'layout') {
        const lyt = parseBrlyt(it.data);
        const json: LayoutJson = {
          format: 'nw4r-layout-refs', version: SCHEMA_VERSION, assetId: it.id, source: it.path,
          textures: lyt.textures.map((n) => ({ name: n, ref: resolve(n, 'texture') })),
          fonts: lyt.fonts.map((n) => ({ name: n, ref: resolve(n, 'font') })),
          materials: lyt.materials.map((m) => m.name),
          panes: flattenPanes(lyt.root).map((p) => p.name),
          screen: { width: lyt.width, height: lyt.height, centered: lyt.centered },
          materialDefs: lyt.materials,
          root: lyt.root,
          groups: lyt.groups,
        };
        for (const t of [...json.textures, ...json.fonts]) t.ref ? entry.refs.push(t.ref) : entry.unresolved.push(t.name);
        const main = `${outBase}.layout.json`;
        conv = { main, files: new Map([[main, enc.encode(JSON.stringify(json))]]) };
      }
      if (conv) {
        for (const [p, b] of conv.files) files.set(p, b);
        entry.main = conv.main;
        entry.files = [...conv.files.keys()];
      } else {
        entry.files = [entry.main];
      }
    } catch (e) {
      // falha de conversão: mantém o original como binário, com o erro registrado
      entry.kind = 'binary';
      entry.assetId = makeAssetId('binary', it.path);
      entry.error = (e as Error).message;
      entry.refs = []; entry.unresolved = [];
      entry.raw = `raw/${it.path}`;
      files.set(entry.raw, it.data);
      entry.main = entry.raw;
      entry.files = [entry.raw];
    }
    entry.refs = [...new Set(entry.refs)].sort();
    entry.unresolved = [...new Set(entry.unresolved)].sort();
    if (entry.raw && entry.files.includes(entry.raw)) entry.raw = entry.kind === 'binary' ? null : entry.raw;
    assets.push(entry);
  }
  // remove referências a assets que viraram binário por erro
  const ids = new Set(assets.map((a) => a.assetId));
  for (const a of assets) {
    const broken = a.refs.filter((r) => !ids.has(r));
    if (broken.length) { a.refs = a.refs.filter((r) => ids.has(r)); a.unresolved.push(...broken.map((b) => `asset-invalido:${b}`)); }
  }
  const manifest: Manifest = { format: 'nw4r-web-bundle', version: SCHEMA_VERSION, generator: GENERATOR, source: { name, ...meta }, assets };
  files.set('manifest.json', enc.encode(JSON.stringify(manifest, null, 1)));
  return { manifest, files };
}

/** .carc/.arc (bytes) -> bundle. */
export function convertContainer(name: string, data: ArrayBuffer | ArrayBufferView, opts: BundleOptions = {}): Bundle {
  const bytes = toBytes(data);
  const { files, compression, container } = unpackContainer(bytes);
  if (container !== 'u8') return convertFileSet(name, [{ path: name, data: compression === 'yaz0' ? yaz0Decompress(bytes) : bytes }], { container: 'file', compression }, opts);
  return convertFileSet(name, files, { container, compression }, opts);
}

/** Empacota o bundle em zip determinístico (datas fixas, ordem estável). */
export function bundleToZip(bundle: Bundle): Uint8Array {
  const z: Zippable = {};
  const mtime = new Date(Date.UTC(1980, 0, 1));
  for (const p of [...bundle.files.keys()].sort()) {
    const data = bundle.files.get(p)!;
    const stored = /\.(png|glb)$/i.test(p);
    z[p] = [data, { level: stored ? 0 : 6, mtime }];
  }
  return zipSync(z, { mtime });
}
