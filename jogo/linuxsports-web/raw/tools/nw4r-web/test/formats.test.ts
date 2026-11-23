import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { findFiles, hasGameData, read } from './helpers.ts';
import { parseTpl, decodeTplImage, TPL_MAGIC } from '../src/parsers/tpl.ts';
import { parseBrfnt } from '../src/parsers/brfnt.ts';
import { parseBrlan } from '../src/parsers/brlan.ts';
import { parseKcl } from '../src/parsers/kcl.ts';
import { parseU8 } from '../src/parsers/u8.ts';
import { textureToWeb } from '../src/serializers/texture.ts';
import { fontToWeb } from '../src/serializers/font.ts';
import { animToWeb } from '../src/serializers/anim.ts';
import { collisionToGlb } from '../src/serializers/collision.ts';
import { decodePng } from '../src/binary/png.ts';
import { AnimJson, FontJson, TexJson, CollisionMeshExtras } from '../src/schemas/bundle.schema.ts';
import { evaluateTrack, hermite, hermiteToBezier } from '../src/web-runtime/curves.ts';

const require = createRequire(import.meta.url);
const validator = require('gltf-validator') as { validateBytes(b: Uint8Array, o?: object): Promise<{ issues: { numErrors: number; numWarnings: number; messages: { code: string; severity: number; message: string }[] } }> };
const dec = new TextDecoder();
const real = describe.skipIf(!hasGameData);

real('TPL (dados reais)', () => {
  const files = findFiles('.tpl');
  it('todos os .tpl têm cabeçalho válido e decodificam', () => {
    expect(files.length).toBeGreaterThan(100);
    const formats = new Set<string>();
    for (const f of files) {
      const b = read(f);
      expect(new DataView(b.buffer, b.byteOffset).getUint32(0)).toBe(TPL_MAGIC);
      const tpl = parseTpl(b);
      for (const img of tpl.images) {
        formats.add(img.formatName);
        expect(decodeTplImage(tpl, img).length).toBe(img.width * img.height * 4);
      }
    }
    expect([...formats]).toEqual(expect.arrayContaining(['CMPR', 'RGB5A3', 'RGBA8', 'I4', 'I8', 'IA4', 'IA8']));
  });
  it('gera PNG + .tex.json válidos pelo schema', () => {
    const f = files.find((p) => /CMPR|Image/.test(p)) ?? files[0];
    const out = textureToWeb(read(f), 'timg/x.tpl', 'assets/timg/x');
    const meta = TexJson.parse(JSON.parse(dec.decode(out.files.get(out.main)!)));
    const png = decodePng(out.files.get(meta.images[0].file)!);
    expect([png.width, png.height]).toEqual([meta.images[0].width, meta.images[0].height]);
    expect([33071, 10497, 33648]).toContain(meta.images[0].webgl.wrapS);
  });
});

real('BRFNT (dados reais)', () => {
  const files = findFiles('.brfnt');
  it('lê FINF/TGLP/CWDH/CMAP e gera BMFont coerente', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const font = parseBrfnt(read(f));
      expect(font.sections[0]).toBe('FINF');
      expect(font.sections).toEqual(expect.arrayContaining(['TGLP', 'CWDH', 'CMAP']));
      const out = fontToWeb(read(f), 'font/x.brfnt', 'assets/font/x');
      const json = FontJson.parse(JSON.parse(dec.decode(out.files.get(out.main)!)));
      const png = decodePng(out.files.get(json.pages[0])!);
      expect([png.width, png.height]).toEqual([json.common.scaleW, json.common.scaleH]);
      expect(json.chars.length).toBeGreaterThan(50);
      const A = json.chars.find((c) => c.char === 'A');
      expect(A).toBeDefined();
      // o glifo "A" tem pixels visíveis dentro do retângulo exportado
      let ink = 0;
      for (let y = A!.y; y < A!.y + A!.height; y++) for (let x = A!.x; x < A!.x + A!.width; x++) ink += png.rgba[(y * png.width + x) * 4 + 3];
      expect(ink).toBeGreaterThan(0);
      for (const c of json.chars) expect(c.x + c.width).toBeLessThanOrEqual(json.common.scaleW);
    }
  });
});

real('BRLAN (dados reais)', () => {
  const files = findFiles('.brlan');
  it('todos os .brlan têm RLAN/pai1 e quadros ordenados', () => {
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) {
      const a = parseBrlan(read(f));
      expect(a.sections).toContain('pai1');
      for (const t of a.targets) for (const tr of t.tracks) {
        if (tr.group === 'RLTP') for (const k of tr.keys) expect(k.value).toBeLessThan(a.textures.length);
      }
    }
  });
  it('gera .anim.json válido e resolve texturas pelo resolver', () => {
    const f = files.find((p) => parseBrlan(read(p)).textures.length > 0)!;
    const out = animToWeb(read(f), 'anim/x.brlan', 'assets/anim/x', (n, k) => (k === 'texture' ? 'tex_0123456789abcdef' : null));
    const json = AnimJson.parse(JSON.parse(dec.decode(out.files.get(out.main)!)));
    expect(json.textures.every((t) => t.ref === 'tex_0123456789abcdef')).toBe(true);
  });
});

describe('curvas Hermite', () => {
  const track = { group: 'RLPA' as const, groupName: 'pane-srt', index: 0, target: 0, property: 'translateX', interpolation: 'hermite' as const,
    keys: [{ frame: 0, value: 0, slope: 0 }, { frame: 10, value: 10, slope: 0 }] };
  it('interpola com tangentes e mantém as pontas', () => {
    expect(evaluateTrack(track, -5)).toBe(0);
    expect(evaluateTrack(track, 5)).toBeCloseTo(5);
    expect(evaluateTrack(track, 2.5)).toBeCloseTo(1.5625);
    expect(evaluateTrack(track, 99)).toBe(10);
  });
  it('a Bézier equivalente passa pelos mesmos pontos', () => {
    const [p0, p1, p2, p3] = hermiteToBezier(track.keys[0], { frame: 10, value: 10, slope: 2 });
    const t = 0.5, u = 1 - t;
    const y = u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1];
    expect(y).toBeCloseTo(hermite(track.keys[0], { frame: 10, value: 10, slope: 2 }, 5));
  });
  it('degrau mantém o valor até a próxima chave', () => {
    const step = { ...track, interpolation: 'step' as const };
    expect(evaluateTrack(step, 9.9)).toBe(0);
  });
});

real('KCL (dados reais)', () => {
  const files = findFiles('.kcl');
  it.each(files.map((f) => [f.split('/').slice(-1)[0], f]))('%s -> GLB válido pelo gltf-validator', async (_, f) => {
    const kcl = parseKcl(read(f as string));
    expect(kcl.prismCount).toBeGreaterThan(0);
    expect(kcl.triangles.length + kcl.skipped).toBe(kcl.prismCount);
    const { glb, flags, triangles } = collisionToGlb(read(f as string), 'x.kcl');
    expect(new DataView(glb.buffer).getUint32(0, true)).toBe(0x46546c67);
    expect(new DataView(glb.buffer).getUint32(8, true)).toBe(glb.length);
    const report = await validator.validateBytes(glb, { maxIssues: 20 });
    expect(report.issues.messages.filter((m) => m.severity === 0)).toEqual([]);
    const jl = new DataView(glb.buffer).getUint32(12, true);
    const gltf = JSON.parse(dec.decode(glb.subarray(20, 20 + jl)));
    let sum = 0;
    for (const m of gltf.meshes) { const e = CollisionMeshExtras.parse(m.extras); sum += e.triangleCount; expect(flags.get(e.collisionFlag)).toBe(e.triangleCount); }
    expect(sum).toBe(triangles);
  });
});

real('U8 (dados reais)', () => {
  it('todos os .arc abrem', () => {
    for (const f of findFiles('.arc')) expect(parseU8(read(f)).files.length).toBeGreaterThan(0);
  });
});
