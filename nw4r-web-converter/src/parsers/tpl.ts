import { BEReader, FormatError, toBytes } from '../core/binary.ts';
import {
  decodePalette,
  decodeTexture,
  isIndexedFormat,
  isSupportedFormat,
  textureByteSize,
  texFormatName,
  tlutFormatName,
} from './gx-texture.ts';

export const TPL_MAGIC = 0x0020af30;

export const GX_WRAP = ['CLAMP', 'REPEAT', 'MIRROR'] as const;
export const GX_FILTER = ['NEAR', 'LINEAR', 'NEAR_MIP_NEAR', 'LIN_MIP_NEAR', 'NEAR_MIP_LIN', 'LIN_MIP_LIN'] as const;
/** Equivalent WebGL enum names, for direct use with gl.texParameteri / three.js. */
export const WEBGL_WRAP = ['CLAMP_TO_EDGE', 'REPEAT', 'MIRRORED_REPEAT'] as const;
export const WEBGL_FILTER = [
  'NEAREST',
  'LINEAR',
  'NEAREST_MIPMAP_NEAREST',
  'LINEAR_MIPMAP_NEAREST',
  'NEAREST_MIPMAP_LINEAR',
  'LINEAR_MIPMAP_LINEAR',
] as const;

export interface TplMipLevel {
  level: number;
  width: number;
  height: number;
  byteOffset: number;
  byteSize: number;
  rgba: Uint8Array;
}

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
  palette: { format: number; formatName: string; entryCount: number; dataOffset: number } | null;
  /** Level 0 is the full-size image. */
  mipmaps: TplMipLevel[];
}

export interface TplFile {
  imageCount: number;
  images: TplImage[];
}

export function isTpl(data: Uint8Array): boolean {
  return data.length >= 12 && data[0] === 0x00 && data[1] === 0x20 && data[2] === 0xaf && data[3] === 0x30;
}

/**
 * TPL layout:
 *   0x00 u32 magic 0x0020AF30 | u32 imageCount | u32 imageTableOffset
 *   table: { u32 imageHeaderOffset, u32 paletteHeaderOffset }[imageCount]
 *   image header (0x24): u16 h | u16 w | u32 fmt | u32 data | u32 wrapS | u32 wrapT |
 *                        u32 minF | u32 magF | f32 lodBias | u8 edgeLod | u8 minLod | u8 maxLod | u8 unpacked
 *   palette header (0x0C): u16 count | u8 unpacked | u8 pad | u32 fmt | u32 data
 */
export function parseTpl(src: ArrayBuffer | ArrayBufferView, opts: { decodeMipmaps?: boolean } = {}): TplFile {
  const r = new BEReader(toBytes(src), 'TPL');
  if (r.length < 12 || r.u32(0) !== TPL_MAGIC) throw new FormatError('TPL', 'missing 0x0020AF30 magic');
  const imageCount = r.u32(4);
  const tableOffset = r.u32(8);
  if (imageCount > 1024) throw new FormatError('TPL', `implausible image count ${imageCount}`);
  r.ensure(tableOffset, imageCount * 8, 'image table');

  const images: TplImage[] = [];
  for (let i = 0; i < imageCount; i++) {
    const ih = r.u32(tableOffset + i * 8);
    const ph = r.u32(tableOffset + i * 8 + 4);
    r.ensure(ih, 0x24, `image header #${i}`);
    const height = r.u16(ih);
    const width = r.u16(ih + 2);
    const format = r.u32(ih + 4);
    const dataOffset = r.u32(ih + 8);
    if (!isSupportedFormat(format)) throw new FormatError('TPL', `image #${i}: unsupported format 0x${format.toString(16)}`);

    let palette: TplImage['palette'] = null;
    let paletteRgba: Uint8Array | undefined;
    if (isIndexedFormat(format)) {
      if (!ph) throw new FormatError('TPL', `image #${i}: ${texFormatName(format)} without palette header`);
      r.ensure(ph, 0x0c, `palette header #${i}`);
      const entryCount = r.u16(ph);
      const pfmt = r.u32(ph + 4);
      const pdata = r.u32(ph + 8);
      palette = { format: pfmt, formatName: tlutFormatName(pfmt), entryCount, dataOffset: pdata };
      paletteRgba = decodePalette(r.bytes, pdata, entryCount, pfmt);
    }

    const minLod = r.u8(ih + 0x21);
    const maxLod = r.u8(ih + 0x22);
    const declaredLevels = Math.max(1, maxLod - minLod + 1);

    const mipmaps: TplMipLevel[] = [];
    let off = dataOffset;
    let w = width;
    let h = height;
    for (let level = 0; level < declaredLevels && w >= 1 && h >= 1; level++) {
      const size = textureByteSize(format, w, h);
      if (off + size > r.length) {
        if (level === 0) throw new FormatError('TPL', `image #${i}: pixel data truncated`);
        break;
      }
      const decode = level === 0 || opts.decodeMipmaps;
      mipmaps.push({
        level,
        width: w,
        height: h,
        byteOffset: off,
        byteSize: size,
        rgba: decode ? decodeTexture(r.bytes, off, w, h, format, { palette: paletteRgba }) : new Uint8Array(0),
      });
      off += size;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      if (w === 1 && h === 1 && level + 1 < declaredLevels && mipmaps[mipmaps.length - 1].width === 1) break;
    }

    images.push({
      index: i,
      width,
      height,
      format,
      formatName: texFormatName(format),
      dataOffset,
      wrapS: r.u32(ih + 0x0c),
      wrapT: r.u32(ih + 0x10),
      minFilter: r.u32(ih + 0x14),
      magFilter: r.u32(ih + 0x18),
      lodBias: r.f32(ih + 0x1c),
      edgeLodEnable: r.u8(ih + 0x20) !== 0,
      minLod,
      maxLod,
      palette,
      mipmaps,
    });
  }
  return { imageCount, images };
}
