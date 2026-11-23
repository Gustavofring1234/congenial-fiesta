import { BEReader, FormatError, toBytes } from '../core/binary.ts';

export interface KclPrism {
  height: number;
  posIndex: number;
  faceNormal: number;
  edgeNormals: [number, number, number];
  collisionFlag: number;
}

export interface KclTriangle {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  normal: [number, number, number];
  collisionFlag: number;
}

export interface KclFile {
  header: {
    positionsOffset: number;
    normalsOffset: number;
    prismsOffset: number;
    octreeOffset: number;
    prismThickness: number;
    areaMin: [number, number, number];
    areaXWidthMask: number;
    areaYWidthMask: number;
    areaZWidthMask: number;
    blockWidthShift: number;
    areaXBlocksShift: number;
    areaXYBlocksShift: number;
    sphereRadius: number | null;
  };
  positions: Float32Array;
  normals: Float32Array;
  prisms: KclPrism[];
}

/** KCL has no magic: validate the header offsets instead. */
export function looksLikeKcl(data: Uint8Array): boolean {
  if (data.length < 0x3c) return false;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pos = v.getUint32(0), nrm = v.getUint32(4), pri = v.getUint32(8), oct = v.getUint32(12);
  return (
    (pos === 0x38 || pos === 0x3c) &&
    pos < nrm && nrm <= pri + 0x10 && pri < oct && oct <= data.length &&
    (nrm - pos) % 12 === 0 && (oct - pri) % 0x10 === 0
  );
}

/**
 * Parse a Wii KCL collision file.
 * Header: u32 posOff | u32 nrmOff | u32 prismOff (1-indexed: entry 0 is unused) | u32 octreeOff |
 *         f32 thickness | vec3 areaMin | u32 x/y/z masks | u32 shifts x3 | [f32 sphereRadius when header is 0x3C]
 * Prism (0x10): f32 height | u16 posIdx | u16 faceNrm | u16 edgeNrm[3] | u16 flag
 */
export function parseKcl(src: ArrayBuffer | ArrayBufferView): KclFile {
  const r = new BEReader(toBytes(src), 'KCL');
  if (!looksLikeKcl(r.bytes)) throw new FormatError('KCL', 'header offsets are not consistent with a KCL file');
  const positionsOffset = r.u32(0);
  const normalsOffset = r.u32(4);
  const prismsOffset = r.u32(8);
  const octreeOffset = r.u32(12);

  const header: KclFile['header'] = {
    positionsOffset,
    normalsOffset,
    prismsOffset,
    octreeOffset,
    prismThickness: r.f32(0x10),
    areaMin: [r.f32(0x14), r.f32(0x18), r.f32(0x1c)],
    areaXWidthMask: r.u32(0x20),
    areaYWidthMask: r.u32(0x24),
    areaZWidthMask: r.u32(0x28),
    blockWidthShift: r.u32(0x2c),
    areaXBlocksShift: r.u32(0x30),
    areaXYBlocksShift: r.u32(0x34),
    sphereRadius: positionsOffset >= 0x3c ? r.f32(0x38) : null,
  };

  const readVec3s = (start: number, end: number) => {
    const n = Math.floor((end - start) / 12);
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) out[i] = r.f32(start + i * 4);
    return out;
  };
  const positions = readVec3s(positionsOffset, normalsOffset);
  // Normals end where the first real prism (index 1) starts.
  const normals = readVec3s(normalsOffset, prismsOffset + 0x10);

  const prismCount = (octreeOffset - prismsOffset) / 0x10 - 1;
  const prisms: KclPrism[] = [];
  const vcount = positions.length / 3;
  const ncount = normals.length / 3;
  for (let i = 0; i < prismCount; i++) {
    const p = prismsOffset + 0x10 * (i + 1);
    const prism: KclPrism = {
      height: r.f32(p),
      posIndex: r.u16(p + 4),
      faceNormal: r.u16(p + 6),
      edgeNormals: [r.u16(p + 8), r.u16(p + 10), r.u16(p + 12)],
      collisionFlag: r.u16(p + 14),
    };
    if (prism.posIndex >= vcount) throw new FormatError('KCL', `prism ${i + 1}: vertex index ${prism.posIndex} >= ${vcount}`);
    for (const n of [prism.faceNormal, ...prism.edgeNormals]) {
      if (n >= ncount) throw new FormatError('KCL', `prism ${i + 1}: normal index ${n} >= ${ncount}`);
    }
    prisms.push(prism);
  }
  return { header, positions, normals, prisms };
}

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/**
 * Reconstruct triangles from prisms:
 *   A = pos; crossA = edgeNrm1 x faceNrm; crossB = edgeNrm2 x faceNrm
 *   B = A + crossB * (height / dot(crossB, edgeNrm3))
 *   C = A + crossA * (height / dot(crossA, edgeNrm3))
 * Degenerate prisms (non-finite results) are skipped.
 */
export function kclTriangles(kcl: KclFile): KclTriangle[] {
  const vec = (arr: Float32Array, i: number): V3 => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
  const tris: KclTriangle[] = [];
  for (const p of kcl.prisms) {
    const a = vec(kcl.positions, p.posIndex);
    const fn = vec(kcl.normals, p.faceNormal);
    const e1 = vec(kcl.normals, p.edgeNormals[0]);
    const e2 = vec(kcl.normals, p.edgeNormals[1]);
    const e3 = vec(kcl.normals, p.edgeNormals[2]);
    const crossA = cross(e1, fn);
    const crossB = cross(e2, fn);
    let b = add(a, crossB, p.height / dot(crossB, e3));
    let c = add(a, crossA, p.height / dot(crossA, e3));
    if (![...b, ...c].every(Number.isFinite)) continue;
    // Ensure counter-clockwise winding w.r.t. the face normal (glTF front faces).
    const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    if (dot(n, fn) < 0) [b, c] = [c, b];
    tris.push({ a, b, c, normal: fn, collisionFlag: p.collisionFlag });
  }
  return tris;
}
