/** .kcl -> .glb (uma malha por flag de colisão; metadados em mesh.extras) */
import { parseKcl } from '../parsers/kcl.ts';
import { GlbBuilder } from './glb.ts';
import { toPosixPath } from '../binary/ids.ts';
import type { ConvertedFiles } from './texture.ts';

/** Cor estável por flag, só para visualização. */
function flagColor(flag: number): [number, number, number, number] {
  let h = (flag * 2654435761) >>> 0;
  const c = () => { h = (h ^ (h >>> 13)) * 1274126177 >>> 0; return 0.25 + ((h & 0xff) / 255) * 0.7; };
  return [c(), c(), c(), 1];
}

export function collisionToGlb(bytes: Uint8Array, source: string): { glb: Uint8Array; flags: Map<number, number>; triangles: number; skipped: number } {
  const kcl = parseKcl(bytes);
  const groups = new Map<number, typeof kcl.triangles>();
  for (const t of kcl.triangles) {
    if (!groups.has(t.flag)) groups.set(t.flag, []);
    groups.get(t.flag)!.push(t);
  }
  const g = new GlbBuilder();
  g.json.asset.extras = {
    source: toPosixPath(source), format: 'kcl', prismCount: kcl.prismCount, skippedPrisms: kcl.skipped,
    prismThickness: kcl.header.prismThickness, areaMin: kcl.header.areaMin,
  };
  const flags = new Map<number, number>();
  for (const [flag, tris] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const pos = new Float32Array(tris.length * 9);
    const nrm = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => {
      pos.set([...t.a, ...t.b, ...t.c], i * 9);
      const len = Math.hypot(...t.normal) || 1;
      const n = t.normal.map((v) => v / len);
      nrm.set([...n, ...n, ...n], i * 9);
    });
    const idx = Uint32Array.from({ length: tris.length * 3 }, (_, i) => i);
    const hex = `0x${flag.toString(16).padStart(4, '0')}`;
    const material = g.addMaterial({
      name: `collision_${hex}`, doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: flagColor(flag), metallicFactor: 0, roughnessFactor: 1 },
    });
    g.addMeshNode(`collision_${hex}`, {
      attributes: { POSITION: g.addFloatAttribute(pos, 'VEC3', true), NORMAL: g.addFloatAttribute(nrm, 'VEC3') },
      indices: g.addIndices(idx), material,
    }, { collisionFlag: flag, collisionFlagHex: hex, triangleCount: tris.length });
    flags.set(flag, tris.length);
  }
  return { glb: g.build(), flags, triangles: kcl.triangles.length, skipped: kcl.skipped };
}

export function collisionToWeb(bytes: Uint8Array, source: string, outBase: string): ConvertedFiles {
  const main = toPosixPath(`${outBase}.glb`);
  return { main, files: new Map([[main, collisionToGlb(bytes, source).glb]]) };
}
