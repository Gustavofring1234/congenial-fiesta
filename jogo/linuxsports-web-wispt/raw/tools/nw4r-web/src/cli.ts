#!/usr/bin/env node
/**
 * nw4r-web — CLI (Node).
 *   npx tsx src/cli.ts convert <entrada> -o <pasta_saida> [--no-raw]
 *   npx tsx src/cli.ts validate <bundle.zip | manifest.json>
 *   npx tsx src/cli.ts info <arquivo>
 * Entrada: .carc/.arc/.szs (Yaz0+U8), pasta extraída, .tpl, .brfnt, .brlan, .brlyt ou .kcl.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { bundleToZip, convertContainer, convertFileSet } from './serializers/bundle.ts';
import { textureToWeb } from './serializers/texture.ts';
import { fontToWeb } from './serializers/font.ts';
import { animToWeb } from './serializers/anim.ts';
import { collisionToGlb } from './serializers/collision.ts';
import { validateBundle } from './schemas/bundle.schema.ts';
import { parseBrlytRefs } from './parsers/brlyt.ts';
import { parseTpl } from './parsers/tpl.ts';
import { parseBrfnt } from './parsers/brfnt.ts';
import { parseBrlan } from './parsers/brlan.ts';
import { parseKcl } from './parsers/kcl.ts';
import { isYaz0, yaz0Decompress } from './parsers/yaz0.ts';
import { isU8, parseU8 } from './parsers/u8.ts';
import { stripExt } from './binary/ids.ts';

function usage(code = 1): never {
  console.log(`uso:
  nw4r-web convert <entrada> -o <pasta_saida> [--no-raw]
  nw4r-web validate <bundle.zip | manifest.json>
  nw4r-web info <arquivo>`);
  process.exit(code);
}

function writeAll(outDir: string, files: Map<string, Uint8Array>) {
  for (const [p, b] of files) {
    const dest = join(outDir, ...p.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, b);
  }
}

/** Lê uma pasta extraída. Se existir "x.arc" e "x.arc.d/", usa só o .arc (evita duplicar). */
function readDir(root: string): { path: string; data: Uint8Array }[] {
  const out: { path: string; data: Uint8Array }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        if (n.endsWith('.d') && existsSync(join(d, n.slice(0, -2)))) continue;
        walk(p);
      } else out.push({ path: relative(root, p).split(sep).join('/'), data: readFileSync(p) });
    }
  };
  walk(root);
  return out;
}

function report(files: Map<string, Uint8Array>, manifest?: { assets: { kind: string; error?: string; unresolved: string[] }[] }) {
  if (manifest) {
    const kinds: Record<string, number> = {};
    for (const a of manifest.assets) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
    const errs = manifest.assets.filter((a) => a.error);
    const unres = manifest.assets.reduce((s, a) => s + a.unresolved.length, 0);
    console.log(`assets: ${JSON.stringify(kinds)}; falhas de conversão: ${errs.length}; referências externas não resolvidas: ${unres}`);
    for (const e of errs.slice(0, 10)) console.log(`  falha: ${e.error}`);
  }
  console.log(`${files.size} arquivos gerados`);
}

function convert(input: string, outDir: string, includeRaw: boolean) {
  const st = statSync(input);
  const name = basename(input);
  mkdirSync(outDir, { recursive: true });
  if (st.isDirectory()) {
    const bundle = convertFileSet(name, readDir(input), { container: 'directory', compression: 'none' }, { includeRaw });
    const zip = join(outDir, `${name}.zip`);
    writeFileSync(zip, bundleToZip(bundle));
    report(bundle.files, bundle.manifest);
    console.log(`-> ${zip}`);
    return;
  }
  const data = readFileSync(input);
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  const base = stripExt(name);
  if (['.carc', '.arc', '.szs', '.u8'].includes(ext) || isYaz0(data) || isU8(data)) {
    const bundle = convertContainer(name, data, { includeRaw });
    const zip = join(outDir, `${name}.zip`);
    writeFileSync(zip, bundleToZip(bundle));
    report(bundle.files, bundle.manifest);
    console.log(`-> ${zip}`);
    return;
  }
  let files: Map<string, Uint8Array>;
  if (ext === '.tpl') files = textureToWeb(data, name, base).files;
  else if (ext === '.brfnt') files = fontToWeb(data, name, base).files;
  else if (ext === '.brlan') files = animToWeb(data, name, base, () => null).files;
  else if (ext === '.kcl') files = new Map([[`${base}.glb`, collisionToGlb(data, name).glb]]);
  else if (ext === '.brlyt') files = new Map([[`${base}.layout-refs.json`, new TextEncoder().encode(JSON.stringify(parseBrlytRefs(data), null, 1))]]);
  else throw new Error(`formato não suportado: ${name}`);
  writeAll(outDir, files);
  report(files);
  for (const p of files.keys()) console.log(`-> ${join(outDir, p)}`);
}

function validate(input: string) {
  let read: (p: string) => Uint8Array | undefined;
  let manifest: unknown;
  if (input.endsWith('.zip')) {
    const files = unzipSync(readFileSync(input));
    read = (p) => files[p];
    if (!files['manifest.json']) throw new Error('zip sem manifest.json');
    manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  } else {
    const root = dirname(resolve(input));
    read = (p) => { const f = join(root, ...p.split('/')); return existsSync(f) ? readFileSync(f) : undefined; };
    manifest = JSON.parse(readFileSync(input, 'utf8'));
  }
  const r = validateBundle(manifest, read);
  for (const w of r.warnings.slice(0, 20)) console.log(`aviso: ${w}`);
  if (r.warnings.length > 20) console.log(`... mais ${r.warnings.length - 20} avisos`);
  for (const e of r.errors) console.log(`ERRO: ${e}`);
  console.log(r.ok ? `válido (${r.warnings.length} avisos)` : `inválido: ${r.errors.length} erros`);
  if (!r.ok) process.exitCode = 2;
}

function info(input: string) {
  const d = new Uint8Array(readFileSync(input));
  const ext = input.toLowerCase().slice(input.lastIndexOf('.'));
  const show = (o: unknown) => console.log(JSON.stringify(o, (_, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v instanceof Map ? `<Map ${v.size}>` : v), 1).slice(0, 4000));
  if (isYaz0(d) || isU8(d)) {
    const u = isYaz0(d) ? yaz0Decompress(d) : d;
    const a = parseU8(u);
    show({ yaz0: isYaz0(d), files: a.files.map((f) => `${f.path} (${f.data.length})`) });
  } else if (ext === '.tpl') show(parseTpl(d).images);
  else if (ext === '.brfnt') { const f = parseBrfnt(d); show({ ...f, bytes: undefined, chars: f.charMap.size }); }
  else if (ext === '.brlan') { const a = parseBrlan(d); show({ frameSize: a.frameSize, loop: a.loop, textures: a.textures, targets: a.targets.map((t) => `${t.kind}:${t.name} (${t.tracks.length} trilhas)`) }); }
  else if (ext === '.kcl') { const k = parseKcl(d); show({ ...k, triangles: k.triangles.length }); }
  else if (ext === '.brlyt') show(parseBrlytRefs(d));
  else throw new Error('formato não reconhecido');
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'convert') {
    const input = rest.find((a, i) => !a.startsWith('-') && rest[i - 1] !== '-o');
    const oi = rest.indexOf('-o');
    if (!input || oi < 0 || !rest[oi + 1]) usage();
    convert(input, rest[oi + 1], !rest.includes('--no-raw'));
  } else if (cmd === 'validate' && rest[0]) validate(rest[0]);
  else if (cmd === 'info' && rest[0]) info(rest[0]);
  else usage(cmd === '--help' || cmd === '-h' ? 0 : 1);
} catch (e) {
  console.error(`erro: ${(e as Error).message}`);
  process.exit(1);
}
