import { basename, makeAssetId } from '../core/ids.ts';
import { GX_FILTER, GX_WRAP, WEBGL_FILTER, WEBGL_WRAP, parseTpl, type TplFile } from '../parsers/tpl.ts';
import type { TextureMeta } from '../schemas/bundle.schema.ts';
import { encodePng } from './png.ts';
import { type AssetOutput, type ConvertContext, displayName, jsonBytes, outputStem, r6 } from './types.ts';

const pick = <T extends readonly string[]>(table: T, v: number, fallback: T[number]): T[number] => table[v] ?? fallback;

/** .tpl -> one .png per image + .tex.json */
export function convertTpl(data: Uint8Array, ctx: ConvertContext): AssetOutput {
  const tpl: TplFile = parseTpl(data);
  const stem = outputStem(ctx.sourcePath);
  const assetId = makeAssetId('texture', ctx.sourcePath);
  const files = new Map<string, Uint8Array>();
  const fileRoles: Record<string, string> = {};
  const metaPath = `${stem}.tex.json`;

  const images: TextureMeta['images'] = tpl.images.map((img, i) => {
    const pngPath = i === 0 ? `${stem}.png` : `${stem}.${i}.png`;
    const base = img.mipmaps[0];
    files.set(pngPath, encodePng(base.rgba, base.width, base.height));
    fileRoles[i === 0 ? 'image' : `image${i}`] = pngPath;
    return {
      index: i,
      file: basename(pngPath),
      width: img.width,
      height: img.height,
      gxFormat: img.formatName,
      gxFormatId: img.format,
      sampler: {
        wrapS: pick(GX_WRAP, img.wrapS, 'CLAMP'),
        wrapT: pick(GX_WRAP, img.wrapT, 'CLAMP'),
        minFilter: pick(GX_FILTER, img.minFilter, 'LINEAR'),
        magFilter: pick(GX_FILTER, img.magFilter, 'LINEAR'),
        lodBias: r6(img.lodBias),
        edgeLodEnable: img.edgeLodEnable,
        minLod: img.minLod,
        maxLod: img.maxLod,
        webgl: {
          wrapS: pick(WEBGL_WRAP, img.wrapS, 'CLAMP_TO_EDGE'),
          wrapT: pick(WEBGL_WRAP, img.wrapT, 'CLAMP_TO_EDGE'),
          minFilter: pick(WEBGL_FILTER, img.minFilter, 'LINEAR'),
          // WebGL mag filter only accepts NEAREST/LINEAR.
          magFilter: img.magFilter === 0 ? 'NEAREST' : 'LINEAR',
        },
      },
      mipmaps: img.mipmaps.map((m) => ({ level: m.level, width: m.width, height: m.height })),
      palette: img.palette ? { format: img.palette.formatName, entryCount: img.palette.entryCount } : null,
    };
  });

  const meta: TextureMeta = {
    format: 'nw4r-web/texture',
    version: 1,
    assetId,
    name: displayName(ctx.sourcePath),
    source: ctx.sourcePath,
    images,
  };
  files.set(metaPath, jsonBytes(meta));

  return {
    asset: {
      assetId,
      kind: 'texture',
      name: meta.name,
      sourcePath: ctx.sourcePath,
      sourceFormat: 'tpl',
      primary: metaPath,
      files: { meta: metaPath, ...fileRoles },
      refs: [],
      unresolvedRefs: [],
      summary: { width: images[0].width, height: images[0].height, gxFormat: images[0].gxFormat, imageCount: images.length },
    },
    files,
    warnings: [],
  };
}
