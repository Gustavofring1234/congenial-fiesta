/**
 * Integration checks against real game files, when available locally.
 * Set NW4R_SAMPLES=/path/to/extracted/game to point elsewhere; skipped otherwise.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleToZip, convertFile } from '../src/convert.ts';
import { parseBrfnt } from '../src/parsers/brfnt.ts';
import { parseBrlan } from '../src/parsers/brlan.ts';
import { kclTriangles, parseKcl } from '../src/parsers/kcl.ts';
import { parseTpl } from '../src/parsers/tpl.ts';
import { bundleFilesFromMap, validateBundle } from '../src/schemas/bundle.schema.ts';
import { WebAssetLoader } from '../src/web-runtime/WebAssetLoader.ts';

const ROOT = process.env.NW4R_SAMPLES ?? path.resolve(__dirname, '../../linuxsports-game');

function find(dir: string, re: RegExp, limit: number, out: string[] = []): string[] {
  if (out.length >= limit || !existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) find(full, re, limit, out);
    else if (re.test(name)) out.push(full);
    if (out.length >= limit) break;
  }
  return out;
}

describe.skipIf(!existsSync(ROOT))(`real samples (${ROOT})`, () => {
  it('TPL headers decode for every image', () => {
    const files = find(ROOT, /\.tpl$/i, 150);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const tpl = parseTpl(readFileSync(f));
      for (const img of tpl.images) expect(img.mipmaps[0].rgba.length).toBe(img.width * img.height * 4);
    }
  });

  it('BRFNT / BRLAN / KCL headers are consistent', () => {
    for (const f of find(ROOT, /\.brfnt$/i, 5)) {
      const font = parseBrfnt(readFileSync(f));
      expect(font.glyphs.sheets).toHaveLength(font.glyphs.sheetCount);
      expect(font.charMap.size).toBeGreaterThan(0);
    }
    for (const f of find(ROOT, /\.brl(an|pa|vi|mc|ts|tp|vc)$/i, 100)) {
      const lan = parseBrlan(readFileSync(f));
      expect(lan.sections).toContain('pai1');
    }
    for (const f of find(ROOT, /\.kcl$/i, 3)) {
      const kcl = parseKcl(readFileSync(f));
      const tris = kclTriangles(kcl);
      expect(tris.length).toBeGreaterThan(kcl.prisms.length * 0.95);
    }
  });

  it('U8 archives convert into valid bundles that the web loader accepts', async () => {
    for (const f of find(ROOT, /\.arc$/i, 6)) {
      const bundle = convertFile(path.basename(f), readFileSync(f));
      const { issues } = validateBundle(bundle.manifest, bundleFilesFromMap(bundle.files));
      expect(issues.filter((i) => i.severity === 'error'), f).toEqual([]);
      const loader = await WebAssetLoader.fromZip(bundleToZip(bundle, 1));
      await loader.loadAll();
    }
  });
});
