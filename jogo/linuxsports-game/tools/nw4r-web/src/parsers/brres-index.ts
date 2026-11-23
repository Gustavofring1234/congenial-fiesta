/**
 * BRRES (NW4R G3D): só o índice de pastas e nomes (modelos, texturas, animações).
 * A geometria é convertida para .glb por scripts/brres2glb.py; aqui só ligamos os nomes.
 *
 * Index group: u32 tamanho | u32 n | (n+1) entradas de 16 bytes (a 0 é a raiz):
 *   u16 id | u16 flag | u16 esq | u16 dir | s32 nome | s32 dados   (offsets relativos ao grupo)
 */
import { BinaryReader } from '../binary/reader.ts';

export const BRRES_FOLDERS = {
  '3DModels(NW4R)': 'MDL0', 'Textures(NW4R)': 'TEX0', 'Palettes(NW4R)': 'PLT0',
  'AnmChr(NW4R)': 'CHR0', 'AnmTexSrt(NW4R)': 'SRT0', 'AnmTexPat(NW4R)': 'PAT0', 'AnmClr(NW4R)': 'CLR0',
  'AnmVis(NW4R)': 'VIS0', 'AnmShp(NW4R)': 'SHP0', 'AnmScn(NW4R)': 'SCN0',
} as const;
export type BrresEntryType = (typeof BRRES_FOLDERS)[keyof typeof BRRES_FOLDERS];

export interface BrresIndex {
  folders: Record<string, string[]>;
  models: string[];
  textures: string[];
  animations: Array<{ type: BrresEntryType; name: string }>;
}

export function isBrres(b: Uint8Array): boolean {
  return b.length >= 16 && b[0] === 0x62 && b[1] === 0x72 && b[2] === 0x65 && b[3] === 0x73; // "bres"
}

export function parseBrresIndex(data: ArrayBuffer | ArrayBufferView): BrresIndex {
  const r = new BinaryReader(data, 'brres');
  r.expectMagic(0, 'bres');
  const group = (off: number): Array<[string, number]> => {
    const n = r.u32(off + 4);
    const out: Array<[string, number]> = [];
    for (let i = 1; i <= n; i++) {
      const e = off + 8 + i * 16;
      out.push([r.cstring(off + r.s32(e + 8), 256), off + r.s32(e + 12)]);
    }
    return out;
  };
  const root = r.u16(12);
  const folders: Record<string, string[]> = {};
  for (const [name, off] of group(root + 8)) folders[name] = group(off).map(([n]) => n);
  const pick = (folder: keyof typeof BRRES_FOLDERS) => folders[folder] ?? [];
  const animations: BrresIndex['animations'] = [];
  for (const [folder, type] of Object.entries(BRRES_FOLDERS)) {
    if (!type.endsWith('0') || ['MDL0', 'TEX0', 'PLT0'].includes(type)) continue;
    for (const name of folders[folder] ?? []) animations.push({ type, name });
  }
  return { folders, models: pick('3DModels(NW4R)'), textures: pick('Textures(NW4R)'), animations };
}
