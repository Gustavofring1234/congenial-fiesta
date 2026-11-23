/** BRFNT (RFNT): fonte bitmap NW4R com seções FINF, TGLP, CWDH e CMAP. */
import { BinaryReader, ParseError } from '../binary/reader.ts';
import { GX_FORMAT_NAME, decodeGxImage } from '../codecs/gx.ts';

export const FONT_ENCODING = ['UTF-8', 'UTF-16', 'SJIS', 'CP1252'] as const;

export interface GlyphWidth { left: number; glyphWidth: number; charWidth: number }
export interface Brfnt {
  version: number;
  fontType: number;
  lineFeed: number;
  alterCharIndex: number;
  defaultWidth: GlyphWidth;
  encoding: number;
  encodingName: string;
  height: number;
  width: number;
  ascent: number;
  glyph: {
    cellWidth: number; cellHeight: number; baselinePos: number; maxCharWidth: number;
    sheetSize: number; sheetCount: number; sheetFormat: number; sheetFormatName: string;
    cellsPerRow: number; cellsPerColumn: number; sheetWidth: number; sheetHeight: number; sheetDataOffset: number;
  };
  /** larguras por índice de glifo */
  widths: Map<number, GlyphWidth>;
  /** código de caractere (na codificação da fonte) -> índice de glifo */
  charMap: Map<number, number>;
  sections: string[];
  bytes: Uint8Array;
}

export function isBrfnt(b: Uint8Array): boolean {
  return b.length >= 16 && b[0] === 0x52 && b[1] === 0x46 && b[2] === 0x4e && b[3] === 0x54;
}

export function parseBrfnt(data: ArrayBuffer | ArrayBufferView): Brfnt {
  const r = new BinaryReader(data, 'brfnt');
  r.expectMagic(0, 'RFNT');
  if (r.u16(4) !== 0xfeff) throw new ParseError('brfnt', 'BOM inválido (esperado big-endian 0xFEFF)');
  const version = r.u16(6);
  const headerSize = r.u16(12);
  const sectionCount = r.u16(14);
  const sections: string[] = [];
  let o = headerSize;
  for (let i = 0; i < sectionCount && o + 8 <= r.length; i++) {
    sections.push(r.magic(o));
    const sz = r.u32(o + 4);
    if (sz < 8) throw new ParseError('brfnt', `seção ${r.magic(o)} com tamanho inválido`);
    o += sz;
  }
  const finf = headerSize;
  r.expectMagic(finf, 'FINF');
  const f = finf + 8;
  const tglpOff = r.u32(f + 8), cwdhOff = r.u32(f + 12), cmapOff = r.u32(f + 16);
  const encoding = r.u8(f + 7);

  // offsets apontam para os dados (8 bytes após o cabeçalho da seção)
  r.expectMagic(tglpOff - 8, 'TGLP');
  const t = tglpOff;
  const sheetFormatRaw = r.u16(t + 10);
  const glyph = {
    cellWidth: r.u8(t), cellHeight: r.u8(t + 1), baselinePos: r.s8(t + 2), maxCharWidth: r.u8(t + 3),
    sheetSize: r.u32(t + 4), sheetCount: r.u16(t + 8), sheetFormat: sheetFormatRaw & 0x7fff,
    sheetFormatName: GX_FORMAT_NAME[sheetFormatRaw & 0x7fff] ?? `0x${sheetFormatRaw.toString(16)}`,
    cellsPerRow: r.u16(t + 12), cellsPerColumn: r.u16(t + 14), sheetWidth: r.u16(t + 16), sheetHeight: r.u16(t + 18),
    sheetDataOffset: r.u32(t + 20),
  };
  if (sheetFormatRaw & 0x8000) throw new ParseError('brfnt', 'folhas de glifo comprimidas não são suportadas');
  if (glyph.cellsPerRow * (glyph.cellWidth + 1) > glyph.sheetWidth || glyph.cellsPerColumn * (glyph.cellHeight + 1) > glyph.sheetHeight) {
    throw new ParseError('brfnt', 'grade de células não cabe na folha de glifos');
  }
  r.ensure(glyph.sheetDataOffset, glyph.sheetSize * glyph.sheetCount, 'folhas de glifos');

  const widths = new Map<number, GlyphWidth>();
  for (let c = cwdhOff, guard = 0; c && guard < 256; guard++) {
    r.expectMagic(c - 8, 'CWDH');
    const start = r.u16(c), end = r.u16(c + 2), next = r.u32(c + 4);
    for (let i = start; i <= end; i++) {
      const e = c + 8 + (i - start) * 3;
      widths.set(i, { left: r.s8(e), glyphWidth: r.u8(e + 1), charWidth: r.s8(e + 2) });
    }
    c = next;
  }

  const charMap = new Map<number, number>();
  for (let c = cmapOff, guard = 0; c && guard < 4096; guard++) {
    r.expectMagic(c - 8, 'CMAP');
    const begin = r.u16(c), end = r.u16(c + 2), method = r.u16(c + 4), next = r.u32(c + 8);
    const m = c + 12;
    if (method === 0) {
      const base = r.u16(m);
      for (let code = begin; code <= end; code++) charMap.set(code, base + (code - begin));
    } else if (method === 1) {
      for (let code = begin; code <= end; code++) {
        const idx = r.u16(m + (code - begin) * 2);
        if (idx !== 0xffff) charMap.set(code, idx);
      }
    } else if (method === 2) {
      const n = r.u16(m);
      for (let i = 0; i < n; i++) charMap.set(r.u16(m + 2 + i * 4), r.u16(m + 4 + i * 4));
    } else {
      throw new ParseError('brfnt', `método de CMAP desconhecido ${method}`);
    }
    c = next;
  }

  return {
    version, fontType: r.u8(f), lineFeed: r.s8(f + 1), alterCharIndex: r.u16(f + 2),
    defaultWidth: { left: r.s8(f + 4), glyphWidth: r.u8(f + 5), charWidth: r.s8(f + 6) },
    encoding, encodingName: FONT_ENCODING[encoding] ?? `desconhecida(${encoding})`,
    height: r.u8(f + 20), width: r.u8(f + 21), ascent: r.u8(f + 22),
    glyph, widths, charMap, sections, bytes: r.bytes,
  };
}

/** Decodifica cada folha de glifos para RGBA. */
export function decodeFontSheets(font: Brfnt): Uint8Array[] {
  const g = font.glyph;
  return Array.from({ length: g.sheetCount }, (_, i) =>
    decodeGxImage(font.bytes, g.sheetDataOffset + i * g.sheetSize, g.sheetWidth, g.sheetHeight, g.sheetFormat));
}

/** Converte o código da fonte em ponto de código Unicode. */
export function codeToUnicode(code: number, encoding: number): number | null {
  if (encoding === 0 || encoding === 1) return code;
  const bytes = code > 0xff ? [code >> 8, code & 0xff] : [code];
  try {
    const label = encoding === 2 ? 'shift_jis' : 'windows-1252';
    const s = new TextDecoder(label, { fatal: true }).decode(Uint8Array.from(bytes));
    const cp = s.codePointAt(0);
    return cp === undefined ? null : cp;
  } catch {
    return null;
  }
}
