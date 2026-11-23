/**
 * Monta um projeto web único e interligado a partir do linuxsports-game (Node.js).
 *
 *   npx tsx src/build-project.ts <raiz_do_jogo> -o <pasta_saida>
 *
 * Tudo vai para UM manifest.json global, para que referências entre contêineres funcionem
 * (ex.: layouts de um .arc usando fontes de Font/font.carc):
 *   - .tpl/.brfnt/.brlan/.brlyt/.kcl  -> convertidos pela biblioteca (assets/...)
 *   - .glb já gerados de .brres        -> assets 'model' (+ .model.json com texturas e animações)
 *   - estágios (*.carc com .brres/.kcl) -> assets 'scene' (modelos + colisão + .pmp + luz)
 *   - demais binários                   -> 'binary' (raw/...), com refs onde há ligação conhecida
 *     (.brres -> modelos, .breff -> .breft, .plmap -> .bti)
 *   - index/ com índices auxiliares: animações por layout, referências do código, apelidos de textura.
 */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { convertFileSet } from './serializers/bundle.ts';
import { makeAssetId, toPosixPath } from './binary/ids.ts';
import { parseBrresIndex } from './parsers/brres-index.ts';
import { parsePmp } from './parsers/pmp.ts';
import { FORMAT_NOTES, noteFor } from './format-notes.ts';
import { fileURLToPath } from 'node:url';
import { type AssetEntry, type ModelJson, type SceneJson, SCHEMA_VERSION, validateBundle } from './schemas/bundle.schema.ts';

// Só dependências de terceiros e cache ficam de fora. models_glb entra como assets 'model' (não duplicado).
const EXCLUDE_DIRS = new Set(['node_modules', '__pycache__', 'models_glb']);
const SCENE_DATA_EXT = new Set(['.pmp', '.plight', '.plmap', '.pblm', '.pmmisc', '.bti']);
const enc = new TextEncoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 1));
const ext = (p: string) => p.slice(p.lastIndexOf('.')).toLowerCase();
const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const stemOf = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of (await readdir(path.join(root, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) out.push(...(await walk(root, r))); }
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function sportOf(p: string): string {
  return /(?:maps|minigames)\/([^/]+)/.exec(p)?.[1] ?? 'shared';
}

/** Pasta do estágio = o ancestral mais próximo terminado em .carc. */
function stageOf(p: string): string | null {
  const parts = p.split('/');
  for (let i = parts.length - 2; i >= 0; i--) if (parts[i].endsWith('.carc')) return parts.slice(0, i + 1).join('/');
  return null;
}

export async function buildProject(gameRoot: string, outDir: string, log = console.log) {
  const t0 = performance.now();
  const all = await walk(gameRoot);
  const fileSet = new Set(all);
  // .arc cru com a pasta .arc.d extraída ao lado: usa só a pasta (evita duplicar tudo)
  const dupArcs = all.filter((p) => ext(p) === '.arc' && all.some((q) => q.startsWith(`${p}.d/`)));
  const dupSet = new Set(dupArcs);
  const inputs = all.filter((p) => !dupSet.has(p));
  log(`entrada: ${all.length} arquivos (${dupArcs.length} .arc já extraídos entram só como original, sem reconverter)`);

  const files = await Promise.all(inputs.map(async (p) => ({ path: p, data: new Uint8Array(await readFile(path.join(gameRoot, p))) })));
  const bundle = convertFileSet('linuxsports-game', files, { container: 'directory', compression: 'none' }, { includeRaw: false });
  const out = bundle.files;
  const assets = bundle.manifest.assets;
  const bySource = new Map(assets.map((a) => [a.source, a]));
  for (const p of dupArcs) {
    const raw = `raw/${p}`;
    out.set(raw, new Uint8Array(await readFile(path.join(gameRoot, p))));
    // o conteúdo é o mesmo da pasta .arc.d: liga o original aos assets extraídos
    const inner = assets.filter((a) => a.source.startsWith(`${p}.d/`)).map((a) => a.assetId);
    const entry: AssetEntry = { assetId: makeAssetId('binary', p), kind: 'binary', source: p, main: raw, files: [raw], refs: inner, unresolved: [], raw: null };
    assets.push(entry);
    bySource.set(p, entry);
  }
  log(`conversão base: ${assets.length} assets`);

  // ---------------------------------------------------------------- modelos (.brres -> .glb existente)
  const modelIds = new Map<string, string[]>(); // brres -> assetIds
  let animUnassigned = 0;
  for (const a of assets.filter((x) => ext(x.source) === '.brres')) {
    const idx = parseBrresIndex(files.find((f) => f.path === a.source)!.data);
    const ids: string[] = [];
    for (const model of idx.models) {
      const base = a.source.replace(/\.brres$/, '');
      const cands = [`assets/models_glb/${base}__${model}.glb`, `assets/models_glb/${base}.glb`];
      const glbSrc = cands.find((c) => existsSync(path.join(gameRoot, c)));
      if (!glbSrc) { a.unresolved.push(`glb:${model}`); continue; }
      const source = `${a.source}/${model}`;
      const id = makeAssetId('model', source);
      const glb = `models/${base}__${model}.glb`;
      const meta = `models/${base}__${model}.model.json`;
      // animações: pelo prefixo do nome; com um único modelo no arquivo, todas são dele
      const anims = idx.animations.filter((an) => idx.models.length === 1 || an.name.toLowerCase().startsWith(model.toLowerCase().split('_').slice(0, 2).join('_')));
      const mj: ModelJson = {
        format: 'nw4r-model', version: SCHEMA_VERSION, assetId: id, source, brres: a.source, model, glb,
        textures: idx.textures.map((t) => ({ name: t, foundIn: a.source })),
        animations: anims.map((an) => ({ type: an.type as ModelJson['animations'][number]['type'], name: an.name })),
      };
      out.set(glb, new Uint8Array(await readFile(path.join(gameRoot, glbSrc))));
      out.set(meta, json(mj));
      assets.push({ assetId: id, kind: 'model', source, main: meta, files: [meta, glb], refs: [], unresolved: [], raw: null });
      ids.push(id);
    }
    const assigned = new Set(assets.filter((m) => m.kind === 'model' && ids.includes(m.assetId)).flatMap((m) => JSON.parse(new TextDecoder().decode(out.get(m.main)!)).animations.map((x: { name: string }) => x.name)));
    animUnassigned += idx.animations.filter((an) => !assigned.has(an.name)).length;
    modelIds.set(a.source, ids);
    a.refs.push(...ids);
  }
  log(`modelos: ${[...modelIds.values()].flat().length} .glb ligados a ${modelIds.size} .brres (${animUnassigned} animações 3D sem modelo atribuído)`);

  // ---------------------------------------------------------------- ligações entre binários
  for (const a of assets) {
    const e = ext(a.source);
    if (e === '.breff') {
      const t = bySource.get(`${dirOf(a.source)}/${stemOf(a.source)}.breft`);
      t ? a.refs.push(t.assetId) : a.unresolved.push(`${stemOf(a.source)}.breft`);
    } else if (e === '.plmap') {
      // LTEX lm_0 / lm_1 -> lm_0.bti / lm_1.bti do mesmo estágio ou comuns
      const names = new TextDecoder('latin1').decode(files.find((f) => f.path === a.source)!.data).match(/lm_\d+/g) ?? [];
      for (const n of new Set(names)) {
        const hit = assets.find((b) => b.source.toLowerCase().endsWith(`/${n}.bti`) && sportOf(b.source) === sportOf(a.source))
          ?? assets.find((b) => b.source.toLowerCase().endsWith(`/${n}.bti`));
        hit ? a.refs.push(hit.assetId) : a.unresolved.push(`${n}.bti`);
      }
    }
  }

  // ---------------------------------------------------------------- cenas
  const stages = new Map<string, string[]>();
  for (const p of inputs) {
    const st = stageOf(p);
    if (!st || !['.brres', '.kcl', ...SCENE_DATA_EXT].includes(ext(p))) continue;
    if (!stages.has(st)) stages.set(st, []);
    stages.get(st)!.push(p);
  }
  let objects = 0;
  for (const [st, members] of [...stages].sort()) {
    const brres = members.filter((p) => ext(p) === '.brres');
    if (!brres.length && !members.some((p) => ext(p) === '.kcl')) continue;
    const id = makeAssetId('scene', st);
    const models = brres.flatMap((b) => (modelIds.get(b) ?? []).map((m) => ({ name: assets.find((x) => x.assetId === m)!.source.slice(st.length + 1), ref: m })));
    const collision = members.filter((p) => ext(p) === '.kcl').map((p) => ({ name: p.slice(st.length + 1), ref: bySource.get(p)?.kind === 'collision' ? bySource.get(p)!.assetId : null }));
    const sceneObjects: SceneJson['objects'] = [];
    for (const p of members.filter((m) => ext(m) === '.pmp')) {
      for (const o of parsePmp(files.find((f) => f.path === p)!.data)) {
        sceneObjects.push({ typeId: o.typeId, variant: o.variant, model: null, position: o.position, scale: o.scale, axes: o.axes });
      }
    }
    objects += sceneObjects.length;
    const data = members.filter((p) => SCENE_DATA_EXT.has(ext(p))).map((p) => ({ role: ext(p).slice(1), name: p.slice(st.length + 1), ref: bySource.get(p)?.assetId ?? null }));
    const sj: SceneJson = { format: 'nw4r-scene', version: SCHEMA_VERSION, assetId: id, source: st, sport: sportOf(st), models, collision, objects: sceneObjects, data };
    const main = `scenes/${st}.scene.json`;
    out.set(main, json(sj));
    const refs = [...models.map((m) => m.ref), ...collision.map((c) => c.ref), ...data.map((d) => d.ref)].filter((x): x is string => !!x);
    assets.push({ assetId: id, kind: 'scene', source: st, main, files: [main], refs, unresolved: collision.filter((c) => !c.ref).map((c) => c.name), raw: null });
  }
  log(`cenas: ${assets.filter((a) => a.kind === 'scene').length} (${objects} objetos posicionados de .pmp)`);

  // ---------------------------------------------------------------- índices auxiliares
  const animByLayout: Record<string, string[]> = {};
  for (const a of assets.filter((x) => x.kind === 'animation')) {
    for (const r of a.refs) if (r.startsWith('lyt_')) (animByLayout[r] ??= []).push(a.assetId);
  }
  out.set('index/layout-animations.json', json(animByLayout));

  // alvos de animação que não existem no layout ligado (o player deve ignorá-los)
  const dec = new TextDecoder();
  const byIdAll = new Map(assets.map((a) => [a.assetId, a]));
  const missingTargets: Array<{ animation: string; layout: string; missing: string[] }> = [];
  for (const a of assets.filter((x) => x.kind === 'animation')) {
    const aj = JSON.parse(dec.decode(out.get(a.main)!));
    const lref = aj.layout?.ref ? byIdAll.get(aj.layout.ref) : undefined;
    if (!lref) continue;
    const lj = JSON.parse(dec.decode(out.get(lref.main)!));
    const names = new Set<string>([...lj.panes, ...lj.materials]);
    const missing = aj.targets.map((t: { name: string }) => t.name).filter((n: string) => !names.has(n));
    if (missing.length) missingTargets.push({ animation: a.assetId, layout: lref.assetId, missing });
  }
  out.set('index/anim-missing-targets.json', json(missingTargets));

  // referências do código decompilado: string -> assets
  const codeRefs: Array<{ string: string; assets: string[] }> = [];
  const stringsTsv = path.join(gameRoot, 'src/core/decompiled/strings.tsv');
  if (existsSync(stringsTsv)) {
    const byBase = new Map<string, string[]>();
    for (const a of assets) {
      const b = a.source.slice(a.source.lastIndexOf('/') + 1).toLowerCase();
      byBase.set(b, [...(byBase.get(b) ?? []), a.assetId]);
    }
    const re = /[\w%.\-/]+\.(?:carc|arc|brres|brlyt|brlan|tpl|brfnt|breff|breft|kcl|pmp|plight|plmap|pblm|bti|bmg|brsar|brlmc|brlpa|brlvi)\b/gi;
    const seen = new Set<string>();
    for (const line of readFileSync(stringsTsv, 'utf8').split('\n')) {
      for (const m of line.split('\t').slice(1).join('\t').match(re) ?? []) {
        if (seen.has(m)) continue;
        seen.add(m);
        const base = m.slice(m.lastIndexOf('/') + 1).toLowerCase();
        let hits: string[] = byBase.get(base) ?? [];
        if (!hits.length && base.includes('%')) {
          const rx = new RegExp(`^${base.replace(/[.]/g, '\\.').replace(/%0?\d*[ds]/g, '.+')}$`);
          hits = [...byBase.entries()].filter(([k]) => rx.test(k)).flatMap(([, v]) => v);
        }
        if (!hits.length && /\.(carc|arc)$/.test(base)) {
          hits = assets.filter((a) => a.source.toLowerCase().includes(`/${base}/`) || a.source.toLowerCase().includes(`/${base}.d/`)).map((a) => a.assetId).slice(0, 1);
        }
        codeRefs.push({ string: m, assets: [...new Set(hits)] });
      }
    }
  }
  out.set('index/code-refs.json', json(codeRefs));

  // apelidos semânticos das texturas (docs/mapa_renomeacoes.json). Só entradas não duplicadas:
  // nas duplicadas, o nome veio de OUTRA textura idêntica (ex.: botão do HOME Menu com nome de golfe).
  const aliases: Record<string, string> = {};
  const mapPath = path.join(gameRoot, 'docs/mapa_renomeacoes.json');
  if (existsSync(mapPath)) {
    const m = JSON.parse(readFileSync(mapPath, 'utf8'));
    // os caminhos de textura antigos omitem .carc / .arc.d: compara por uma chave normalizada
    const key = (p: string) => p.replace(/^(assets|textures)\//, '').replaceAll('.carc', '').replaceAll('.arc.d', '').replaceAll('.arc', '')
      .replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    const oldOf = new Map<string, string>(m.movidos.filter((x: { caminho_novo: string | null }) => x.caminho_novo)
      .map((x: { caminho_antigo: string; caminho_novo: string }) => [x.caminho_novo, x.caminho_antigo]));
    const byKey = new Map<string, string>();
    for (const t of m.texturas_renomeadas as Array<{ caminho_antigo: string; caminho_novo: string; duplicata_removida: boolean }>) {
      if (!t.duplicata_removida) byKey.set(key(t.caminho_antigo), t.caminho_novo);
    }
    for (const a of assets) {
      const k = key(oldOf.get(a.source) ?? a.source);
      if (a.kind === 'texture' && byKey.has(k)) aliases[a.assetId] = byKey.get(k)!;
      if (ext(a.source) === '.brres') {
        for (const tex of parseBrresIndex(files.find((f) => f.path === a.source)!.data).textures) {
          const hit = byKey.get(`${k}__${tex.toLowerCase()}`);
          if (hit) aliases[`${a.source}#${tex}`] = hit;
        }
      }
    }
  }
  out.set('index/texture-aliases.json', json(aliases));

  // PNGs renomeados (assets/textures) -> textura .tpl ou .brres de origem
  for (const [key, png] of Object.entries(aliases)) {
    const pngAsset = bySource.get(png);
    if (!pngAsset) continue;
    const target = key.includes('#') ? bySource.get(key.slice(0, key.indexOf('#'))) : assets.find((a) => a.assetId === key);
    if (target) pngAsset.refs.push(target.assetId);
  }

  // inventário: TODO arquivo do projeto, com situação e onde ficou na pasta web
  const glbFiles = existsSync(path.join(gameRoot, 'assets/models_glb')) ? (await walk(path.join(gameRoot, 'assets/models_glb'))).map((p) => `assets/models_glb/${p}`) : [];
  const modelByGlb = new Map<string, string>();
  for (const a of assets.filter((x) => x.kind === 'model')) {
    const mj = JSON.parse(new TextDecoder().decode(out.get(a.main)!)) as ModelJson;
    const base = mj.brres.replace(/\.brres$/, '');
    for (const c of [`assets/models_glb/${base}__${mj.model}.glb`, `assets/models_glb/${base}.glb`]) if (!modelByGlb.has(c)) modelByGlb.set(c, a.assetId);
  }
  const inventory = [];
  for (const p of [...all, ...glbFiles].sort()) {
    const e = ext(p);
    const a = bySource.get(p);
    const mdl = modelByGlb.get(p);
    const st = await stat(path.join(gameRoot, p));
    inventory.push({
      path: p, ext: e, bytes: st.size,
      assetId: a?.assetId ?? mdl ?? null,
      kind: a?.kind ?? (mdl ? 'model' : null),
      output: a ? a.main : mdl ? assets.find((x) => x.assetId === mdl)!.files.find((f) => f.endsWith('.glb')) : null,
      status: a && a.kind !== 'binary' ? 'convertido' : mdl ? 'convertido' : noteFor(e).status,
    });
  }
  out.set('index/inventory.json', json(inventory));
  const formats: Record<string, unknown> = {};
  for (const e of new Set(inventory.map((i) => i.ext))) formats[e] = { ...noteFor(e), count: inventory.filter((i) => i.ext === e).length };
  out.set('index/formats.json', json(formats));
  void FORMAT_NOTES;

  // ---------------------------------------------------------------- manifest + validação
  for (const a of assets) { a.refs = [...new Set(a.refs)].sort(); a.unresolved = [...new Set(a.unresolved)].sort(); }
  bundle.manifest.source = { name: 'linuxsports-game', container: 'directory', compression: 'none' };
  out.set('manifest.json', json(bundle.manifest));
  const v = validateBundle(bundle.manifest, (p) => out.get(p));

  await mkdir(outDir, { recursive: true });
  for (const [p, b] of out) {
    const target = path.join(outDir, ...toPosixPath(p).split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, b);
  }
  // visualizador (viewer/ + three.js local)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const viewerSrc = path.join(here, '..', 'viewer');
  if (existsSync(viewerSrc)) {
    await cp(viewerSrc, path.join(outDir, 'viewer'), { recursive: true });
    const three = path.join(here, '..', 'node_modules', 'three');
    if (existsSync(three)) {
      const v = path.join(outDir, 'viewer', 'vendor', 'three');
      await mkdir(path.join(v, 'addons', 'controls'), { recursive: true });
      await mkdir(path.join(v, 'addons', 'loaders'), { recursive: true });
      await mkdir(path.join(v, 'addons', 'utils'), { recursive: true });
      await cp(path.join(three, 'build', 'three.module.js'), path.join(v, 'three.module.js'));
      await cp(path.join(three, 'examples/jsm/controls/OrbitControls.js'), path.join(v, 'addons/controls/OrbitControls.js'));
      await cp(path.join(three, 'examples/jsm/loaders/GLTFLoader.js'), path.join(v, 'addons/loaders/GLTFLoader.js'));
      await cp(path.join(three, 'examples/jsm/utils/BufferGeometryUtils.js'), path.join(v, 'addons/utils/BufferGeometryUtils.js'));
      await cp(path.join(three, 'LICENSE'), path.join(v, 'LICENSE'));
    }
  }
  const counts: Record<string, number> = {};
  for (const a of assets) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  const summary = {
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    files: out.size,
    bytes: [...out.values()].reduce((s, b) => s + b.length, 0),
    assets: counts,
    refs: assets.reduce((s, a) => s + a.refs.length, 0),
    unresolved: assets.reduce((s, a) => s + a.unresolved.length, 0),
    conversionErrors: assets.filter((a) => a.error).map((a) => ({ source: a.source, error: a.error })),
    codeRefs: { total: codeRefs.length, resolved: codeRefs.filter((c) => c.assets.length).length },
    textureAliases: Object.keys(aliases).length,
    animationsWithMissingTargets: missingTargets.length,
    inventory: { files: inventory.length, byStatus: inventory.reduce<Record<string, number>>((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {}) },
    validation: { ok: v.ok, errors: v.errors.length, warnings: v.warnings.length, firstErrors: v.errors.slice(0, 10) },
  };
  await writeFile(path.join(outDir, 'index', 'build-summary.json'), JSON.stringify(summary, null, 1));
  return { manifest: bundle.manifest, summary, assets: assets as AssetEntry[] };
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const args = process.argv.slice(2);
  const o = args.indexOf('-o');
  const root = args.find((a, i) => !a.startsWith('-') && i !== o + 1);
  if (!root || o < 0) { console.error('uso: npx tsx src/build-project.ts <raiz_do_jogo> -o <pasta_saida>'); process.exit(2); }
  if (!(await stat(root)).isDirectory()) { console.error('a raiz precisa ser uma pasta'); process.exit(2); }
  const { summary } = await buildProject(root, args[o + 1]);
  console.log(JSON.stringify(summary, null, 1));
  process.exitCode = summary.validation.ok ? 0 : 1;
}

