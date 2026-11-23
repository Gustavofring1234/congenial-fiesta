import { describe, expect, it } from 'vitest';
import { parseBrfnt } from '../src/parsers/brfnt.ts';
import { parseBrlan } from '../src/parsers/brlan.ts';
import { kclTriangles, parseKcl } from '../src/parsers/kcl.ts';
import { convertBrlan, hermiteToBezier } from '../src/serializers/anim.ts';
import { convertKcl } from '../src/serializers/collision.ts';
import { convertBrfnt } from '../src/serializers/font.ts';
import { readGlb } from '../src/serializers/glb.ts';
import { decodePng } from '../src/serializers/png.ts';
import { AnimMeta, CollisionMeshExtras, FontMeta } from '../src/schemas/bundle.schema.ts';
import { sampleAnimation, sampleTrack, toWaapiKeyframes } from '../src/web-runtime/anim-sampler.ts';
import { buildBrfnt, buildBrlan, buildKcl, swizzle } from './fixtures.ts';

const json = (b: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(b));

// ------------------------------------------------------------------ font fixture
// 2 sheets of 32x16 (I4), 3 columns x 1 row of 9x14 cells (+1 px spacing). Each glyph
// cell is filled with intensity (glyphIndex + 1) so its atlas position can be verified.
const CELL_W = 9, CELL_H = 14, COLS = 3;
const sheet = (n: number) => swizzle('I4', 32, 16, (x, y) => {
  const col = Math.floor(x / (CELL_W + 1));
  const inCell = x % (CELL_W + 1) < CELL_W && y < CELL_H && col < COLS;
  return inCell ? n * COLS + col + 1 : 0;
});
const fontBytes = buildBrfnt({
  cellWidth: CELL_W, cellHeight: CELL_H, baseline: 11, columns: COLS, rows: 1, sheetWidth: 32, sheetHeight: 16,
  sheets: [sheet(0), sheet(1)],
  widths: [[0, 7, 8], [1, 5, 7], [-1, 9, 9], [0, 6, 6], [0, 8, 9], [2, 3, 5]],
  cmaps: [
    { method: 0, begin: 0x41, end: 0x43, offset: 0 }, // A,B,C -> 0,1,2
    { method: 1, begin: 0x61, end: 0x63, table: [3, 0xffff, 4] }, // a -> 3, b unmapped, c -> 4
    { method: 2, pairs: [[0x20ac, 5]] }, // € -> 5
  ],
  lineFeed: 18, ascent: 12, alterCharIndex: 2,
});

describe('BRFNT', () => {
  it('parses FINF/TGLP/CWDH/CMAP headers', () => {
    const f = parseBrfnt(fontBytes);
    expect(f.sections).toEqual(['FINF', 'TGLP', 'CWDH', 'CMAP', 'CMAP', 'CMAP']);
    expect(f.info).toMatchObject({ lineFeed: 18, ascent: 12, encodingName: 'UTF-16', alterCharIndex: 2 });
    expect(f.glyphs).toMatchObject({ cellWidth: 9, cellHeight: 14, baselinePos: 11, sheetCount: 2, sheetFormatName: 'I4', columns: 3, rows: 1 });
    expect([...f.charMap.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0x41, 0], [0x42, 1], [0x43, 2], [0x61, 3], [0x63, 4], [0x20ac, 5]]);
    expect(f.widths.get(5)).toEqual({ left: 2, glyphWidth: 3, charWidth: 5 });
    expect(() => parseBrfnt(Uint8Array.of(1, 2, 3))).toThrow(/RFNT/);
  });

  it('emits a BMFont-style font.json whose UVs point at the right atlas pixels', () => {
    const out = convertBrfnt(fontBytes, { sourcePath: 'font/test.brfnt' });
    const meta = FontMeta.parse(json(out.files.get('font/test.font.json')));
    const atlas = decodePng(out.files.get('font/test.atlas.png')!);
    expect([meta.common.scaleW, meta.common.scaleH]).toEqual([atlas.width, atlas.height]);
    expect(meta.common).toMatchObject({ lineHeight: 18, base: 12 });
    expect(meta.nw4r.fallbackChar).toBe(0x43);
    expect(meta.chars.map((c) => c.char).join('')).toBe('ABCac€');
    for (const c of meta.chars) {
      // Cell filled with intensity (index+1)*17, rendered white with alpha = intensity.
      const o = (c.y * atlas.width + c.x) * 4;
      expect(Array.from(atlas.rgba.subarray(o, o + 4))).toEqual([255, 255, 255, (c.index + 1) * 17]);
      expect(c.uv[0]).toBeCloseTo(c.x / atlas.width, 5);
      expect(c.uv[3]).toBeCloseTo((c.y + c.height) / atlas.height, 5);
      expect(c.yoffset).toBe(12 - 11);
    }
    const euro = meta.chars.find((c) => c.char === '€')!;
    expect(euro).toMatchObject({ id: 0x20ac, index: 5, xoffset: 2, width: 3, xadvance: 5 });
  });
});

// ------------------------------------------------------------------ animation fixture
const lanBytes = buildBrlan({
  frames: 30, loop: true, textures: ['tex_a.tpl', 'tex_b.tpl'],
  entries: [
    { name: 'P_root', tags: [{ magic: 'RLPA', targets: [
      { target: 0, curve: 2, keys: [[0, 0, 0], [10, 100, 0], [30, 50, -2]] },
      { target: 5, curve: 2, keys: [[0, 0, 3], [20, 0, -3]] }, // v0 == v1 with slopes: bulging curve
    ] }, { magic: 'RLVI', targets: [{ target: 0, curve: 1, keys: [[0, 1], [15, 0]] }] }] },
    { name: 'M_mat', material: true, tags: [
      { magic: 'RLTP', targets: [{ index: 0, target: 0, curve: 1, keys: [[0, 0], [10, 1]] }] },
      { magic: 'RLMC', targets: [{ target: 3, curve: 2, keys: [[0, 255, 0], [30, 0, 0]] }] },
    ] },
  ],
});

describe('BRLAN', () => {
  it('parses pai1, texture table, tags and keys', () => {
    const lan = parseBrlan(lanBytes);
    expect(lan).toMatchObject({ magic: 'RLAN', frameCount: 30, loop: true, textures: ['tex_a.tpl', 'tex_b.tpl'], sections: ['pai1'] });
    expect(lan.entries.map((e) => [e.name, e.kind])).toEqual([['P_root', 'pane'], ['M_mat', 'material']]);
    const pa = lan.entries[0].tags[0];
    expect(pa.group).toBe('paneSRT');
    expect(pa.targets.map((t) => t.property)).toEqual(['translate.x', 'rotate.z']);
    expect(pa.targets[0].keys[2]).toEqual({ frame: 30, value: 50, slope: -2 });
    expect(lan.entries[0].tags[1].targets[0]).toMatchObject({ property: 'visible', curve: 'step', keys: [{ frame: 0, value: 1 }, { frame: 15, value: 0 }] });
    expect(lan.entries[1].tags[1].targets[0].property).toBe('material.a');
  });

  it('accepts split-variant magics (RLPA/RLVI...)', () => {
    const split = buildBrlan({ magic: 'RLVI', frames: 5, loop: false, textures: [], entries: [{ name: 'X', tags: [{ magic: 'RLVI', targets: [{ target: 0, curve: 1, keys: [[0, 1]] }] }] }] });
    expect(parseBrlan(split).magic).toBe('RLVI');
    expect(() => parseBrlan(new TextEncoder().encode('RLXX\xfe\xff' + '\0'.repeat(20)))).toThrow(/RLAN/);
  });

  it('Bézier segments reproduce the Hermite curve exactly', () => {
    const keys = [{ frame: 0, value: 0, slope: 4 }, { frame: 12, value: 30, slope: -1 }];
    const [seg] = hermiteToBezier(keys);
    for (const t of [0, 0.25, 0.5, 0.9, 1]) {
      const mt = 1 - t;
      const bez = (i: 0 | 1) => mt ** 3 * seg.p0[i] + 3 * mt * mt * t * seg.p1[i] + 3 * mt * t * t * seg.p2[i] + t ** 3 * seg.p3[i];
      // x(t) is linear in t because control points are spaced at thirds.
      expect(bez(0)).toBeCloseTo(12 * t, 6);
      expect(bez(1)).toBeCloseTo(sampleTrack({ interpolation: 'hermite', keys }, 12 * t), 4);
    }
    // P2.v = 30 - (-1 * 12 / 3) = 34 -> overshoot, y2 = 34 / 30
    expect(seg.easing).toBe('cubic-bezier(0.333333, 0.533333, 0.666667, 1.133333)');
  });

  it('emits anim.json with resolved texture refs, segments and samplable tracks', () => {
    const resolve = (n: string) => (n === 'tex_a.tpl' ? 'texture-0123456789abcdef' : null);
    const out = convertBrlan(lanBytes, { sourcePath: 'anim/test.brlan', resolveTexture: resolve });
    const meta = AnimMeta.parse(json(out.files.get('anim/test.anim.json')));
    expect(meta.textures).toEqual([{ name: 'tex_a.tpl', assetId: 'texture-0123456789abcdef' }, { name: 'tex_b.tpl', assetId: null }]);
    expect(out.asset.refs).toEqual(['texture-0123456789abcdef']);
    expect(out.asset.unresolvedRefs).toEqual(['tex_b.tpl']);
    const bulge = meta.tracks.find((t) => t.property === 'rotate.z')!;
    expect(bulge.segments![0].easing).toBeNull();

    const pose = sampleAnimation(meta, 10);
    expect(pose.P_root['translate.x']).toBeCloseTo(100);
    expect(pose.P_root.visible).toBe(1);
    expect(pose.M_mat.texture).toBe(1);
    expect(sampleAnimation(meta, 16).P_root.visible).toBe(0);
    expect(sampleAnimation(meta, 40).P_root['translate.x']).toBeCloseTo(sampleAnimation(meta, 10).P_root['translate.x']); // loop

    const kf = toWaapiKeyframes(meta.tracks[0], meta.frameCount);
    expect(kf[0]).toMatchObject({ offset: 0, value: 0 });
    expect(kf[kf.length - 1]).toMatchObject({ offset: 1, value: 50 });
    expect(kf.every((k, i) => i === 0 || k.offset > kf[i - 1].offset)).toBe(true);
  });
});

// ------------------------------------------------------------------ collision fixture
describe('KCL', () => {
  const tris = [
    { a: [0, 0, 0], b: [0, 0, 10], c: [10, 0, 0], flag: 0x0001 }, // floor (normal +Y)
    { a: [10, 0, 0], b: [0, 0, 10], c: [10, 0, 10], flag: 0x0001 },
    { a: [0, 0, 0], b: [10, 0, 0], c: [0, 10, 0], flag: 0x0a04 }, // wall (normal +Z)
  ] as Array<{ a: [number, number, number]; b: [number, number, number]; c: [number, number, number]; flag: number }>;
  const kclBytes = buildKcl(tris);

  it('parses header and reconstructs triangle vertices from prisms', () => {
    const kcl = parseKcl(kclBytes);
    expect(kcl.header).toMatchObject({ positionsOffset: 0x3c, prismThickness: 300, sphereRadius: 25, blockWidthShift: 5 });
    expect(kcl.prisms).toHaveLength(3);
    const out = kclTriangles(kcl);
    out.forEach((t, i) => {
      const verts = [t.a, t.b, t.c].map((v) => v.map((n) => Math.round(n * 1000) / 1000 + 0).join(','));
      const expected = [tris[i].a, tris[i].b, tris[i].c].map((v) => v.join(','));
      expect(verts.sort()).toEqual(expected.sort());
    });
    expect(out[0].normal.map(Math.round)).toEqual([0, 1, 0]);
  });

  it('writes a valid GLB grouped by collision flag with extras', () => {
    const out = convertKcl(kclBytes, { sourcePath: 'map/course.kcl' });
    const glb = out.files.get('map/course.glb')!;
    const dv = new DataView(glb.buffer, glb.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(glb.length);
    const { json: gltf, bin } = readGlb(glb);
    expect(gltf.asset.version).toBe('2.0');
    expect(gltf.meshes.map((m: any) => CollisionMeshExtras.parse(m.extras))).toEqual([
      { collisionFlag: 1, collisionFlagHex: '0x0001', triangleCount: 2 },
      { collisionFlag: 0x0a04, collisionFlagHex: '0x0a04', triangleCount: 1 },
    ]);
    const pos = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
    expect(pos).toMatchObject({ count: 6, type: 'VEC3', componentType: 5126 });
    expect(pos.min.map(Math.round)).toEqual([0, 0, 0]);
    expect(pos.max.map(Math.round)).toEqual([10, 0, 10]);
    expect(bin!.length).toBe(gltf.buffers[0].byteLength);
    // Front faces (CCW) must agree with the stored face normal.
    const f = new Float32Array(bin!.buffer.slice(bin!.byteOffset + gltf.bufferViews[pos.bufferView].byteOffset, bin!.byteOffset + gltf.bufferViews[pos.bufferView].byteOffset + 36));
    const e1 = [f[3] - f[0], f[4] - f[1], f[5] - f[2]], e2 = [f[6] - f[0], f[7] - f[1], f[8] - f[2]];
    expect(e1[2] * e2[0] - e1[0] * e2[2]).toBeGreaterThan(0); // (e1 x e2).y > 0
  });

  it('rejects files whose header offsets are inconsistent', () => {
    expect(() => parseKcl(new Uint8Array(0x100))).toThrow(/KCL/);
  });
});
