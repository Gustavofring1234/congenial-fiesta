/** KCL: colisão (vértices, normais, prismas triangulares e flags de superfície). */
import { BinaryReader, ParseError } from '../binary/reader.ts';

export type Vec3 = [number, number, number];
export interface KclTriangle { a: Vec3; b: Vec3; c: Vec3; normal: Vec3; flag: number; prismIndex: number }
export interface Kcl {
  header: {
    positionsOffset: number; normalsOffset: number; prismsOffset: number; blocksOffset: number;
    prismThickness: number; areaMin: Vec3; areaXWidthMask: number; areaYWidthMask: number; areaZWidthMask: number;
    blockWidthShift: number; areaXBlocksShift: number; areaXYBlocksShift: number; sphereRadius?: number;
  };
  positionCount: number;
  normalCount: number;
  prismCount: number;
  triangles: KclTriangle[];
  /** prismas descartados (normais degeneradas) */
  skipped: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function parseKcl(data: ArrayBuffer | ArrayBufferView): Kcl {
  const r = new BinaryReader(data, 'kcl');
  const posOff = r.u32(0), nrmOff = r.u32(4), prismOff = r.u32(8), blockOff = r.u32(12);
  if (posOff !== 0x38 && posOff !== 0x3c) throw new ParseError('kcl', `cabeçalho inesperado (offset dos vértices 0x${posOff.toString(16)})`);
  if (!(posOff <= nrmOff && nrmOff <= prismOff + 0x10 && prismOff + 0x10 <= blockOff && blockOff <= r.length)) {
    throw new ParseError('kcl', 'offsets das seções fora de ordem ou fora do arquivo');
  }
  const header: Kcl['header'] = {
    positionsOffset: posOff, normalsOffset: nrmOff, prismsOffset: prismOff, blocksOffset: blockOff,
    prismThickness: r.f32(0x10), areaMin: [r.f32(0x14), r.f32(0x18), r.f32(0x1c)],
    areaXWidthMask: r.u32(0x20), areaYWidthMask: r.u32(0x24), areaZWidthMask: r.u32(0x28),
    blockWidthShift: r.u32(0x2c), areaXBlocksShift: r.u32(0x30), areaXYBlocksShift: r.u32(0x34),
  };
  if (posOff === 0x3c) header.sphereRadius = r.f32(0x38);
  const positionCount = Math.floor((nrmOff - posOff) / 12);
  const normalCount = Math.floor((prismOff + 0x10 - nrmOff) / 12);
  const prismCount = Math.floor((blockOff - (prismOff + 0x10)) / 0x10);
  const P = (i: number): Vec3 => {
    if (i >= positionCount) throw new ParseError('kcl', `índice de vértice ${i} >= ${positionCount}`);
    return [r.f32(posOff + i * 12), r.f32(posOff + i * 12 + 4), r.f32(posOff + i * 12 + 8)];
  };
  const N = (i: number): Vec3 => {
    if (i >= normalCount) throw new ParseError('kcl', `índice de normal ${i} >= ${normalCount}`);
    return [r.f32(nrmOff + i * 12), r.f32(nrmOff + i * 12 + 4), r.f32(nrmOff + i * 12 + 8)];
  };
  const triangles: KclTriangle[] = [];
  let skipped = 0;
  for (let i = 0; i < prismCount; i++) {
    const o = prismOff + 0x10 + i * 0x10; // prismas são indexados a partir de 1
    const height = r.f32(o);
    const pi = r.u16(o + 4), fi = r.u16(o + 6), e1 = r.u16(o + 8), e2 = r.u16(o + 10), e3 = r.u16(o + 12);
    const flag = r.u16(o + 14);
    const a = P(pi), fn = N(fi), en3 = N(e3);
    const ca = cross(N(e1), fn), cb = cross(N(e2), fn);
    const da = dot(ca, en3), db = dot(cb, en3);
    if (Math.abs(da) < 1e-12 || Math.abs(db) < 1e-12 || !Number.isFinite(height)) { skipped++; continue; }
    let b = add(a, mul(cb, height / db));
    let c = add(a, mul(ca, height / da));
    if (![...b, ...c].every(Number.isFinite)) { skipped++; continue; }
    // garante sentido anti-horário em relação à normal da face (padrão glTF)
    if (dot(cross(sub(b, a), sub(c, a)), fn) < 0) [b, c] = [c, b];
    triangles.push({ a, b, c, normal: fn, flag, prismIndex: i + 1 });
  }
  return { header, positionCount, normalCount, prismCount, triangles, skipped };
}
