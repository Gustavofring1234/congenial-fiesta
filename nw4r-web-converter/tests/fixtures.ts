/**
 * Synthetic binary builders. They encode files from first principles (swizzled
 * tiles, big-endian headers) so tests verify the parsers against an independent
 * implementation of each format instead of against themselves.
 */
import { BEWriter } from '../src/core/binary.ts';

export type Pixel = [number, number, number, number];

const BLOCK: Record<string, [number, number]> = {
  I4: [8, 8], I8: [8, 4], IA4: [8, 4], IA8: [4, 4], RGB565: [4, 4], RGB5A3: [4, 4], RGBA8: [4, 4], CI4: [8, 8], CI8: [8, 4],
};
export const FMT_ID: Record<string, number> = { I4: 0, I8: 1, IA4: 2, IA8: 3, RGB565: 4, RGB5A3: 5, RGBA8: 6, CI4: 8, CI8: 9, CMPR: 14 };

/**
 * Encode a texture. `px(x, y)` returns the raw per-format value(s):
 *  I4/I8/CI4/CI8: number, IA4/IA8: [i, a], RGB565/RGB5A3: u16, RGBA8: [r,g,b,a].
 */
export function swizzle(fmt: keyof typeof BLOCK, w: number, h: number, px: (x: number, y: number) => any): Uint8Array {
  const [bw, bh] = BLOCK[fmt];
  const out = new BEWriter();
  for (let by = 0; by < h; by += bh) for (let bx = 0; bx < w; bx += bw) {
    if (fmt === 'RGBA8') {
      const ar: number[] = [], gb: number[] = [];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const [r, g, b, a] = bx + x < w && by + y < h ? px(bx + x, by + y) : [0, 0, 0, 0];
        ar.push(a, r); gb.push(g, b);
      }
      out.bytes(Uint8Array.from([...ar, ...gb]));
      continue;
    }
    let hi = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const inside = bx + x < w && by + y < h;
      const v = inside ? px(bx + x, by + y) : fmt === 'IA4' || fmt === 'IA8' ? [0, 0] : 0;
      switch (fmt) {
        case 'I4': case 'CI4':
          if (x % 2 === 0) hi = v & 0xf;
          else out.u8((hi << 4) | (v & 0xf));
          break;
        case 'I8': case 'CI8': out.u8(v); break;
        case 'IA4': out.u8((v[1] << 4) | v[0]); break;
        case 'IA8': out.u8(v[1]).u8(v[0]); break;
        case 'RGB565': case 'RGB5A3': out.u16(v); break;
      }
    }
  }
  return out.finish();
}

/** CMPR (DXT1) 8x8 texture where every 4x4 sub-block uses colours c0/c1 and index pattern `idx(x,y)`. */
export function cmpr(w: number, h: number, c0: number, c1: number, idx: (x: number, y: number) => number): Uint8Array {
  const out = new BEWriter();
  for (let by = 0; by < h; by += 8) for (let bx = 0; bx < w; bx += 8) for (let sub = 0; sub < 4; sub++) {
    out.u16(c0).u16(c1);
    const sx = bx + (sub & 1) * 4, sy = by + (sub >> 1) * 4;
    for (let y = 0; y < 4; y++) {
      let row = 0;
      for (let x = 0; x < 4; x++) row |= (idx(sx + x, sy + y) & 3) << (6 - 2 * x);
      out.u8(row);
    }
  }
  return out.finish();
}

export interface TplImageSpec {
  width: number;
  height: number;
  format: number;
  data: Uint8Array;
  palette?: { format: number; entries: number[] };
  wrapS?: number;
  wrapT?: number;
  minFilter?: number;
  magFilter?: number;
  maxLod?: number;
}

export function buildTpl(images: TplImageSpec[]): Uint8Array {
  const w = new BEWriter();
  w.u32(0x0020af30).u32(images.length).u32(0x0c);
  const table = w.length;
  w.zeros(images.length * 8);
  images.forEach((img, i) => {
    let palHeader = 0;
    if (img.palette) {
      w.align(0x20);
      const palData = w.length;
      for (const e of img.palette.entries) w.u16(e);
      w.align(4);
      palHeader = w.length;
      w.u16(img.palette.entries.length).u8(0).u8(0).u32(img.palette.format).u32(palData);
    }
    w.align(4);
    const header = w.length;
    w.zeros(0x24);
    w.align(0x20);
    const data = w.length;
    w.bytes(img.data);
    const hw = new BEWriter();
    hw.u16(img.height).u16(img.width).u32(img.format).u32(data)
      .u32(img.wrapS ?? 0).u32(img.wrapT ?? 0).u32(img.minFilter ?? 1).u32(img.magFilter ?? 1)
      .f32(0).u8(0).u8(0).u8(img.maxLod ?? 0).u8(0);
    const hb = hw.finish();
    for (let k = 0; k < hb.length; k += 4) w.patchU32(header + k, new DataView(hb.buffer).getUint32(k));
    w.patchU32(table + i * 8, header).patchU32(table + i * 8 + 4, palHeader);
  });
  return w.finish();
}

// ------------------------------------------------------------------ BRFNT

export interface FontSpec {
  cellWidth: number;
  cellHeight: number;
  baseline: number;
  columns: number;
  rows: number;
  sheetWidth: number;
  sheetHeight: number;
  sheets: Uint8Array[]; // I4 swizzled
  widths: Array<[number, number, number]>; // per glyph index from 0
  cmaps: Array<
    | { method: 0; begin: number; end: number; offset: number }
    | { method: 1; begin: number; end: number; table: number[] }
    | { method: 2; pairs: Array<[number, number]> }
  >;
  lineFeed: number;
  ascent: number;
  alterCharIndex?: number;
}

function section(magic: string, body: Uint8Array): Uint8Array {
  const w = new BEWriter();
  const size = Math.ceil((8 + body.length) / 4) * 4;
  w.ascii(magic, 4).u32(size).bytes(body).align(4);
  return w.finish();
}

export function buildBrfnt(f: FontSpec): Uint8Array {
  const sheetSize = f.sheets[0].length;
  const parts: Uint8Array[] = [];
  const finf = new BEWriter()
    .u8(1).s8(f.lineFeed).u16(f.alterCharIndex ?? 0).s8(0).u8(f.cellWidth).s8(f.cellWidth).u8(1)
    .u32(0).u32(0).u32(0).u8(f.cellHeight).u8(f.cellWidth).u8(f.ascent).u8(0);
  parts.push(section('FINF', finf.finish()));
  // TGLP: sheet data follows the header, aligned to 0x20 in the file.
  const fileHeader = 0x10;
  const tglpStart = fileHeader + parts[0].length;
  const tglpHeaderSize = 8 + 0x18;
  const sheetOffset = Math.ceil((tglpStart + tglpHeaderSize) / 0x20) * 0x20;
  const tglp = new BEWriter()
    .u8(f.cellWidth).u8(f.cellHeight).s8(f.baseline).u8(f.cellWidth).u32(sheetSize).u16(f.sheets.length).u16(0)
    .u16(f.columns).u16(f.rows).u16(f.sheetWidth).u16(f.sheetHeight).u32(sheetOffset);
  tglp.zeros(sheetOffset - (tglpStart + tglpHeaderSize));
  for (const s of f.sheets) tglp.bytes(s);
  parts.push(section('TGLP', tglp.finish()));
  const cwdh = new BEWriter().u16(0).u16(f.widths.length - 1).u32(0);
  for (const [l, g, c] of f.widths) cwdh.s8(l).u8(g).s8(c);
  parts.push(section('CWDH', cwdh.finish()));
  for (const m of f.cmaps) {
    const c = new BEWriter();
    if (m.method === 0) c.u16(m.begin).u16(m.end).u16(0).u16(0).u32(0).u16(m.offset);
    else if (m.method === 1) { c.u16(m.begin).u16(m.end).u16(1).u16(0).u32(0); m.table.forEach((v) => c.u16(v)); }
    else { c.u16(0).u16(0xffff).u16(2).u16(0).u32(0).u16(m.pairs.length); m.pairs.forEach(([code, idx]) => c.u16(code).u16(idx)); }
    parts.push(section('CMAP', c.finish()));
  }
  const total = fileHeader + parts.reduce((s, p) => s + p.length, 0);
  const w = new BEWriter().ascii('RFNT', 4).u16(0xfeff).u16(0x0104).u32(total).u16(fileHeader).u16(parts.length);
  parts.forEach((p) => w.bytes(p));
  return w.finish();
}

// ------------------------------------------------------------------ BRLAN

export interface LanTarget { index?: number; target: number; curve: 1 | 2; keys: number[][] }
export interface LanTag { magic: string; targets: LanTarget[] }
export interface LanEntry { name: string; material?: boolean; tags: LanTag[] }

export function buildBrlan(spec: { frames: number; loop: boolean; textures: string[]; entries: LanEntry[]; magic?: string }): Uint8Array {
  const pai = new BEWriter(); // offsets relative to pai1 section start
  pai.ascii('pai1', 4).u32(0).u16(spec.frames).u8(spec.loop ? 1 : 0).u8(0).u16(spec.textures.length).u16(spec.entries.length).u32(0);
  const texTable = pai.length; // 0x14
  pai.zeros(spec.textures.length * 4);
  spec.textures.forEach((t, i) => {
    pai.patchU32(texTable + i * 4, pai.length - texTable);
    pai.ascii(t).u8(0);
  });
  pai.align(4);
  const entryTable = pai.length;
  pai.patchU32(0x10, entryTable);
  pai.zeros(spec.entries.length * 4);
  spec.entries.forEach((e, ei) => {
    const ent = pai.length;
    pai.patchU32(entryTable + ei * 4, ent);
    pai.ascii(e.name, 20).u8(e.tags.length).u8(e.material ? 1 : 0).u16(0);
    const tagTable = pai.length;
    pai.zeros(e.tags.length * 4);
    e.tags.forEach((tag, ti) => {
      const t0 = pai.length;
      pai.patchU32(tagTable + ti * 4, t0 - ent);
      pai.ascii(tag.magic, 4).u8(tag.targets.length).zeros(3);
      const tgTable = pai.length;
      pai.zeros(tag.targets.length * 4);
      tag.targets.forEach((tg, k) => {
        const g0 = pai.length;
        pai.patchU32(tgTable + k * 4, g0 - t0);
        pai.u8(tg.index ?? 0).u8(tg.target).u8(tg.curve).u8(0).u16(tg.keys.length).u16(0).u32(12);
        for (const key of tg.keys) {
          if (tg.curve === 2) pai.f32(key[0]).f32(key[1]).f32(key[2]);
          else pai.f32(key[0]).u16(key[1]).u16(0);
        }
      });
    });
  });
  pai.align(4);
  pai.patchU32(4, pai.length);
  const body = pai.finish();
  const w = new BEWriter().ascii(spec.magic ?? 'RLAN', 4).u16(0xfeff).u16(0x0008).u32(0x10 + body.length).u16(0x10).u16(1);
  return w.bytes(body).finish();
}

// ------------------------------------------------------------------ KCL

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crs = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dt = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** Encode triangles (CCW, A/B/C) as KCL prisms the way Nintendo's tools do. */
export function buildKcl(tris: Array<{ a: V3; b: V3; c: V3; flag: number }>): Uint8Array {
  const positions: V3[] = [];
  const normals: V3[] = [];
  const prisms: number[][] = [];
  for (const { a, b, c, flag } of tris) {
    const fn = nrm(crs(sub(b, a), sub(c, a)));
    // Edge normals lie in the triangle plane, perpendicular to their edge.
    const en1 = nrm(crs(fn, sub(c, a))); // edge A-C  (cross(en1, fn) points A->C)
    const en2 = nrm(crs(fn, sub(b, a))); // edge A-B  (cross(en2, fn) points A->B)
    const en3 = nrm(crs(fn, sub(b, c))); // edge B-C  (height = distance from A to this edge)
    const height = dt(sub(c, a), en3);
    positions.push(a);
    const n0 = normals.length;
    normals.push(fn, en1, en2, en3);
    prisms.push([height, positions.length - 1, n0, n0 + 1, n0 + 2, n0 + 3, flag]);
  }
  const posOff = 0x3c;
  const nrmOff = posOff + positions.length * 12;
  const priOff = nrmOff + normals.length * 12 - 0x10;
  const octOff = priOff + 0x10 + prisms.length * 0x10;
  const w = new BEWriter().u32(posOff).u32(nrmOff).u32(priOff).u32(octOff).f32(300).f32(-100).f32(-100).f32(-100)
    .u32(0xffffff00).u32(0xffffff00).u32(0xffffff00).u32(5).u32(2).u32(4).f32(25);
  for (const p of positions) w.f32(p[0]).f32(p[1]).f32(p[2]);
  for (const n of normals) w.f32(n[0]).f32(n[1]).f32(n[2]);
  for (const p of prisms) w.f32(p[0]).u16(p[1]).u16(p[2]).u16(p[3]).u16(p[4]).u16(p[5]).u16(p[6]);
  w.u32(0); // minimal octree placeholder
  return w.finish();
}
