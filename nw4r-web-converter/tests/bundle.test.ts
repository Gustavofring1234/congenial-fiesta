import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { bundleToZip, convertFile } from '../src/convert.ts';
import { makeAssetId } from '../src/core/ids.ts';
import { buildU8 } from '../src/serializers/u8.ts';
import { compressYaz0 } from '../src/serializers/yaz0.ts';
import { AnimMeta, Manifest, bundleFilesFromMap, validateBundle } from '../src/schemas/bundle.schema.ts';
import { AssetLoadError, WebAssetLoader } from '../src/web-runtime/WebAssetLoader.ts';
import { FMT_ID, buildBrfnt, buildBrlan, buildKcl, buildTpl, swizzle } from './fixtures.ts';

const tpl = (v: number) => buildTpl([{ width: 8, height: 4, format: FMT_ID.I8, data: swizzle('I8', 8, 4, () => v) }]);
const anim = buildBrlan({
  frames: 20, loop: false, textures: ['btn_on.tpl', 'shared.tpl', 'elsewhere.tpl'],
  entries: [{ name: 'M_btn', material: true, tags: [{ magic: 'RLTP', targets: [{ target: 0, curve: 1, keys: [[0, 0], [10, 1], [15, 2]] }] }] }],
});
const font = buildBrfnt({
  cellWidth: 6, cellHeight: 6, baseline: 5, columns: 2, rows: 2, sheetWidth: 16, sheetHeight: 16,
  sheets: [swizzle('I4', 16, 16, () => 15)], widths: [[0, 5, 6], [0, 4, 5]],
  cmaps: [{ method: 0, begin: 0x30, end: 0x31, offset: 0 }], lineFeed: 8, ascent: 6,
});
const kcl = buildKcl([{ a: [0, 0, 0], b: [0, 0, 5], c: [5, 0, 0], flag: 2 }]);

/** A realistic .carc: Yaz0( U8{ layout arc with nested U8 menu.arc, font, kcl, unknown files } ). */
function makeCarc(): Uint8Array {
  const nested = buildU8([
    { path: 'arc/anim/menu_in.brlan', data: anim },
    { path: 'arc/timg/btn_on.tpl', data: tpl(1) },
    { path: 'arc/blyt/menu.brlyt', data: new TextEncoder().encode('RLYT-not-converted') },
  ]);
  const u8 = buildU8([
    { path: 'menu.arc', data: nested },
    { path: 'common/timg/shared.tpl', data: tpl(2) },
    { path: 'font/test.brfnt', data: font },
    { path: 'map/course.kcl', data: kcl },
    { path: 'sound/se.brsar', data: Uint8Array.of(1, 2, 3, 4) },
    { path: 'broken/bad.tpl', data: Uint8Array.of(0x00, 0x20, 0xaf, 0x30, 0, 0, 0, 1, 0, 0, 0, 0x0c, 0xff) },
  ]);
  return compressYaz0(u8);
}

describe('carc -> zip bundle', () => {
  const carc = makeCarc();
  const bundle = convertFile('Scene/local.carc', carc);
  const m = bundle.manifest;
  const byPath = new Map(m.assets.map((a) => [a.sourcePath, a]));

  it('unwraps Yaz0 + U8 + nested U8 and mirrors the tree with POSIX paths', () => {
    expect(m.source).toEqual({ name: 'local.carc', format: 'u8', compression: 'yaz0', byteLength: carc.length });
    expect([...byPath.keys()].sort()).toEqual([
      'broken/bad.tpl', 'common/timg/shared.tpl', 'font/test.brfnt', 'map/course.kcl',
      'menu.arc/arc/anim/menu_in.brlan', 'menu.arc/arc/blyt/menu.brlyt', 'menu.arc/arc/timg/btn_on.tpl', 'sound/se.brsar',
    ]);
    expect(byPath.get('menu.arc/arc/timg/btn_on.tpl')).toMatchObject({ kind: 'texture', primary: 'menu.arc/arc/timg/btn_on.tex.json' });
    expect(byPath.get('font/test.brfnt')!.files).toEqual({ meta: 'font/test.font.json', atlas: 'font/test.atlas.png' });
    expect(byPath.get('map/course.kcl')!.files).toEqual({ model: 'map/course.glb' });
    expect(byPath.get('sound/se.brsar')).toMatchObject({ kind: 'raw', primary: 'sound/se.brsar' });
    for (const p of bundle.files.keys()) expect(p).not.toMatch(/\\|^\/|\/\.\.?\//);
  });

  it('keeps unconvertible files as raw and records a warning instead of failing', () => {
    expect(byPath.get('broken/bad.tpl')!.kind).toBe('raw');
    expect(m.warnings.some((w) => w.path === 'broken/bad.tpl' && /conversion failed/.test(w.message))).toBe(true);
  });

  it('resolves animation texture references to deterministic assetIds', () => {
    const a = byPath.get('menu.arc/arc/anim/menu_in.brlan')!;
    const btn = makeAssetId('texture', 'menu.arc/arc/timg/btn_on.tpl');
    const shared = makeAssetId('texture', 'common/timg/shared.tpl');
    expect(a.refs).toEqual([btn, shared]); // timg/ sibling first, then basename fallback across the archive
    expect(a.unresolvedRefs).toEqual(['elsewhere.tpl']);
    const meta = AnimMeta.parse(JSON.parse(new TextDecoder().decode(bundle.files.get(a.primary))));
    expect(meta.textures.map((t) => t.assetId)).toEqual([btn, shared, null]);
  });

  it('passes cross validation (no broken links)', () => {
    const { issues } = validateBundle(m, bundleFilesFromMap(bundle.files));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.filter((i) => i.severity === 'warning').map((i) => i.message)).toEqual(['unresolved reference "elsewhere.tpl"']);
  });

  it('is deterministic: identical input -> byte-identical zip', () => {
    const z1 = bundleToZip(bundle);
    const z2 = bundleToZip(convertFile('Scene/local.carc', makeCarc()));
    expect(z1).toEqual(z2);
    const entries = unzipSync(z1);
    expect(Object.keys(entries)[0]).toBe('manifest.json');
    expect(Manifest.parse(JSON.parse(new TextDecoder().decode(entries['manifest.json']))).assets.length).toBe(8);
  });

  it('WebAssetLoader resolves every cross reference from the zip', async () => {
    const loader = await WebAssetLoader.fromZip(bundleToZip(bundle));
    const animId = byPath.get('menu.arc/arc/anim/menu_in.brlan')!.assetId;
    const a = await loader.getAnimation(animId);
    expect(a.textures.map((t) => t?.asset.sourcePath ?? null)).toEqual(['menu.arc/arc/timg/btn_on.tpl', 'common/timg/shared.tpl', null]);
    expect(a.textures[0]!.meta.images[0]).toMatchObject({ width: 8, height: 4, gxFormat: 'I8' });
    expect(a.textures[0]!.images[0].bytes.subarray(1, 4)).toEqual(new TextEncoder().encode('PNG'));
    expect(a.sample(12).M_btn.texture).toBe(1);
    // Same texture object is shared (cached) between the animation and direct access.
    expect(await loader.getTexture(a.textures[0]!.asset.assetId)).toBe(a.textures[0]);

    const f = await loader.getFont(byPath.get('font/test.brfnt')!.assetId);
    expect(f.glyph('1')?.xadvance).toBe(5);
    expect(f.measure('0110')).toBe(6 + 5 + 5 + 6);

    const c = await loader.getCollision(byPath.get('map/course.kcl')!.assetId);
    expect(c.gltf.meshes[0].extras.collisionFlag).toBe(2);

    expect(loader.findBySourcePath('MENU.ARC/arc/timg/BTN_ON.tpl')?.kind).toBe('texture');
    const all = await loader.loadAll();
    expect(all.size).toBe(8);
    await expect(loader.getFont(animId)).rejects.toThrow(/not a font/);
  });

  it('WebAssetLoader.fromManifestUrl loads loose files over fetch', async () => {
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace(/^\/bundle\//, '');
      const body = bundle.files.get(decodeURIComponent(path));
      return body ? new Response(body as BlobPart) : new Response('nope', { status: 404 });
    }) as typeof fetch;
    const loader = await WebAssetLoader.fromManifestUrl('http://cdn.test/bundle/manifest.json', fakeFetch);
    const a = await loader.getAnimation(byPath.get('menu.arc/arc/anim/menu_in.brlan')!.assetId);
    expect(a.textures[1]?.meta.source).toBe('common/timg/shared.tpl');
  });
});

describe('cross validation catches broken bundles', () => {
  const bundle = convertFile('local.carc', makeCarc());
  const clone = () => JSON.parse(JSON.stringify(bundle.manifest)) as Manifest;
  const errorsOf = (manifest: unknown, files = bundle.files) =>
    validateBundle(manifest, bundleFilesFromMap(files)).issues.filter((i) => i.severity === 'error').map((i) => i.message);

  it('dangling ref', () => {
    const m = clone();
    m.assets.find((a) => a.kind === 'animation')!.refs.push('texture-ffffffffffffffff');
    expect(errorsOf(m).join()).toMatch(/references unknown asset texture-ffffffffffffffff/);
  });

  it('missing file / missing relative image', () => {
    const files = new Map(bundle.files);
    files.delete('common/timg/shared.png');
    const errs = errorsOf(bundle.manifest, files).join('\n');
    expect(errs).toMatch(/missing file referenced by texture-/);
    expect(errs).toMatch(/relative path "shared.png" resolves to missing/);
  });

  it('non-deterministic id, non-POSIX path, duplicate id', () => {
    const m = clone();
    m.assets[0].assetId = 'raw-0000000000000000';
    expect(errorsOf(m).join()).toMatch(/not deterministic/);
    const m2 = clone();
    m2.assets[0].primary = 'a\\b';
    expect(errorsOf(m2).join()).toMatch(/POSIX/);
    const m3 = clone();
    m3.assets.push(m3.assets[0]);
    expect(errorsOf(m3).join()).toMatch(/duplicate assetId/);
  });

  it('anim.json pointing at a non-texture asset or out-of-range texture index', () => {
    const a = bundle.manifest.assets.find((x) => x.kind === 'animation')!;
    const font = bundle.manifest.assets.find((x) => x.kind === 'font')!;
    const meta = JSON.parse(new TextDecoder().decode(bundle.files.get(a.primary)));
    meta.textures[0].assetId = font.assetId;
    meta.tracks[0].keys.push({ frame: 19, value: 9 });
    const files = new Map(bundle.files);
    files.set(a.primary, new TextEncoder().encode(JSON.stringify(meta)));
    const errs = errorsOf(bundle.manifest, files).join('\n');
    expect(errs).toMatch(/is a font/);
    expect(errs).toMatch(/texture index 9 out of range/);
  });

  it('WebAssetLoader refuses an invalid zip in strict mode', async () => {
    const files = new Map(bundle.files);
    files.delete('font/test.atlas.png');
    const broken = bundleToZip({ manifest: bundle.manifest, files });
    await expect(WebAssetLoader.fromZip(broken)).rejects.toBeInstanceOf(AssetLoadError);
  });
});

describe('single files', () => {
  it('converts a lone .tpl into a one-asset bundle', () => {
    const b = convertFile('icon.tpl', tpl(7));
    expect(b.manifest.source.format).toBe('tpl');
    expect([...b.files.keys()].sort()).toEqual(['icon.png', 'icon.tex.json', 'manifest.json']);
  });

  it('unwraps a Yaz0-compressed single file (.szs)', () => {
    const b = convertFile('course.szs', compressYaz0(buildU8([{ path: 'course.kcl', data: kcl }])));
    expect(b.manifest.assets.map((a) => a.primary)).toEqual(['course.glb']);
  });
});
