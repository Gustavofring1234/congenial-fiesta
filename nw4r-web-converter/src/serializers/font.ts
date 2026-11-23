import { basename, makeAssetId } from '../core/ids.ts';
import { GXTexFmt } from '../parsers/gx-texture.ts';
import { codeToUnicode, parseBrfnt } from '../parsers/brfnt.ts';
import type { FontMeta } from '../schemas/bundle.schema.ts';
import { encodePng } from './png.ts';
import { type AssetOutput, type ConvertContext, displayName, jsonBytes, outputStem, r6 } from './types.ts';

/**
 * .brfnt -> .atlas.png + .font.json (BMFont JSON layout).
 *
 * All glyph sheets are tiled into a single atlas (near-square grid of sheets).
 * Intensity-only sheets (I4/I8) become white glyphs with alpha = intensity, which
 * is how NW4R renders them, so the atlas can be tinted directly on the web.
 */
export function convertBrfnt(data: Uint8Array, ctx: ConvertContext): AssetOutput {
  const font = parseBrfnt(data);
  const g = font.glyphs;
  const stem = outputStem(ctx.sourcePath);
  const assetId = makeAssetId('font', ctx.sourcePath);
  const metaPath = `${stem}.font.json`;
  const atlasPath = `${stem}.atlas.png`;
  const warnings: string[] = [];

  // ---- atlas
  const gridCols = Math.max(1, Math.ceil(Math.sqrt(g.sheetCount)));
  const gridRows = Math.max(1, Math.ceil(g.sheetCount / gridCols));
  const atlasW = gridCols * g.sheetWidth;
  const atlasH = gridRows * g.sheetHeight;
  const atlas = new Uint8Array(atlasW * atlasH * 4);
  const whiten = g.sheetFormat === GXTexFmt.I4 || g.sheetFormat === GXTexFmt.I8;
  const sheetRects = g.sheets.map((sheet, i) => {
    const x0 = (i % gridCols) * g.sheetWidth;
    const y0 = Math.floor(i / gridCols) * g.sheetHeight;
    for (let y = 0; y < g.sheetHeight; y++) {
      const src = y * g.sheetWidth * 4;
      const dst = ((y0 + y) * atlasW + x0) * 4;
      atlas.set(sheet.subarray(src, src + g.sheetWidth * 4), dst);
      if (whiten) for (let p = dst; p < dst + g.sheetWidth * 4; p += 4) atlas[p] = atlas[p + 1] = atlas[p + 2] = 255;
    }
    return { x: x0, y: y0, width: g.sheetWidth, height: g.sheetHeight };
  });

  // ---- glyphs
  const perSheet = g.columns * g.rows;
  const totalCells = perSheet * g.sheetCount;
  const yoffset = font.info.ascent - g.baselinePos;
  const chars: FontMeta['chars'] = [];
  let unmappable = 0;
  let fallbackChar: number | null = null;

  for (const [code, index] of [...font.charMap.entries()].sort((a, b) => a[0] - b[0])) {
    if (index >= totalCells) { warnings.push(`glyph index ${index} for code 0x${code.toString(16)} is outside the sheets`); continue; }
    const ch = codeToUnicode(code, font.info.encoding);
    if (ch === null) { unmappable++; continue; }
    const id = ch.codePointAt(0)!;
    if (index === font.info.alterCharIndex && fallbackChar === null) fallbackChar = id;
    const w = font.widths.get(index) ?? font.info.defaultWidth;
    const sheet = Math.floor(index / perSheet);
    const cell = index % perSheet;
    const x = sheetRects[sheet].x + (cell % g.columns) * (g.cellWidth + 1);
    const y = sheetRects[sheet].y + Math.floor(cell / g.columns) * (g.cellHeight + 1);
    const width = Math.min(w.glyphWidth, g.cellWidth);
    chars.push({
      id,
      char: ch,
      index,
      x,
      y,
      width,
      height: g.cellHeight,
      xoffset: w.left,
      yoffset,
      xadvance: w.charWidth,
      page: 0,
      chnl: 15,
      uv: [r6(x / atlasW), r6(y / atlasH), r6((x + width) / atlasW), r6((y + g.cellHeight) / atlasH)],
    });
  }
  if (unmappable) warnings.push(`${unmappable} codes could not be mapped from ${font.info.encodingName} to Unicode`);

  const meta: FontMeta = {
    format: 'nw4r-web/font',
    version: 1,
    assetId,
    name: displayName(ctx.sourcePath),
    source: ctx.sourcePath,
    pages: [basename(atlasPath)],
    info: {
      face: displayName(ctx.sourcePath).replace(/\.brfnt$/i, ''),
      size: font.info.height,
      bold: 0,
      italic: 0,
      charset: '',
      unicode: 1,
      stretchH: 100,
      smooth: 1,
      aa: 1,
      padding: [0, 0, 0, 0],
      spacing: [1, 1],
    },
    common: { lineHeight: font.info.lineFeed, base: font.info.ascent, scaleW: atlasW, scaleH: atlasH, pages: 1, packed: 0 },
    chars,
    kernings: [],
    nw4r: {
      encoding: font.info.encodingName,
      fontType: font.info.fontType,
      sheetFormat: g.sheetFormatName,
      cellWidth: g.cellWidth,
      cellHeight: g.cellHeight,
      baselinePos: g.baselinePos,
      maxCharWidth: g.maxCharWidth,
      ascent: font.info.ascent,
      defaultWidth: font.info.defaultWidth,
      fallbackChar,
      sheets: sheetRects,
    },
  };

  const files = new Map<string, Uint8Array>([
    [atlasPath, encodePng(atlas, atlasW, atlasH)],
    [metaPath, jsonBytes(meta)],
  ]);
  return {
    asset: {
      assetId,
      kind: 'font',
      name: meta.name,
      sourcePath: ctx.sourcePath,
      sourceFormat: 'brfnt',
      primary: metaPath,
      files: { meta: metaPath, atlas: atlasPath },
      refs: [],
      unresolvedRefs: [],
      summary: { glyphCount: chars.length, lineHeight: font.info.lineFeed, atlasWidth: atlasW, atlasHeight: atlasH, sheetFormat: g.sheetFormatName },
    },
    files,
    warnings,
  };
}
