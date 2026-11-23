/** .brlan -> .anim.json */
import { GROUP_DESCRIPTION, parseBrlan } from '../parsers/brlan.ts';
import { SCHEMA_VERSION, type AnimJson } from '../schemas/bundle.schema.ts';
import { makeAssetId, toPosixPath } from '../binary/ids.ts';
import type { ConvertedFiles } from './texture.ts';

export type Resolver = (name: string, kind: 'texture' | 'font' | 'layout') => string | null;

export function animToWeb(bytes: Uint8Array, source: string, outBase: string, resolve: Resolver, layoutName: string | null = null): ConvertedFiles & { json: AnimJson } {
  const a = parseBrlan(bytes);
  const json: AnimJson = {
    format: 'nw4r-anim', version: SCHEMA_VERSION, assetId: makeAssetId('animation', source), source: toPosixPath(source),
    frameSize: a.frameSize, loop: a.loop,
    textures: a.textures.map((name) => ({ name, ref: resolve(name, 'texture') })),
    layout: layoutName ? { name: layoutName, ref: resolve(layoutName, 'layout') } : null,
    targets: a.targets.map((t) => ({
      name: t.name, kind: t.kind,
      tracks: t.tracks.filter((tr) => tr.keys.length > 0).map((tr) => ({
        group: tr.group as AnimJson['targets'][number]['tracks'][number]['group'],
        groupName: GROUP_DESCRIPTION[tr.group] ?? tr.group,
        index: tr.index, target: tr.target, property: tr.property, interpolation: tr.interpolation, keys: tr.keys,
      })),
    })),
  };
  const main = toPosixPath(`${outBase}.anim.json`);
  return { main, files: new Map([[main, new TextEncoder().encode(JSON.stringify(json))]]), json };
}
