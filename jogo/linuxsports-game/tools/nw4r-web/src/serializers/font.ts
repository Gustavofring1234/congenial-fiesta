/** .brfnt -> atlas .png + .font.json (BMFont JSON) */
import { encodePng } from '../binary/png.ts';
import { codeToUnicode, decodeFontSheets, parseBrfnt } from '../parsers/brfnt.ts';
import { SCHEMA_VERSION, type FontJson } from '../schemas/bundle.schema.ts';
import { basename, makeAssetId, stripExt, toPosixPath } from '../binary/ids.ts';
import type { ConvertedFiles } from './texture.ts';

export function fontToWeb(bytes: Uint8Array, source: string, outBase: string): ConvertedFiles & { json: FontJson } {
  const font = parseBrfnt(bytes);
  const g = font.glyph;
  const sheets = decodeFontSheets(font);
  // folhas empilhadas verticalmente num único atlas
  const W = g.sheetWidth, H = g.sheetHeight * g.sheetCount;
  const atlas = new Uint8Array(W * H * 4);
  sheets.forEach((s, i) => atlas.set(s, i * W * g.sheetHeight * 4));
  // fontes só de intensidade (I4/I8): glifo branco com alfa = intensidade, pronto para tingir.
  // IA4/IA8 mantêm a intensidade (pode haver contorno escuro dentro do glifo).
  if (g.sheetFormatName === 'I4' || g.sheetFormatName === 'I8') {
    for (let p = 0; p < atlas.length; p += 4) {
      atlas[p + 3] = atlas[p];
      atlas[p] = atlas[p + 1] = atlas[p + 2] = 255;
    }
  }
  const page = toPosixPath(`${outBase}.png`);
  const perSheet = g.cellsPerRow * g.cellsPerColumn;
  const chars: FontJson['chars'] = [];
  let unmapped = 0;
  const seen = new Set<number>();
  for (const [code, index] of [...font.charMap.entries()].sort((a, b) => a[0] - b[0])) {
    const cp = codeToUnicode(code, font.encoding);
    if (cp === null || seen.has(cp)) { unmapped++; continue; }
    seen.add(cp);
    const sheet = Math.floor(index / perSheet), cell = index % perSheet;
    if (sheet >= g.sheetCount) { unmapped++; continue; }
    const w = font.widths.get(index) ?? font.defaultWidth;
    const col = cell % g.cellsPerRow, row = Math.floor(cell / g.cellsPerRow);
    chars.push({
      id: cp, char: String.fromCodePoint(cp), index,
      x: col * (g.cellWidth + 1) + 1,
      y: sheet * g.sheetHeight + row * (g.cellHeight + 1) + 1,
      width: Math.min(w.glyphWidth, g.cellWidth), height: g.cellHeight,
      xoffset: w.left, yoffset: 0, xadvance: w.charWidth, page: 0, chnl: 15,
    });
  }
  const json: FontJson = {
    format: 'bmfont-json', version: SCHEMA_VERSION, assetId: makeAssetId('font', source), source: toPosixPath(source),
    pages: [page],
    info: { face: stripExt(basename(source)), size: font.height, bold: 0, italic: 0, charset: '', unicode: 1, stretchH: 100, smooth: 1, aa: 1, padding: [0, 0, 0, 0], spacing: [1, 1] },
    common: { lineHeight: font.lineFeed, base: g.baselinePos, scaleW: W, scaleH: H, pages: 1, packed: 0 },
    chars, kernings: [],
    nw4r: {
      encoding: font.encodingName, fontType: font.fontType, alterCharIndex: font.alterCharIndex, defaultWidth: font.defaultWidth,
      cellWidth: g.cellWidth, cellHeight: g.cellHeight, baselinePos: g.baselinePos, maxCharWidth: g.maxCharWidth,
      sheetFormat: g.sheetFormatName, sheetCount: g.sheetCount, sheetWidth: g.sheetWidth, sheetHeight: g.sheetHeight,
      unmappedCodes: unmapped,
    },
  };
  const files = new Map<string, Uint8Array>();
  files.set(page, encodePng(W, H, atlas));
  const main = toPosixPath(`${outBase}.font.json`);
  files.set(main, new TextEncoder().encode(JSON.stringify(json)));
  return { main, files, json };
}
