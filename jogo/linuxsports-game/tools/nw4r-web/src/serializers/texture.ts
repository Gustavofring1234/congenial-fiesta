/** .tpl -> .png (um por imagem) + .tex.json */
import { encodePng } from '../binary/png.ts';
import { FILTER_NAME, WRAP_NAME, decodeTplImage, parseTpl } from '../parsers/tpl.ts';
import { SCHEMA_VERSION, type TexJson } from '../schemas/bundle.schema.ts';
import { makeAssetId, toPosixPath } from '../binary/ids.ts';

const GL_WRAP = [33071, 10497, 33648];
const GL_FILTER = [9728, 9729, 9984, 9985, 9986, 9987];

export interface ConvertedFiles { main: string; files: Map<string, Uint8Array> }

export function textureToWeb(bytes: Uint8Array, source: string, outBase: string): ConvertedFiles & { json: TexJson } {
  const tpl = parseTpl(bytes);
  const files = new Map<string, Uint8Array>();
  const images = tpl.images.map((img) => {
    const file = toPosixPath(tpl.images.length === 1 ? `${outBase}.png` : `${outBase}.${img.index}.png`);
    files.set(file, encodePng(img.width, img.height, decodeTplImage(tpl, img)));
    return {
      index: img.index, file, width: img.width, height: img.height, format: img.formatName, formatId: img.format,
      palette: img.palette ? { format: img.palette.formatName, entryCount: img.palette.entryCount } : null,
      wrapS: WRAP_NAME[img.wrapS] ?? 'REPEAT', wrapT: WRAP_NAME[img.wrapT] ?? 'REPEAT',
      minFilter: FILTER_NAME[img.minFilter] ?? `0x${img.minFilter.toString(16)}`,
      magFilter: FILTER_NAME[img.magFilter] ?? `0x${img.magFilter.toString(16)}`,
      lodBias: img.lodBias, minLod: img.minLod, maxLod: img.maxLod, mipmapCount: img.mipmapCount,
      webgl: {
        wrapS: GL_WRAP[img.wrapS] ?? 10497, wrapT: GL_WRAP[img.wrapT] ?? 10497,
        minFilter: GL_FILTER[img.minFilter] ?? 9729, magFilter: img.magFilter === 0 ? 9728 : 9729,
      },
    };
  });
  const json: TexJson = { format: 'nw4r-tex', version: SCHEMA_VERSION, assetId: makeAssetId('texture', source), source: toPosixPath(source), images };
  const main = toPosixPath(`${outBase}.tex.json`);
  files.set(main, new TextEncoder().encode(JSON.stringify(json, null, 1)));
  return { main, files, json };
}
