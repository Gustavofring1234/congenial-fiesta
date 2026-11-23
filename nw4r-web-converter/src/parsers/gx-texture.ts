import { FormatError } from '../core/binary.ts';

/** GX texture formats (GXTexFmt). */
export const GXTexFmt = {
  I4: 0x0,
  I8: 0x1,
  IA4: 0x2,
  IA8: 0x3,
  RGB565: 0x4,
  RGB5A3: 0x5,
  RGBA8: 0x6,
  CI4: 0x8,
  CI8: 0x9,
  CI14X2: 0xa,
  CMPR: 0xe,
} as const;
export type GXTexFmt = (typeof GXTexFmt)[keyof typeof GXTexFmt];

/** GX palette (TLUT) formats. */
export const GXTlutFmt = { IA8: 0, RGB565: 1, RGB5A3: 2 } as const;
export type GXTlutFmt = (typeof GXTlutFmt)[keyof typeof GXTlutFmt];

const FORMAT_INFO: Record<number, { name: string; bw: number; bh: number; blockBytes: number; indexed?: boolean }> = {
  0x0: { name: 'I4', bw: 8, bh: 8, blockBytes: 32 },
  0x1: { name: 'I8', bw: 8, bh: 4, blockBytes: 32 },
  0x2: { name: 'IA4', bw: 8, bh: 4, blockBytes: 32 },
  0x3: { name: 'IA8', bw: 4, bh: 4, blockBytes: 32 },
  0x4: { name: 'RGB565', bw: 4, bh: 4, blockBytes: 32 },
  0x5: { name: 'RGB5A3', bw: 4, bh: 4, blockBytes: 32 },
  0x6: { name: 'RGBA8', bw: 4, bh: 4, blockBytes: 64 },
  0x8: { name: 'CI4', bw: 8, bh: 8, blockBytes: 32, indexed: true },
  0x9: { name: 'CI8', bw: 8, bh: 4, blockBytes: 32, indexed: true },
  0xa: { name: 'CI14X2', bw: 4, bh: 4, blockBytes: 32, indexed: true },
  0xe: { name: 'CMPR', bw: 8, bh: 8, blockBytes: 32 },
};

const TLUT_NAMES: Record<number, string> = { 0: 'IA8', 1: 'RGB565', 2: 'RGB5A3' };

export function texFormatName(fmt: number): string {
  return FORMAT_INFO[fmt]?.name ?? `UNKNOWN_0x${fmt.toString(16)}`;
}
export function tlutFormatName(fmt: number): string {
  return TLUT_NAMES[fmt] ?? `UNKNOWN_0x${fmt.toString(16)}`;
}
export function isIndexedFormat(fmt: number): boolean {
  return !!FORMAT_INFO[fmt]?.indexed;
}
export function isSupportedFormat(fmt: number): boolean {
  return fmt in FORMAT_INFO;
}

/** Bytes occupied by one (swizzled) mip level. */
export function textureByteSize(fmt: number, width: number, height: number): number {
  const info = FORMAT_INFO[fmt];
  if (!info) throw new FormatError('GX', `unsupported texture format 0x${fmt.toString(16)}`);
  return Math.ceil(width / info.bw) * Math.ceil(height / info.bh) * info.blockBytes;
}

const expand3 = (v: number) => (v << 5) | (v << 2) | (v >> 1);
const expand4 = (v: number) => (v << 4) | v;
const expand5 = (v: number) => (v << 3) | (v >> 2);
const expand6 = (v: number) => (v << 2) | (v >> 4);

/** Decode one 16-bit GX colour to RGBA8. */
function decode16(v: number, fmt: 'IA8' | 'RGB565' | 'RGB5A3', out: Uint8Array, o: number): void {
  if (fmt === 'IA8') {
    const a = v >> 8;
    const i = v & 0xff;
    out[o] = i; out[o + 1] = i; out[o + 2] = i; out[o + 3] = a;
  } else if (fmt === 'RGB565') {
    out[o] = expand5((v >> 11) & 0x1f);
    out[o + 1] = expand6((v >> 5) & 0x3f);
    out[o + 2] = expand5(v & 0x1f);
    out[o + 3] = 0xff;
  } else if (v & 0x8000) {
    out[o] = expand5((v >> 10) & 0x1f);
    out[o + 1] = expand5((v >> 5) & 0x1f);
    out[o + 2] = expand5(v & 0x1f);
    out[o + 3] = 0xff;
  } else {
    out[o] = expand4((v >> 8) & 0xf);
    out[o + 1] = expand4((v >> 4) & 0xf);
    out[o + 2] = expand4(v & 0xf);
    out[o + 3] = expand3((v >> 12) & 0x7);
  }
}

/** Decode a TLUT palette to RGBA8 (entryCount * 4 bytes). */
export function decodePalette(data: Uint8Array, offset: number, entryCount: number, tlutFmt: number): Uint8Array {
  const name = TLUT_NAMES[tlutFmt] as 'IA8' | 'RGB565' | 'RGB5A3' | undefined;
  if (!name) throw new FormatError('GX', `unsupported palette format ${tlutFmt}`);
  if (offset + entryCount * 2 > data.length) throw new FormatError('GX', 'palette data out of bounds');
  const out = new Uint8Array(entryCount * 4);
  for (let i = 0; i < entryCount; i++) {
    decode16((data[offset + i * 2] << 8) | data[offset + i * 2 + 1], name, out, i * 4);
  }
  return out;
}

export interface DecodeOptions {
  /** RGBA8 palette produced by {@link decodePalette}; required for CI formats. */
  palette?: Uint8Array;
}

/**
 * Decode (un-swizzle) a GX texture into a linear, top-to-bottom RGBA8 buffer.
 * Every GX format is stored as a grid of fixed-size tiles ("blocks"); pixels
 * falling outside width/height in edge tiles are padding and are discarded.
 */
export function decodeTexture(
  data: Uint8Array,
  offset: number,
  width: number,
  height: number,
  fmt: number,
  opts: DecodeOptions = {},
): Uint8Array {
  const info = FORMAT_INFO[fmt];
  if (!info) throw new FormatError('GX', `unsupported texture format 0x${fmt.toString(16)}`);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
    throw new FormatError('GX', `invalid texture size ${width}x${height}`);
  }
  const size = textureByteSize(fmt, width, height);
  if (offset < 0 || offset + size > data.length) {
    throw new FormatError('GX', `${info.name} ${width}x${height} needs ${size} bytes at 0x${offset.toString(16)}, file has ${data.length}`);
  }
  const palette = opts.palette;
  if (info.indexed && !palette) throw new FormatError('GX', `${info.name} texture requires a palette`);

  const out = new Uint8Array(width * height * 4);
  const tmp = new Uint8Array(4);
  let src = offset;

  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  };
  const putPal = (x: number, y: number, idx: number) => {
    if (x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    const p = idx * 4;
    if (p + 3 < palette!.length) {
      out[o] = palette![p]; out[o + 1] = palette![p + 1]; out[o + 2] = palette![p + 2]; out[o + 3] = palette![p + 3];
    }
  };
  const u16 = (o: number) => (data[o] << 8) | data[o + 1];

  for (let by = 0; by < height; by += info.bh) {
    for (let bx = 0; bx < width; bx += info.bw) {
      switch (fmt) {
        case GXTexFmt.I4:
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) {
            const v = data[src++];
            const i0 = expand4(v >> 4), i1 = expand4(v & 0xf);
            put(bx + x, by + y, i0, i0, i0, i0);
            put(bx + x + 1, by + y, i1, i1, i1, i1);
          }
          break;
        case GXTexFmt.I8:
          for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
            const i = data[src++];
            put(bx + x, by + y, i, i, i, i);
          }
          break;
        case GXTexFmt.IA4:
          for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
            const v = data[src++];
            const i = expand4(v & 0xf);
            put(bx + x, by + y, i, i, i, expand4(v >> 4));
          }
          break;
        case GXTexFmt.IA8:
        case GXTexFmt.RGB565:
        case GXTexFmt.RGB5A3: {
          const name = fmt === GXTexFmt.IA8 ? 'IA8' : fmt === GXTexFmt.RGB565 ? 'RGB565' : 'RGB5A3';
          for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
            decode16(u16(src), name, tmp, 0);
            src += 2;
            put(bx + x, by + y, tmp[0], tmp[1], tmp[2], tmp[3]);
          }
          break;
        }
        case GXTexFmt.RGBA8:
          // 64-byte tile: 16 AR pairs followed by 16 GB pairs.
          for (let p = 0; p < 16; p++) {
            const x = p & 3, y = p >> 2;
            const a = data[src + p * 2], r = data[src + p * 2 + 1];
            const g = data[src + 32 + p * 2], b = data[src + 32 + p * 2 + 1];
            put(bx + x, by + y, r, g, b, a);
          }
          src += 64;
          break;
        case GXTexFmt.CI4:
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x += 2) {
            const v = data[src++];
            putPal(bx + x, by + y, v >> 4);
            putPal(bx + x + 1, by + y, v & 0xf);
          }
          break;
        case GXTexFmt.CI8:
          for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) putPal(bx + x, by + y, data[src++]);
          break;
        case GXTexFmt.CI14X2:
          for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
            putPal(bx + x, by + y, u16(src) & 0x3fff);
            src += 2;
          }
          break;
        case GXTexFmt.CMPR:
          // 8x8 tile made of four DXT1 4x4 sub-blocks in Z order.
          for (let sub = 0; sub < 4; sub++) {
            const sx = bx + (sub & 1) * 4;
            const sy = by + (sub >> 1) * 4;
            decodeDxt1Block(data, src, sx, sy, put);
            src += 8;
          }
          break;
      }
    }
  }
  return out;
}

function decodeDxt1Block(
  data: Uint8Array,
  o: number,
  x0: number,
  y0: number,
  put: (x: number, y: number, r: number, g: number, b: number, a: number) => void,
): void {
  const c0 = (data[o] << 8) | data[o + 1];
  const c1 = (data[o + 2] << 8) | data[o + 3];
  const pal = new Uint8Array(16);
  decode16(c0, 'RGB565', pal, 0);
  decode16(c1, 'RGB565', pal, 4);
  if (c0 > c1) {
    for (let k = 0; k < 3; k++) {
      pal[8 + k] = Math.round((2 * pal[k] + pal[4 + k]) / 3);
      pal[12 + k] = Math.round((pal[k] + 2 * pal[4 + k]) / 3);
    }
    pal[11] = 0xff;
    pal[15] = 0xff;
  } else {
    for (let k = 0; k < 3; k++) pal[8 + k] = (pal[k] + pal[4 + k]) >> 1;
    pal[11] = 0xff;
    pal[12] = pal[13] = pal[14] = pal[15] = 0; // transparent black
  }
  for (let y = 0; y < 4; y++) {
    const row = data[o + 4 + y];
    for (let x = 0; x < 4; x++) {
      const idx = ((row >> (6 - x * 2)) & 3) * 4;
      put(x0 + x, y0 + y, pal[idx], pal[idx + 1], pal[idx + 2], pal[idx + 3]);
    }
  }
}
