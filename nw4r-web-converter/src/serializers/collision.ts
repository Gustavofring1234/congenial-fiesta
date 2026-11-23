import { makeAssetId } from '../core/ids.ts';
import { kclTriangles, parseKcl } from '../parsers/kcl.ts';
import { buildGlb } from './glb.ts';
import { type AssetOutput, type ConvertContext, displayName, outputStem, r6 } from './types.ts';

const hex = (n: number) => `0x${n.toString(16).padStart(4, '0')}`;

/**
 * .kcl -> .glb. Triangles are grouped by collision flag: one mesh + node per flag,
 * with { collisionFlag, collisionFlagHex, triangleCount } stored in mesh.extras.
 * Flag semantics are game-specific, so the raw value is preserved untouched.
 */
export function convertKcl(data: Uint8Array, ctx: ConvertContext): AssetOutput {
  const kcl = parseKcl(data);
  const tris = kclTriangles(kcl);
  const assetId = makeAssetId('collision', ctx.sourcePath);
  const glbPath = `${outputStem(ctx.sourcePath)}.glb`;

  const groups = new Map<number, typeof tris>();
  for (const t of tris) {
    let g = groups.get(t.collisionFlag);
    if (!g) groups.set(t.collisionFlag, (g = []));
    g.push(t);
  }
  const flags = [...groups.keys()].sort((a, b) => a - b);

  const meshes = flags.map((flag) => {
    const list = groups.get(flag)!;
    const positions = new Float32Array(list.length * 9);
    const normals = new Float32Array(list.length * 9);
    list.forEach((t, i) => {
      positions.set([...t.a, ...t.b, ...t.c], i * 9);
      for (let v = 0; v < 3; v++) normals.set(t.normal, i * 9 + v * 3);
    });
    return {
      name: `collision_${hex(flag)}`,
      positions,
      normals,
      extras: { collisionFlag: flag, collisionFlagHex: hex(flag), triangleCount: list.length },
    };
  });

  const h = kcl.header;
  const glb = buildGlb({
    meshes,
    sceneName: displayName(ctx.sourcePath),
    sceneExtras: {
      assetId,
      source: ctx.sourcePath,
      kcl: {
        prismThickness: r6(h.prismThickness),
        areaMin: h.areaMin.map(r6),
        sphereRadius: h.sphereRadius === null ? null : r6(h.sphereRadius),
        vertexCount: kcl.positions.length / 3,
        normalCount: kcl.normals.length / 3,
        prismCount: kcl.prisms.length,
      },
    },
  });

  const skipped = kcl.prisms.length - tris.length;
  return {
    asset: {
      assetId,
      kind: 'collision',
      name: displayName(ctx.sourcePath),
      sourcePath: ctx.sourcePath,
      sourceFormat: 'kcl',
      primary: glbPath,
      files: { model: glbPath },
      refs: [],
      unresolvedRefs: [],
      summary: { triangleCount: tris.length, flags: flags.map(hex) },
    },
    files: new Map([[glbPath, glb]]),
    warnings: skipped ? [`${skipped} degenerate prisms skipped`] : [],
  };
}
