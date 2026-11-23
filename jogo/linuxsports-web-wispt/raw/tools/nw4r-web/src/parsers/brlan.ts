/** BRLAN (RLAN): animações de layout NW4R (seção pai1, com pat1 opcional). */
import { BinaryReader, ParseError } from '../binary/reader.ts';

export type CurveType = 'step' | 'hermite';
export interface BrlanKey { frame: number; value: number; slope: number }
export interface BrlanTrack {
  /** tipo do bloco: RLPA, RLTS, RLVC, RLMC, RLVI, RLTP, RLIM */
  group: string;
  /** índice do sub-alvo (ex.: matriz de textura, mapa de textura) */
  index: number;
  /** código do alvo dentro do grupo */
  target: number;
  property: string;
  interpolation: CurveType;
  keys: BrlanKey[];
}
export interface BrlanTarget { name: string; kind: 'pane' | 'material'; tracks: BrlanTrack[] }
export interface Brlan {
  version: number;
  frameSize: number;
  loop: boolean;
  textures: string[];
  targets: BrlanTarget[];
  groups?: { name: string; panes: string[] }[];
  sections: string[];
}

const RLPA = ['translateX', 'translateY', 'translateZ', 'rotateX', 'rotateY', 'rotateZ', 'scaleX', 'scaleY', 'width', 'height'];
const RLTS = ['translateS', 'translateT', 'rotate', 'scaleS', 'scaleT'];
const corner = ['LT', 'RT', 'LB', 'RB'];
const RLVC = [...corner.flatMap((c) => ['r', 'g', 'b', 'a'].map((ch) => `vertexColor${c}.${ch}`)), 'alpha'];
const RLMC = ['matColor', 'tevColor0', 'tevColor1', 'tevColor2', 'tevKColor0', 'tevKColor1', 'tevKColor2', 'tevKColor3']
  .flatMap((n) => ['r', 'g', 'b', 'a'].map((ch) => `${n}.${ch}`));

export const GROUP_DESCRIPTION: Record<string, string> = {
  RLPA: 'pane-srt', RLTS: 'texture-srt', RLVC: 'vertex-color', RLMC: 'material-color',
  RLVI: 'visibility', RLTP: 'texture-pattern', RLIM: 'indirect-srt',
};

export function propertyName(group: string, target: number): string {
  const t = { RLPA, RLTS, RLIM: RLTS, RLVC, RLMC, RLVI: ['visible'], RLTP: ['textureIndex'] }[group];
  return t?.[target] ?? `${group}_${target}`;
}

/** RLAN e as variantes divididas (.brlpa, .brlvi, .brlmc, ...), que têm o mesmo corpo pai1. */
export const BRLAN_MAGICS = ['RLAN', 'RLPA', 'RLTS', 'RLVI', 'RLVC', 'RLMC', 'RLTP', 'RLIM'];
export const BRLAN_EXTENSIONS = ['.brlan', '.brlpa', '.brlts', '.brlvi', '.brlvc', '.brlmc', '.brltp', '.brlim'];

export function isBrlan(b: Uint8Array): boolean {
  return b.length >= 16 && b[4] === 0xfe && b[5] === 0xff && BRLAN_MAGICS.includes(String.fromCharCode(b[0], b[1], b[2], b[3]));
}

export function parseBrlan(data: ArrayBuffer | ArrayBufferView): Brlan {
  const r = new BinaryReader(data, 'brlan');
  if (!isBrlan(r.slice(0, 16))) throw new ParseError('brlan', `magic inválido: ${r.magic(0)}`);
  if (r.u16(4) !== 0xfeff) throw new ParseError('brlan', 'BOM inválido');
  const version = r.u16(6);
  const headerSize = r.u16(12), count = r.u16(14);
  const sections: string[] = [];
  let o = headerSize;
  let pai1 = -1;
  let groups: Brlan['groups'];
  for (let i = 0; i < count; i++) {
    const m = r.magic(o);
    sections.push(m);
    if (m === 'pai1') pai1 = o;
    if (m === 'pat1') groups = parsePat1(r, o);
    o += r.u32(o + 4);
  }
  if (pai1 < 0) throw new ParseError('brlan', 'seção pai1 ausente');
  const frameSize = r.u16(pai1 + 8);
  const loop = r.u8(pai1 + 10) !== 0;
  const numTex = r.u16(pai1 + 12), numEntries = r.u16(pai1 + 14);
  const entryTable = pai1 + r.u32(pai1 + 16);
  const textures: string[] = [];
  const texBase = pai1 + 0x14;
  for (let i = 0; i < numTex; i++) textures.push(r.cstring(texBase + r.u32(texBase + i * 4)));

  const targets: BrlanTarget[] = [];
  for (let e = 0; e < numEntries; e++) {
    const eo = pai1 + r.u32(entryTable + e * 4);
    const name = r.cstring(eo, 20);
    const numTags = r.u8(eo + 20);
    const isMaterial = r.u8(eo + 21) !== 0;
    const tracks: BrlanTrack[] = [];
    for (let t = 0; t < numTags; t++) {
      const to = eo + r.u32(eo + 24 + t * 4);
      const group = r.magic(to);
      if (!/^RL(PA|TS|VC|MC|VI|TP|IM)$/.test(group)) throw new ParseError('brlan', `bloco de animação desconhecido "${group}" em "${name}"`);
      const n = r.u8(to + 4);
      for (let k = 0; k < n; k++) {
        const io = to + r.u32(to + 8 + k * 4);
        const index = r.u8(io), target = r.u8(io + 1), curve = r.u8(io + 2);
        const keyCount = r.u16(io + 4);
        const ko = io + r.u32(io + 8);
        const step = curve === 1 || group === 'RLVI' || group === 'RLTP';
        const keys: BrlanKey[] = [];
        for (let q = 0; q < keyCount; q++) {
          if (step) keys.push({ frame: r.f32(ko + q * 8), value: r.u16(ko + q * 8 + 4), slope: 0 });
          else keys.push({ frame: r.f32(ko + q * 12), value: r.f32(ko + q * 12 + 4), slope: r.f32(ko + q * 12 + 8) });
        }
        for (let q = 1; q < keys.length; q++) {
          if (keys[q].frame < keys[q - 1].frame) throw new ParseError('brlan', `quadros fora de ordem em "${name}" ${group}`);
        }
        tracks.push({ group, index, target, property: propertyName(group, target), interpolation: step ? 'step' : 'hermite', keys });
      }
    }
    targets.push({ name, kind: isMaterial ? 'material' : 'pane', tracks });
  }
  return { version, frameSize, loop, textures, targets, groups, sections };
}

function parsePat1(r: BinaryReader, o: number): { name: string; panes: string[] }[] {
  // pat1: grupos de panes animados. Formato: u16 ordem, u16 numGrupos, u32 offNome, u32 offGrupos ...
  try {
    const n = r.u16(o + 10);
    const groupsOff = o + r.u32(o + 16);
    const out: { name: string; panes: string[] }[] = [];
    for (let i = 0; i < n; i++) out.push({ name: r.cstring(groupsOff + i * 20, 20), panes: [] });
    return out;
  } catch {
    return [];
  }
}
