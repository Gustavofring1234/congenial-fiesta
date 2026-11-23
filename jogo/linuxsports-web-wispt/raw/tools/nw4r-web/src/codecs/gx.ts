/**
 * Decodificação de texturas GX (GameCube/Wii) para RGBA8 linear.
 * Formatos: I4, I8, IA4, IA8, RGB565, RGB5A3, RGBA8, CI4, CI8, CI14X2, CMPR.
 */
import { ParseError } from '../binary/reader.ts';

export const GxFormat = {
  I4: 0x0, I8: 0x1, IA4: 0x2, IA8: 0x3, RGB565: 0x4, RGB5A3: 0x5, RGBA8: 0x6,
  CI4: 0x8, CI8: 0x9, CI14X2: 0xa, CMPR: 0xe,
} as const;
export type GxFormatId = (typeof GxFormat)[keyof typeof GxFormat];

export const GX_FORMAT_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(GxFormat).map(([k, v]) => [v, k]),
);

export const GxPaletteFormat = { IA8: 0, RGB565: 1, RGB5A3: 2 } as const;
export const GX_PALETTE_NAME: Record<number, string> = { 0: 'IA8', 1: 'RGB565', 2: 'RGB5A3' };

/** largura do bloco, altura do bloco, bits por pixel */
const BLOCK: Record<number, [number, number, number]> = {
  0x0: [8, 8, 4], 0x1: [8, 4, 8], 0x2: [8, 4, 8], 0x3: [4, 4, 16], 0x4: [4, 4, 16],
  0x5: [4, 4, 16], 0x6: [4, 4, 32], 0x8: [8, 8, 4], 0x9: [8, 4, 8], 0xa: [4, 4, 16], 0xe: [8, 8, 4],
};

export function isGxFormat(fmt: number): boolean {
  return fmt in BLOCK;
}

export function isPaletted(fmt: number): boolean {
  return fmt === GxFormat.CI4 || fmt === GxFormat.CI8 || fmt === GxFormat.CI14X2;
}

/** Tamanho em bytes de uma imagem (um nível de mip) no formato GX. */
export function gxImageSize(fmt: number, w: number, h: number): number {
  const b = BLOCK[fmt];
  if (!b) throw new ParseError('gx', `formato desconhecido 0x${fmt.toString(16)}`);
  const [bw, bh, bpp] = b;
  return Math.ceil(w / bw) * Math.ceil(h / bh) * ((bw * bh * bpp) / 8);
}

const ex5 = (v: number) => (v << 3) | (v >> 2);
const ex6 = (v: number) => (v << 2) | (v >> 4);
const ex4 = (v: number) => v * 17;
const ex3 = (v: number) => (v << 5) | (v << 2) | (v >> 1);

function rgb565(v: number, out: Uint8Array, o: number) {
  out[o] = ex5((v >> 11) & 31); out[o + 1] = ex6((v >> 5) & 63); out[o + 2] = ex5(v & 31); out[o + 3] = 255;
}
function rgb5a3(v: number, out: Uint8Array, o: number) {
  if (v & 0x8000) {
    out[o] = ex5((v >> 10) & 31); out[o + 1] = ex5((v >> 5) & 31); out[o + 2] = ex5(v & 31); out[o + 3] = 255;
  } else {
    out[o] = ex4((v >> 8) & 15); out[o + 1] = ex4((v >> 4) & 15); out[o + 2] = ex4(v & 15); out[o + 3] = ex3((v >> 12) & 7);
  }
}
function ia8(v: number, out: Uint8Array, o: number) {
  const i = v & 0xff;
  out[o] = i; out[o + 1] = i; out[o + 2] = i; out[o + 3] = v >> 8;
}

/** Paleta TLUT -> RGBA (count * 4 bytes). */
export function decodePalette(src: Uint8Array, offset: number, count: number, format: number): Uint8Array {
  if (offset + count * 2 > src.length) throw new ParseError('gx', 'paleta fora dos limites');
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const v = (src[offset + i * 2] << 8) | src[offset + i * 2 + 1];
    if (format === GxPaletteFormat.IA8) ia8(v, out, i * 4);
    else if (format === GxPaletteFormat.RGB565) rgb565(v, out, i * 4);
    else if (format === GxPaletteFormat.RGB5A3) rgb5a3(v, out, i * 4);
    else throw new ParseError('gx', `formato de paleta desconhecido ${format}`);
  }
  return out;
}

/** Decodifica o nível base de uma textura GX (remove o block-swizzling). */
export function decodeGxImage(
  src: Uint8Array, offset: number, width: number, height: number, format: number, palette?: Uint8Array,
): Uint8Array {
  const b = BLOCK[format];
  if (!b) throw new ParseError('gx', `formato de textura não suportado 0x${format.toString(16)}`);
  const size = gxImageSize(format, width, height);
  if (offset < 0 || offset + size > src.length) {
    throw new ParseError('gx', `dados da textura fora dos limites (${width}x${height} ${GX_FORMAT_NAME[format]}, precisa ${size} bytes em 0x${offset.toString(16)})`);
  }
  if (isPaletted(format) && !palette) throw new ParseError('gx', `${GX_FORMAT_NAME[format]} requer paleta`);
  const [bw, bh] = b;
  const out = new Uint8Array(width * height * 4);
  const tmp = new Uint8Array(4);
  let p = offset;

  const put = (x: number, y: number, c: Uint8Array, co = 0) => {
    if (x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    out[o] = c[co]; out[o + 1] = c[co + 1]; out[o + 2] = c[co + 2]; out[o + 3] = c[co + 3];
  };
  const pal = (idx: number) => {
    const n = palette!.length / 4;
    if (idx < n) put2(palette!, idx * 4);
    else { tmp[0] = tmp[1] = tmp[2] = 0; tmp[3] = 0; put2(tmp, 0); }
  };
  let cx = 0, cy = 0;
  const put2 = (c: Uint8Array, co: number) => put(cx, cy, c, co);

  for (let by = 0; by < height; by += bh) {
    for (let bx = 0; bx < width; bx += bw) {
      if (format === GxFormat.CMPR) {
        for (let sb = 0; sb < 4; sb++) {
          const sx = bx + (sb & 1) * 4, sy = by + (sb >> 1) * 4;
          const c0 = (src[p] << 8) | src[p + 1], c1 = (src[p + 2] << 8) | src[p + 3];
          const cols = new Uint8Array(16);
          rgb565(c0, cols, 0); rgb565(c1, cols, 4);
          if (c0 > c1) {
            for (let k = 0; k < 3; k++) {
              cols[8 + k] = Math.floor((2 * cols[k] + cols[4 + k]) / 3);
              cols[12 + k] = Math.floor((cols[k] + 2 * cols[4 + k]) / 3);
            }
            cols[11] = 255; cols[15] = 255;
          } else {
            for (let k = 0; k < 3; k++) cols[8 + k] = (cols[k] + cols[4 + k]) >> 1;
            cols[11] = 255; cols[12] = cols[13] = cols[14] = cols[15] = 0;
          }
          for (let yy = 0; yy < 4; yy++) {
            const row = src[p + 4 + yy];
            for (let xx = 0; xx < 4; xx++) put(sx + xx, sy + yy, cols, ((row >> (6 - 2 * xx)) & 3) * 4);
          }
          p += 8;
        }
        continue;
      }
      if (format === GxFormat.RGBA8) {
        for (let i = 0; i < 16; i++) {
          tmp[0] = src[p + i * 2 + 1]; tmp[1] = src[p + 32 + i * 2]; tmp[2] = src[p + 32 + i * 2 + 1]; tmp[3] = src[p + i * 2];
          put(bx + (i & 3), by + (i >> 2), tmp);
        }
        p += 64;
        continue;
      }
      for (let yy = 0; yy < bh; yy++) {
        for (let xx = 0; xx < bw; xx++) {
          cx = bx + xx; cy = by + yy;
          switch (format) {
            case GxFormat.I4: case GxFormat.CI4: {
              const byte = src[p + (xx >> 1)];
              const v = xx & 1 ? byte & 15 : byte >> 4;
              if (format === GxFormat.CI4) pal(v);
              else { tmp[0] = tmp[1] = tmp[2] = ex4(v); tmp[3] = ex4(v); put2(tmp, 0); }
              break;
            }
            case GxFormat.I8: { const v = src[p + xx]; tmp[0] = tmp[1] = tmp[2] = v; tmp[3] = v; put2(tmp, 0); break; }
            case GxFormat.CI8: pal(src[p + xx]); break;
            case GxFormat.IA4: {
              const v = src[p + xx];
              tmp[0] = tmp[1] = tmp[2] = ex4(v & 15); tmp[3] = ex4(v >> 4); put2(tmp, 0);
              break;
            }
            case GxFormat.IA8: ia8((src[p + xx * 2] << 8) | src[p + xx * 2 + 1], tmp, 0); put2(tmp, 0); break;
            case GxFormat.RGB565: rgb565((src[p + xx * 2] << 8) | src[p + xx * 2 + 1], tmp, 0); put2(tmp, 0); break;
            case GxFormat.RGB5A3: rgb5a3((src[p + xx * 2] << 8) | src[p + xx * 2 + 1], tmp, 0); put2(tmp, 0); break;
            case GxFormat.CI14X2: pal(((src[p + xx * 2] << 8) | src[p + xx * 2 + 1]) & 0x3fff); break;
          }
        }
        p += (bw * b[2]) / 8;
      }
    }
  }
  return out;
}
