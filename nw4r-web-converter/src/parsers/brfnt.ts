import { BEReader, FormatError, toBytes } from '../core/binary.ts';
import { decodeTexture, texFormatName } from './gx-texture.ts';

export interface CharWidth {
  /** Pixels to advance before drawing the glyph (can be negative). */
  left: number;
  /** Width in pixels of the glyph image inside its cell. */
  glyphWidth: number;
  /** Total horizontal advance. */
  charWidth: number;
}

export const FONT_ENCODINGS = ['UTF-8', 'UTF-16', 'SJIS', 'CP1252'] as const;

export interface BrfntFile {
  version: number;
  info: {
    fontType: number;
    lineFeed: number;
    alterCharIndex: number;
    defaultWidth: CharWidth;
    encoding: number;
    encodingName: string;
    height: number;
    width: number;
    ascent: number;
  };
  glyphs: {
    cellWidth: number;
    cellHeight: number;
    baselinePos: number;
    maxCharWidth: number;
    sheetSize: number;
    sheetCount: number;
    sheetFormat: number;
    sheetFormatName: string;
    columns: number;
    rows: number;
    sheetWidth: number;
    sheetHeight: number;
    sheetDataOffset: number;
    /** Decoded RGBA8 sheets (sheetWidth * sheetHeight * 4 each). */
    sheets: Uint8Array[];
  };
  /** Width info indexed by glyph index (sparse; missing => defaultWidth). */
  widths: Map<number, CharWidth>;
  /** Code point (in the font's native encoding) -> glyph index. */
  charMap: Map<number, number>;
  cmapBlocks: Array<{ codeBegin: number; codeEnd: number; method: 'direct' | 'table' | 'scan' }>;
  sections: string[];
}

export function isBrfnt(data: Uint8Array): boolean {
  return data.length >= 0x10 && data[0] === 0x52 && data[1] === 0x46 && data[2] === 0x4e && data[3] === 0x54; // RFNT
}

/**
 * Parse an NW4R binary font (RFNT).
 * File header (0x10): "RFNT" | u16 BOM 0xFEFF | u16 version | u32 fileSize | u16 headerSize | u16 sectionCount
 * Sections: FINF (font info), TGLP (glyph sheets), CWDH* (widths), CMAP* (char maps).
 */
export function parseBrfnt(src: ArrayBuffer | ArrayBufferView, opts: { decodeSheets?: boolean } = {}): BrfntFile {
  const r = new BEReader(toBytes(src), 'BRFNT');
  if (!isBrfnt(r.bytes)) throw new FormatError('BRFNT', 'missing "RFNT" magic');
  if (r.u16(4) !== 0xfeff) throw new FormatError('BRFNT', `unexpected BOM 0x${r.u16(4).toString(16)}`);
  const version = r.u16(6);
  const headerSize = r.u16(0x0c);
  const sectionCount = r.u16(0x0e);

  let info: BrfntFile['info'] | undefined;
  let glyphs: BrfntFile['glyphs'] | undefined;
  const widths = new Map<number, CharWidth>();
  const charMap = new Map<number, number>();
  const cmapBlocks: BrfntFile['cmapBlocks'] = [];
  const sections: string[] = [];

  let off = headerSize;
  for (let s = 0; s < sectionCount && off + 8 <= r.length; s++) {
    const magic = r.magic(off);
    const size = r.u32(off + 4);
    if (size < 8) throw new FormatError('BRFNT', `section ${magic} has invalid size ${size}`);
    r.ensure(off, Math.min(size, r.length - off), magic);
    const d = off + 8;
    sections.push(magic);

    switch (magic) {
      case 'FINF': {
        const encoding = r.u8(d + 7);
        info = {
          fontType: r.u8(d),
          lineFeed: r.s8(d + 1),
          alterCharIndex: r.u16(d + 2),
          defaultWidth: { left: r.s8(d + 4), glyphWidth: r.u8(d + 5), charWidth: r.s8(d + 6) },
          encoding,
          encodingName: FONT_ENCODINGS[encoding] ?? `UNKNOWN_${encoding}`,
          // d+8..d+0x13: offsets to TGLP/CWDH/CMAP (we walk sections instead)
          height: r.u8(d + 0x14),
          width: r.u8(d + 0x15),
          ascent: r.u8(d + 0x16),
        };
        break;
      }
      case 'TGLP': {
        const sheetFormat = r.u16(d + 0x0a) & 0x7fff;
        const g = {
          cellWidth: r.u8(d),
          cellHeight: r.u8(d + 1),
          baselinePos: r.s8(d + 2),
          maxCharWidth: r.u8(d + 3),
          sheetSize: r.u32(d + 4),
          sheetCount: r.u16(d + 8),
          sheetFormat,
          sheetFormatName: texFormatName(sheetFormat),
          columns: r.u16(d + 0x0c),
          rows: r.u16(d + 0x0e),
          sheetWidth: r.u16(d + 0x10),
          sheetHeight: r.u16(d + 0x12),
          sheetDataOffset: r.u32(d + 0x14),
          sheets: [] as Uint8Array[],
        };
        if (opts.decodeSheets !== false) {
          for (let i = 0; i < g.sheetCount; i++) {
            g.sheets.push(
              decodeTexture(r.bytes, g.sheetDataOffset + i * g.sheetSize, g.sheetWidth, g.sheetHeight, sheetFormat),
            );
          }
        }
        glyphs = g;
        break;
      }
      case 'CWDH': {
        const start = r.u16(d);
        const end = r.u16(d + 2);
        for (let idx = start, p = d + 8; idx <= end; idx++, p += 3) {
          widths.set(idx, { left: r.s8(p), glyphWidth: r.u8(p + 1), charWidth: r.s8(p + 2) });
        }
        break;
      }
      case 'CMAP': {
        const codeBegin = r.u16(d);
        const codeEnd = r.u16(d + 2);
        const method = r.u16(d + 4);
        const body = d + 0x0c;
        if (method === 0) {
          const base = r.u16(body);
          for (let c = codeBegin; c <= codeEnd; c++) charMap.set(c, base + (c - codeBegin));
          cmapBlocks.push({ codeBegin, codeEnd, method: 'direct' });
        } else if (method === 1) {
          for (let c = codeBegin, p = body; c <= codeEnd; c++, p += 2) {
            const idx = r.u16(p);
            if (idx !== 0xffff) charMap.set(c, idx);
          }
          cmapBlocks.push({ codeBegin, codeEnd, method: 'table' });
        } else if (method === 2) {
          const count = r.u16(body);
          for (let k = 0, p = body + 2; k < count; k++, p += 4) {
            const idx = r.u16(p + 2);
            if (idx !== 0xffff) charMap.set(r.u16(p), idx);
          }
          cmapBlocks.push({ codeBegin, codeEnd, method: 'scan' });
        } else {
          throw new FormatError('BRFNT', `unknown CMAP mapping method ${method}`);
        }
        break;
      }
      default:
        break; // GLGR and other optional sections are ignored
    }
    off += size;
  }

  if (!info) throw new FormatError('BRFNT', 'missing FINF section');
  if (!glyphs) throw new FormatError('BRFNT', 'missing TGLP section');
  return { version, info, glyphs, widths, charMap, cmapBlocks, sections };
}

/** Convert a font-native code to a Unicode string (UTF-16 fonts map 1:1). */
export function codeToUnicode(code: number, encoding: number): string | null {
  try {
    if (encoding === 1 || encoding === 0) return String.fromCodePoint(code);
    const bytes = code > 0xff ? Uint8Array.of(code >> 8, code & 0xff) : Uint8Array.of(code);
    const label = encoding === 2 ? 'shift_jis' : 'windows-1252';
    const s = new TextDecoder(label, { fatal: true }).decode(bytes);
    return s;
  } catch {
    return null;
  }
}
