#!/usr/bin/env -S npx tsx
/**
 * nw4r-web CLI (Node.js only — the library itself is runtime-agnostic).
 *
 *   npx tsx src/cli.ts convert <input> -o <outDir> [--zip] [--unpacked] [--quiet]
 *   npx tsx src/cli.ts validate <bundle.zip | bundleDir>
 *   npx tsx src/cli.ts inspect <file>
 *
 * <input> may be a .carc/.arc/.szs archive, a single .tpl/.brfnt/.brlan/.kcl, or a
 * directory (treated as an already-extracted archive).
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { type Bundle, buildBundle, bundleToZip, convertFile, detectFormat } from './convert.ts';
import { normalizePath } from './core/ids.ts';
import { parseBrfnt } from './parsers/brfnt.ts';
import { parseBrlan } from './parsers/brlan.ts';
import { parseKcl } from './parsers/kcl.ts';
import { parseTpl } from './parsers/tpl.ts';
import { parseU8 } from './parsers/u8.ts';
import { decompressYaz0, isYaz0 } from './parsers/yaz0.ts';
import { bundleFilesFromMap, validateBundle } from './schemas/bundle.schema.ts';

const USAGE = `Usage:
  nw4r-web convert <input> -o <outDir> [--zip] [--unpacked] [--quiet]
      Archives (.carc/.arc/.szs or a directory) -> <outDir>/<name>.zip (add --unpacked for loose files)
      Single files (.tpl/.brfnt/.brlan/.kcl)    -> loose files + manifest.json in <outDir> (add --zip for a zip)
  nw4r-web validate <bundle.zip | bundleDir>
  nw4r-web inspect <file>`;

interface Args { _: string[]; flags: Set<string>; out?: string }

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a.startsWith('--')) args.flags.add(a.slice(2));
    else if (a === '-h') args.flags.add('help');
    else args._.push(a);
  }
  return args;
}

async function walk(dir: string, root = dir): Promise<Array<{ path: string; data: Uint8Array }>> {
  const out: Array<{ path: string; data: Uint8Array }> = [];
  for (const ent of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full, root)));
    else if (ent.isFile()) out.push({ path: normalizePath(path.relative(root, full)), data: new Uint8Array(await readFile(full)) });
  }
  return out;
}

async function writeBundleFiles(bundle: Bundle, dir: string): Promise<void> {
  for (const [p, data] of bundle.files) {
    const target = path.join(dir, ...p.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

async function cmdConvert(args: Args): Promise<number> {
  const input = args._[1];
  if (!input || !args.out) { console.error(USAGE); return 2; }
  const quiet = args.flags.has('quiet');
  const st = await stat(input);
  const name = path.basename(input).replace(/\.(carc|arc|szs|u8)$/i, '') || 'bundle';
  const t0 = performance.now();
  const onAsset = quiet ? undefined : (a: { kind: string; sourcePath: string; primary: string }) =>
    console.log(`  ${a.kind.padEnd(9)} ${a.sourcePath} -> ${a.primary}`);

  let bundle: Bundle;
  let isArchive: boolean;
  if (st.isDirectory()) {
    const files = await walk(input);
    bundle = buildBundle(files, { name: path.basename(input), format: 'directory', compression: 'none', byteLength: files.reduce((s, f) => s + f.data.length, 0) }, { onAsset });
    isArchive = true;
  } else {
    const data = new Uint8Array(await readFile(input));
    bundle = convertFile(path.basename(input), data, { onAsset });
    isArchive = bundle.manifest.source.format === 'u8';
  }

  await mkdir(args.out, { recursive: true });
  const wantZip = isArchive || args.flags.has('zip');
  const wantLoose = !isArchive || args.flags.has('unpacked');
  const written: string[] = [];
  if (wantZip) {
    const zipPath = path.join(args.out, `${name}.zip`);
    await writeFile(zipPath, bundleToZip(bundle));
    written.push(zipPath);
  }
  if (wantLoose) {
    const dir = isArchive ? path.join(args.out, name) : args.out;
    await writeBundleFiles(bundle, dir);
    written.push(path.join(dir, 'manifest.json'));
  }

  const { issues } = validateBundle(bundle.manifest, bundleFilesFromMap(bundle.files));
  const errors = issues.filter((i) => i.severity === 'error');
  const counts = bundle.manifest.assets.reduce<Record<string, number>>((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {});
  console.log(`\n${bundle.manifest.assets.length} assets (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  for (const w of bundle.manifest.warnings.slice(0, quiet ? 0 : 20)) console.warn(`  warning: ${w.path}: ${w.message}`);
  if (bundle.manifest.warnings.length > 20 && !quiet) console.warn(`  ... ${bundle.manifest.warnings.length - 20} more warnings in manifest.json`);
  for (const e of errors) console.error(`  error: ${e.path}: ${e.message}`);
  for (const w of written) console.log(`wrote ${w}`);
  return errors.length ? 1 : 0;
}

async function cmdValidate(args: Args): Promise<number> {
  const target = args._[1];
  if (!target) { console.error(USAGE); return 2; }
  let files: Map<string, Uint8Array>;
  if ((await stat(target)).isDirectory()) files = new Map((await walk(target)).map((f) => [f.path, f.data]));
  else files = new Map(Object.entries(unzipSync(new Uint8Array(await readFile(target)))).map(([k, v]) => [normalizePath(k), v]));
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) { console.error('manifest.json not found at bundle root'); return 1; }
  const { manifest, issues } = validateBundle(JSON.parse(new TextDecoder().decode(manifestBytes)), bundleFilesFromMap(files));
  for (const i of issues) (i.severity === 'error' ? console.error : console.warn)(`${i.severity}: ${i.path}: ${i.message}`);
  const errors = issues.filter((i) => i.severity === 'error').length;
  console.log(`${manifest?.assets.length ?? 0} assets, ${errors} errors, ${issues.length - errors} warnings`);
  return errors ? 1 : 0;
}

async function cmdInspect(args: Args): Promise<number> {
  const file = args._[1];
  if (!file) { console.error(USAGE); return 2; }
  let data: Uint8Array = new Uint8Array(await readFile(file));
  const yaz0 = isYaz0(data);
  if (yaz0) data = decompressYaz0(data);
  const fmt = detectFormat(file, data);
  const strip = (_k: string, v: unknown) =>
    v instanceof Uint8Array || v instanceof Float32Array ? `<${v.constructor.name} ${v.length}>` : v instanceof Map ? `<Map ${v.size}>` : v;
  let info: unknown;
  switch (fmt) {
    case 'u8': { const a = parseU8(data); info = { header: a.header, directories: a.directories, files: a.files.map((f) => ({ path: f.path, size: f.data.length, format: detectFormat(f.path, f.data) })) }; break; }
    case 'tpl': info = parseTpl(data); break;
    case 'brfnt': { const f = parseBrfnt(data, { decodeSheets: false }); info = { ...f, glyphCount: f.charMap.size }; break; }
    case 'brlan': info = parseBrlan(data); break;
    case 'kcl': { const k = parseKcl(data); info = { header: k.header, vertices: k.positions.length / 3, normals: k.normals.length / 3, prisms: k.prisms.length }; break; }
    default: info = { size: data.length };
  }
  console.log(JSON.stringify({ file, format: fmt, yaz0, info }, strip, 2));
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.flags.has('help')) { console.log(USAGE); return cmd ? 0 : 2; }
  if (cmd === 'convert') return cmdConvert(args);
  if (cmd === 'validate') return cmdValidate(args);
  if (cmd === 'inspect') return cmdInspect(args);
  console.error(`unknown command "${cmd}"\n${USAGE}`);
  return 2;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
