/**
 * PMP ("PMPF"): posicionamento de objetos dos cursos de golfe.
 *
 * 0x10 u16 número de objetos | 0x40 u32 offset da tabela (0x80) | registros de 0x58 bytes:
 *   +0x02 u16 id do tipo | +0x04 u16 variante | +0x08 posição xyz | +0x14 escala xyz |
 *   +0x20, +0x2C, +0x38 três vetores de base | +0x44 s32 pai (-1 em todos os arquivos vistos)
 *
 * Os três vetores ficam na ordem Z, Y, X: lidos assim, formam uma rotação própria (det = +1);
 * na ordem em que aparecem, o determinante é -1. É uma hipótese consistente em todos os
 * objetos do projeto, não confirmada no código do jogo.
 */
import { BinaryReader } from '../binary/reader.ts';

type V3 = [number, number, number];
export interface PmpObject { typeId: number; variant: number; position: V3; scale: V3; axes: { x: V3; y: V3; z: V3 }; parent: number }

export function isPmp(b: Uint8Array): boolean {
  return b.length >= 0x80 && b[0] === 0x50 && b[1] === 0x4d && b[2] === 0x50 && b[3] === 0x46; // PMPF
}

export function parsePmp(data: ArrayBuffer | ArrayBufferView): PmpObject[] {
  const r = new BinaryReader(data, 'pmp');
  r.expectMagic(0, 'PMPF');
  const count = r.u16(0x10);
  const table = r.u32(0x40);
  r.ensure(table, count * 0x58, 'tabela de objetos');
  const v3 = (o: number): V3 => [r.f32(o), r.f32(o + 4), r.f32(o + 8)];
  const out: PmpObject[] = [];
  for (let i = 0; i < count; i++) {
    const o = table + i * 0x58;
    out.push({
      typeId: r.u16(o + 2),
      variant: r.u16(o + 4),
      position: v3(o + 8),
      scale: v3(o + 0x14),
      axes: { z: v3(o + 0x20), y: v3(o + 0x2c), x: v3(o + 0x38) },
      parent: r.s32(o + 0x44),
    });
  }
  return out;
}
