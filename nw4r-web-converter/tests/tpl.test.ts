import { describe, expect, it } from 'vitest';
import { decodeTexture, textureByteSize } from '../src/parsers/gx-texture.ts';
import { parseTpl } from '../src/parsers/tpl.ts';
import { decodePng } from '../src/serializers/png.ts';
import { convertTpl } from '../src/serializers/texture.ts';
import { TextureMeta } from '../src/schemas/bundle.schema.ts';
import { FMT_ID, buildTpl, cmpr, swizzle } from './fixtures.ts';

const px = (rgba: Uint8Array, w: number, x: number, y: number) => Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

// Sizes deliberately not multiples of the tile size, to exercise edge-tile padding.
const W = 13, H = 10;

describe('GX texture decoding', () => {
  it('I4 / I8', () => {
    const i4 = parseTpl(buildTpl([{ width: W, height: H, format: FMT_ID.I4, data: swizzle('I4', W, H, (x, y) => (x + y) & 15) }]));
    const img = i4.images[0].mipmaps[0];
    for (const [x, y] of [[0, 0], [12, 9], [7, 3], [8, 8]]) {
      const v = ((x + y) & 15) * 17;
      expect(px(img.rgba, W, x, y)).toEqual([v, v, v, v]);
    }
    const i8 = parseTpl(buildTpl([{ width: W, height: H, format: FMT_ID.I8, data: swizzle('I8', W, H, (x, y) => x * 16 + y) }]));
    expect(px(i8.images[0].mipmaps[0].rgba, W, 12, 9)).toEqual([201, 201, 201, 201]);
  });

  it('IA4 / IA8 (alpha stored first)', () => {
    const ia4 = parseTpl(buildTpl([{ width: W, height: H, format: FMT_ID.IA4, data: swizzle('IA4', W, H, (x, y) => [x & 15, y & 15]) }]));
    expect(px(ia4.images[0].mipmaps[0].rgba, W, 11, 6)).toEqual([11 * 17, 11 * 17, 11 * 17, 6 * 17]);
    const ia8 = parseTpl(buildTpl([{ width: W, height: H, format: FMT_ID.IA8, data: swizzle('IA8', W, H, (x, y) => [x * 10, 255 - y]) }]));
    expect(px(ia8.images[0].mipmaps[0].rgba, W, 12, 9)).toEqual([120, 120, 120, 246]);
  });

  it('RGB565 / RGB5A3 (both branches) / RGBA8', () => {
    const rgb565 = parseTpl(buildTpl([{ width: W, height: H, format: FMT_ID.RGB565, data: swizzle('RGB565', W, H, () => (31 << 11) | (32 << 5) | 0) }]));
    expect(px(rgb565.images[0].mipmaps[0].rgba, W, 5, 5)).toEqual([255, 130, 0, 255]);

    const rgb5a3 = parseTpl(buildTpl([{
      width: W, height: H, format: FMT_ID.RGB5A3,
      data: swizzle('RGB5A3', W, H, (x) => (x < 6 ? 0x8000 | (31 << 10) | (0 << 5) | 16 : (3 << 12) | (0xf << 8) | (0x8 << 4) | 0x0)),
    }]));
    const r = rgb5a3.images[0].mipmaps[0].rgba;
    expect(px(r, W, 2, 2)).toEqual([255, 0, 132, 255]); // opaque RGB555
    expect(px(r, W, 9, 2)).toEqual([255, 136, 0, 109]); // RGB4A3, alpha 3 -> 0x6d

    const rgba8 = parseTpl(buildTpl([{ width: W, height: H, format: FMT_ID.RGBA8, data: swizzle('RGBA8', W, H, (x, y) => [x, y, x + y, 200]) }]));
    expect(px(rgba8.images[0].mipmaps[0].rgba, W, 12, 9)).toEqual([12, 9, 21, 200]);
  });

  it('CI4 / CI8 with TLUT palettes', () => {
    const pal = Array.from({ length: 16 }, (_, i) => 0x8000 | (i << 10) | (31 - i)); // RGB5A3 opaque
    const ci4 = parseTpl(buildTpl([{ width: W, height: H, format: FMT_ID.CI4, data: swizzle('CI4', W, H, (x) => x & 15), palette: { format: 2, entries: pal } }]));
    expect(ci4.images[0].palette).toMatchObject({ formatName: 'RGB5A3', entryCount: 16 });
    const c = ci4.images[0].mipmaps[0].rgba;
    expect(px(c, W, 3, 7)).toEqual([(3 << 3) | (3 >> 2), 0, ((28 << 3) | (28 >> 2)), 255]);

    const pal8 = Array.from({ length: 256 }, (_, i) => (i << 8) | (255 - i)); // IA8: alpha high byte
    const ci8 = parseTpl(buildTpl([{ width: W, height: H, format: FMT_ID.CI8, data: swizzle('CI8', W, H, (x, y) => x * 10 + y), palette: { format: 0, entries: pal8 } }]));
    const v = 12 * 10 + 9;
    expect(px(ci8.images[0].mipmaps[0].rgba, W, 12, 9)).toEqual([255 - v, 255 - v, 255 - v, v]);
  });

  it('CMPR (DXT1) opaque 4-colour and 3-colour + transparent modes', () => {
    const red = 31 << 11, blue = 31;
    const four = parseTpl(buildTpl([{ width: 16, height: 8, format: FMT_ID.CMPR, data: cmpr(16, 8, red, blue, (x) => x & 3) }]));
    const f = four.images[0].mipmaps[0].rgba;
    expect(px(f, 16, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(f, 16, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(px(f, 16, 2, 0)).toEqual([170, 0, 85, 255]);
    expect(px(f, 16, 13, 7)).toEqual([0, 0, 255, 255]); // second 8x8 tile, sub-block 3

    const three = parseTpl(buildTpl([{ width: 8, height: 8, format: FMT_ID.CMPR, data: cmpr(8, 8, blue, red, (x) => x & 3) }]));
    const t = three.images[0].mipmaps[0].rgba;
    expect(px(t, 8, 2, 1)).toEqual([127, 0, 127, 255]);
    expect(px(t, 8, 3, 1)[3]).toBe(0);
  });

  it('computes swizzled sizes', () => {
    expect(textureByteSize(FMT_ID.I4, 13, 10)).toBe(2 * 2 * 32);
    expect(textureByteSize(FMT_ID.RGBA8, 4, 4)).toBe(64);
    expect(textureByteSize(FMT_ID.CMPR, 9, 9)).toBe(4 * 32);
  });
});

describe('TPL container', () => {
  it('reads header, sampler state, multiple images and mipmaps', () => {
    const base = swizzle('I8', 16, 8, () => 10);
    const mip1 = swizzle('I8', 8, 4, () => 20);
    const mip2 = swizzle('I8', 4, 2, () => 30);
    const tpl = buildTpl([
      { width: 16, height: 8, format: FMT_ID.I8, data: new Uint8Array([...base, ...mip1, ...mip2]), wrapS: 1, wrapT: 2, minFilter: 5, magFilter: 0, maxLod: 2 },
      { width: 4, height: 4, format: FMT_ID.IA8, data: swizzle('IA8', 4, 4, () => [1, 2]) },
    ]);
    expect(new DataView(tpl.buffer).getUint32(0)).toBe(0x0020af30);
    const parsed = parseTpl(tpl, { decodeMipmaps: true });
    expect(parsed.imageCount).toBe(2);
    const img = parsed.images[0];
    expect(img).toMatchObject({ width: 16, height: 8, formatName: 'I8', wrapS: 1, wrapT: 2, minFilter: 5, magFilter: 0, maxLod: 2 });
    expect(img.mipmaps.map((m) => [m.width, m.height])).toEqual([[16, 8], [8, 4], [4, 2]]);
    expect(img.mipmaps[2].rgba[0]).toBe(30);

    const out = convertTpl(tpl, { sourcePath: 'timg/test.tpl' });
    const meta = TextureMeta.parse(JSON.parse(new TextDecoder().decode(out.files.get('timg/test.tex.json'))));
    expect(meta.images[0].sampler).toMatchObject({ wrapS: 'REPEAT', wrapT: 'MIRROR', minFilter: 'LIN_MIP_LIN', magFilter: 'NEAR' });
    expect(meta.images[0].sampler.webgl).toEqual({ wrapS: 'REPEAT', wrapT: 'MIRRORED_REPEAT', minFilter: 'LINEAR_MIPMAP_LINEAR', magFilter: 'NEAREST' });
    expect(meta.images.map((i) => i.file)).toEqual(['test.png', 'test.1.png']);
    const png = decodePng(out.files.get('timg/test.png')!);
    expect([png.width, png.height]).toEqual([16, 8]);
    expect(Array.from(png.rgba.subarray(0, 4))).toEqual([10, 10, 10, 10]);
  });

  it('rejects bad magic, unsupported formats and truncated pixel data', () => {
    expect(() => parseTpl(new Uint8Array(16))).toThrow(/magic/);
    const bad = buildTpl([{ width: 8, height: 8, format: 7, data: new Uint8Array(64) }]);
    expect(() => parseTpl(bad)).toThrow(/unsupported format/);
    const trunc = buildTpl([{ width: 8, height: 8, format: FMT_ID.I8, data: new Uint8Array(64) }]);
    expect(() => parseTpl(trunc.subarray(0, trunc.length - 1))).toThrow(/truncated/);
    expect(() => parseTpl(buildTpl([{ width: 8, height: 8, format: FMT_ID.CI8, data: new Uint8Array(64) }]))).toThrow(/palette/);
  });

  it('decodeTexture refuses out-of-bounds reads', () => {
    expect(() => decodeTexture(new Uint8Array(10), 0, 8, 8, FMT_ID.I8)).toThrow(/needs 64 bytes/);
  });
});
