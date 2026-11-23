/** TPL (magic 0x0020AF30): contêiner de texturas GX. */
import { BinaryReader, ParseError } from '../binary/reader.ts';
import { GX_FORMAT_NAME, GX_PALETTE_NAME, decodeGxImage, decodePalette, gxImageSize, isGxFormat, isPaletted } from '../codecs/gx.ts';

export const TPL_MAGIC = 0x0020af30;
export const WRAP_NAME = ['CLAMP', 'REPEAT', 'MIRROR'] as const;
export const FILTER_NAME = ['NEAR', 'LINEAR', 'NEAR_MIP_NEAR', 'LIN_MIP_NEAR', 'NEAR_MIP_LIN', 'LIN_MIP_LIN'] as const;

export interface TplPalette { format: number; formatName: string; entryCount: number; dataOffset: number }
export interface TplImage {
  index: number;
  width: number;
  height: number;
  format: number;
  formatName: string;
  dataOffset: number;
  wrapS: number;
  wrapT: number;
  minFilter: number;
  magFilter: number;
  lodBias: number;
  edgeLodEnable: boolean;
  minLod: number;
  maxLod: number;
  /** níveis de mip presentes nos dados (inclui o nível base) */
  mipmapCount: number;
  palette?: TplPalette;
}
export interface Tpl { images: TplImage[]; bytes: Uint8Array }

export function isTpl(b: Uint8Array): boolean {
  return b.length >= 12 && b[0] === 0x00 && b[1] === 0x20 && b[2] === 0xaf && b[3] === 0x30;
}

export function parseTpl(data: ArrayBuffer | ArrayBufferView): Tpl {
  const r = new BinaryReader(data, 'tpl');
  if (r.u32(0) !== TPL_MAGIC) throw new ParseError('tpl', 'magic 0x0020AF30 não encontrado');
  const count = r.u32(4);
  const table = r.u32(8);
  if (count === 0 || count > 1024) throw new ParseError('tpl', `número de imagens inválido (${count})`);
  const images: TplImage[] = [];
  for (let i = 0; i < count; i++) {
    const ih = r.u32(table + i * 8);
    const ph = r.u32(table + i * 8 + 4);
    const height = r.u16(ih), width = r.u16(ih + 2), format = r.u32(ih + 4), dataOffset = r.u32(ih + 8);
    if (!isGxFormat(format)) throw new ParseError('tpl', `imagem ${i}: formato GX desconhecido 0x${format.toString(16)}`);
    if (!width || !height || width > 4096 || height > 4096) throw new ParseError('tpl', `imagem ${i}: dimensões inválidas ${width}x${height}`);
    const minFilter = r.u32(ih + 0x14);
    const minLod = r.u8(ih + 0x21), maxLod = r.u8(ih + 0x22);
    // conta quantos níveis cabem nos dados disponíveis, limitado ao que o cabeçalho declara
    const declared = minFilter >= 2 ? Math.max(1, maxLod - minLod + 1) : 1;
    let mipmapCount = 0, off = dataOffset, w = width, h = height;
    while (mipmapCount < declared && off + gxImageSize(format, w, h) <= r.length) {
      off += gxImageSize(format, w, h); mipmapCount++;
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
    if (mipmapCount === 0) throw new ParseError('tpl', `imagem ${i}: dados truncados`);
    const img: TplImage = {
      index: i, width, height, format, formatName: GX_FORMAT_NAME[format], dataOffset,
      wrapS: r.u32(ih + 0x0c), wrapT: r.u32(ih + 0x10), minFilter, magFilter: r.u32(ih + 0x18),
      lodBias: r.f32(ih + 0x1c),
      edgeLodEnable: r.u8(ih + 0x20) !== 0, minLod, maxLod, mipmapCount,
    };
    if (ph) {
      const n = r.u16(ph), pf = r.u32(ph + 4), pd = r.u32(ph + 8);
      img.palette = { format: pf, formatName: GX_PALETTE_NAME[pf] ?? `0x${pf.toString(16)}`, entryCount: n, dataOffset: pd };
    } else if (isPaletted(format)) {
      throw new ParseError('tpl', `imagem ${i}: formato ${img.formatName} sem paleta`);
    }
    images.push(img);
  }
  return { images, bytes: r.bytes };
}

export function decodeTplImage(tpl: Tpl, img: TplImage): Uint8Array {
  const pal = img.palette ? decodePalette(tpl.bytes, img.palette.dataOffset, img.palette.entryCount, img.palette.format) : undefined;
  return decodeGxImage(tpl.bytes, img.dataOffset, img.width, img.height, img.format, pal);
}
