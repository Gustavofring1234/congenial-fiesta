import { BEReader, FormatError, toBytes } from '../core/binary.ts';

export type AnimGroup =
  | 'paneSRT'
  | 'textureSRT'
  | 'visibility'
  | 'vertexColor'
  | 'materialColor'
  | 'texturePattern'
  | 'indirectSRT'
  | 'unknown';

export const ANIM_GROUPS: Record<string, AnimGroup> = {
  RLPA: 'paneSRT',
  RLTS: 'textureSRT',
  RLVI: 'visibility',
  RLVC: 'vertexColor',
  RLMC: 'materialColor',
  RLTP: 'texturePattern',
  RLIM: 'indirectSRT',
};

const SRT_TARGETS = ['translate.s', 'translate.t', 'rotate', 'scale.s', 'scale.t'];
const RGBA = ['r', 'g', 'b', 'a'];
const corner = (c: string) => RGBA.map((k) => `vertexColor.${c}.${k}`);

/** Human-readable property names for each (group, targetId). */
export const TARGET_NAMES: Record<AnimGroup, string[]> = {
  paneSRT: ['translate.x', 'translate.y', 'translate.z', 'rotate.x', 'rotate.y', 'rotate.z', 'scale.x', 'scale.y', 'size.width', 'size.height'],
  textureSRT: SRT_TARGETS.map((t) => `texSRT.${t}`),
  indirectSRT: SRT_TARGETS.map((t) => `indSRT.${t}`),
  visibility: ['visible'],
  vertexColor: [...corner('topLeft'), ...corner('topRight'), ...corner('bottomLeft'), ...corner('bottomRight'), 'alpha'],
  materialColor: ['material', 'color0', 'color1', 'color2', 'konst0', 'konst1', 'konst2', 'konst3'].flatMap((c) =>
    RGBA.map((k) => `${c}.${k}`),
  ),
  texturePattern: ['texture'],
  unknown: [],
};

export interface AnimKey {
  frame: number;
  value: number;
  /** Hermite tangent (value units per frame). Absent for step keys. */
  slope?: number;
}

export interface AnimTarget {
  /** Sub-resource index (e.g. which texture SRT / texmap of a material). */
  index: number;
  target: number;
  property: string;
  curve: 'step' | 'hermite';
  keys: AnimKey[];
}

export interface AnimTag {
  magic: string;
  group: AnimGroup;
  targets: AnimTarget[];
}

export interface AnimEntry {
  name: string;
  kind: 'pane' | 'material';
  tags: AnimTag[];
}

export interface BrlanFile {
  /** File magic: RLAN or a split variant (RLPA, RLVI, ...). */
  magic: string;
  version: number;
  frameCount: number;
  loop: boolean;
  /** Texture names referenced by texturePattern (RLTP) keys, by index. */
  textures: string[];
  entries: AnimEntry[];
  sections: string[];
}

/**
 * File magics carrying a pai1 section: "RLAN" (combined) and the split variants
 * that store a single animation group per file (.brlpa, .brlvi, .brlmc, .brlts, ...).
 */
export const BRLAN_MAGICS = ['RLAN', 'RLPA', 'RLTS', 'RLVI', 'RLVC', 'RLMC', 'RLTP', 'RLIM'] as const;

export function isBrlan(data: Uint8Array): boolean {
  if (data.length < 0x10 || data[4] !== 0xfe || data[5] !== 0xff) return false;
  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  return (BRLAN_MAGICS as readonly string[]).includes(magic);
}

/**
 * Parse an NW4R layout animation (RLAN).
 * pai1 section:
 *   +0x08 u16 frameSize | u8 loop | u8 pad | u16 textureCount | u16 entryCount | u32 entryTableOffset
 *   +0x14 u32 textureNameOffsets[textureCount] (relative to +0x14), names follow
 *   entry: char name[20] | u8 tagCount | u8 isMaterial | u16 pad | u32 tagOffsets[] (relative to entry)
 *   tag:   char magic[4] | u8 targetCount | u8 pad[3] | u32 targetOffsets[] (relative to tag)
 *   target: u8 index | u8 target | u8 curveType (1 step, 2 hermite) | u8 pad | u16 keyCount | u16 pad | u32 keysOffset
 *   key: hermite { f32 frame, f32 value, f32 slope } | step { f32 frame, u16 value, u16 pad }
 */
export function parseBrlan(src: ArrayBuffer | ArrayBufferView): BrlanFile {
  const r = new BEReader(toBytes(src), 'BRLAN');
  if (!isBrlan(r.bytes)) throw new FormatError('BRLAN', `missing RLAN magic or BOM (got "${r.magic(0)}")`);
  const version = r.u16(6);
  const headerSize = r.u16(0x0c);
  const sectionCount = r.u16(0x0e);

  const result: BrlanFile = { magic: r.magic(0), version, frameCount: 0, loop: false, textures: [], entries: [], sections: [] };
  let off = headerSize;
  let foundPai1 = false;

  for (let s = 0; s < sectionCount && off + 8 <= r.length; s++) {
    const magic = r.magic(off);
    const size = r.u32(off + 4);
    if (size < 8) throw new FormatError('BRLAN', `section ${magic} has invalid size ${size}`);
    result.sections.push(magic);
    if (magic === 'pai1') {
      foundPai1 = true;
      parsePai1(r, off, result);
    }
    off += size;
  }
  if (!foundPai1) throw new FormatError('BRLAN', 'missing pai1 section');
  return result;
}

function parsePai1(r: BEReader, sec: number, out: BrlanFile): void {
  out.frameCount = r.u16(sec + 8);
  out.loop = r.u8(sec + 0x0a) !== 0;
  const textureCount = r.u16(sec + 0x0c);
  const entryCount = r.u16(sec + 0x0e);
  const entryTable = sec + r.u32(sec + 0x10);

  const texTable = sec + 0x14;
  for (let i = 0; i < textureCount; i++) out.textures.push(r.cstring(texTable + r.u32(texTable + i * 4)));

  for (let e = 0; e < entryCount; e++) {
    const ent = sec + r.u32(entryTable + e * 4);
    const name = r.ascii(ent, 20);
    const tagCount = r.u8(ent + 20);
    const kind = r.u8(ent + 21) ? 'material' : 'pane';
    const tags: AnimTag[] = [];
    for (let t = 0; t < tagCount; t++) {
      const tag = ent + r.u32(ent + 0x18 + t * 4);
      const tmagic = r.magic(tag);
      const group = ANIM_GROUPS[tmagic] ?? 'unknown';
      const targetCount = r.u8(tag + 4);
      const targets: AnimTarget[] = [];
      for (let k = 0; k < targetCount; k++) {
        const tg = tag + r.u32(tag + 8 + k * 4);
        const index = r.u8(tg);
        const target = r.u8(tg + 1);
        const curveType = r.u8(tg + 2);
        const keyCount = r.u16(tg + 4);
        const keysAt = tg + r.u32(tg + 8);
        const keys: AnimKey[] = [];
        let curve: AnimTarget['curve'];
        if (curveType === 2) {
          curve = 'hermite';
          for (let i = 0; i < keyCount; i++) {
            const p = keysAt + i * 12;
            keys.push({ frame: r.f32(p), value: r.f32(p + 4), slope: r.f32(p + 8) });
          }
        } else if (curveType === 1) {
          curve = 'step';
          for (let i = 0; i < keyCount; i++) {
            const p = keysAt + i * 8;
            keys.push({ frame: r.f32(p), value: r.u16(p + 4) });
          }
        } else {
          throw new FormatError('BRLAN', `${name}/${tmagic}: unknown curve type ${curveType}`);
        }
        targets.push({
          index,
          target,
          property: TARGET_NAMES[group][target] ?? `target${target}`,
          curve,
          keys,
        });
      }
      tags.push({ magic: tmagic, group, targets });
    }
    out.entries.push({ name, kind, tags });
  }
}
