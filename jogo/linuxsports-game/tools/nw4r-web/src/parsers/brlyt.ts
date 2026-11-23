/**
 * BRLYT (RLYT, layout de interface NW4R).
 *
 * Seções: lyt1 (tamanho da tela), txl1 (texturas), fnl1 (fontes), mat1 (materiais),
 * pan1/pic1/txt1/wnd1/bnd1 (painéis), pas1/pae1 (abre/fecha filhos), grp1 + grs1/gre1 (grupos).
 *
 * Painel (a partir do início da seção): +8 u8 flags | +9 u8 origem | +0xA u8 alfa | +0xC nome[16] |
 * +0x1C userData[8] | +0x24 translação xyz | +0x30 rotação xyz | +0x3C escala xy | +0x44 tamanho wh.
 *
 * Material: nome[20] | tevColor s16x4 x3 | konst u8x4 x4 | u32 flags | blocos opcionais na ordem
 * TexMap, TexSRT, TexCoordGen, ChanCtrl, MatColor, TevSwap, IndSRT, IndStage, TevStage, AlphaCmp, Blend.
 * (Ordem verificada: o tamanho calculado bate com o offset do material seguinte em 2.923/2.923 materiais.)
 */
import { BinaryReader, ParseError } from '../binary/reader.ts';

export type Rgba = [number, number, number, number];
export type Vec2 = [number, number];
export type TexCoordQuad = [Vec2, Vec2, Vec2, Vec2]; // TL, TR, BL, BR

export interface LayoutTexMap { texture: number; wrapS: number; wrapT: number }
export interface LayoutTexSrt { translate: Vec2; rotate: number; scale: Vec2 }

export interface LayoutMaterial {
  name: string;
  /** registradores TEV (s16): [0] = cor "preta" e [1] = cor "branca" usadas com texturas I/IA; [2] = livre */
  tevColors: [Rgba, Rgba, Rgba];
  konstColors: [Rgba, Rgba, Rgba, Rgba];
  /** cor do material (multiplica o resultado); null = branco */
  color: Rgba | null;
  textureMaps: LayoutTexMap[];
  texSrt: LayoutTexSrt[];
  texCoordGenCount: number;
  tevStageCount: number;
  alphaCompare: number[] | null;
  /** [tipo, srcFactor, dstFactor, op] em valores GX; null = mistura alfa padrão */
  blendMode: number[] | null;
}

export type PaneType = 'pane' | 'picture' | 'text' | 'window' | 'bounding';

export interface LayoutQuad { material: number; vertexColors: [Rgba, Rgba, Rgba, Rgba]; texCoords: TexCoordQuad[] }

export interface LayoutPane {
  type: PaneType;
  name: string;
  userData: string;
  visible: boolean;
  influencedAlpha: boolean;
  locationAdjust: boolean;
  /** 0..8: coluna = origin % 3 (esq, centro, dir), linha = floor(origin / 3) (topo, centro, base) */
  origin: number;
  alpha: number;
  translate: [number, number, number];
  rotate: [number, number, number];
  scale: Vec2;
  size: Vec2;
  picture?: LayoutQuad;
  text?: {
    material: number;
    font: number;
    text: string;
    maxChars: number;
    textOrigin: number;
    alignment: number;
    colors: [Rgba, Rgba];
    fontSize: Vec2;
    charSpace: number;
    lineSpace: number;
  };
  window?: {
    inflation: [number, number, number, number];
    content: LayoutQuad;
    frames: Array<{ material: number; flip: number }>;
  };
  children: LayoutPane[];
}

export interface LayoutGroup { name: string; panes: string[]; children: LayoutGroup[] }

export interface BrlytFile {
  version: number;
  centered: boolean;
  width: number;
  height: number;
  textures: string[];
  fonts: string[];
  materials: LayoutMaterial[];
  root: LayoutPane | null;
  groups: LayoutGroup[];
  sections: string[];
}

export interface BrlytRefs { textures: string[]; fonts: string[]; materials: string[]; panes: string[]; sections: string[] }

export function isBrlyt(b: Uint8Array): boolean {
  return b.length >= 16 && b[0] === 0x52 && b[1] === 0x4c && b[2] === 0x59 && b[3] === 0x54;
}

const PANE_TYPES: Record<string, PaneType> = { pan1: 'pane', pic1: 'picture', txt1: 'text', wnd1: 'window', bnd1: 'bounding' };

const bits = (v: number, shift: number, n: number) => (v >>> shift) & ((1 << n) - 1);

function rgba(r: BinaryReader, o: number): Rgba {
  return [r.u8(o), r.u8(o + 1), r.u8(o + 2), r.u8(o + 3)];
}

function quad(r: BinaryReader, o: number): { q: LayoutQuad; end: number } {
  const vertexColors = [rgba(r, o), rgba(r, o + 4), rgba(r, o + 8), rgba(r, o + 12)] as LayoutQuad['vertexColors'];
  const material = r.u16(o + 16);
  const n = r.u8(o + 18);
  const texCoords: TexCoordQuad[] = [];
  let p = o + 20;
  for (let i = 0; i < n; i++) {
    const v: Vec2[] = [];
    for (let k = 0; k < 4; k++, p += 8) v.push([r.f32(p), r.f32(p + 4)]);
    texCoords.push(v as TexCoordQuad);
  }
  return { q: { material, vertexColors, texCoords }, end: p };
}

function nameList(r: BinaryReader, sec: number): string[] {
  const n = r.u16(sec + 8);
  const base = sec + 12;
  const out: string[] = [];
  for (let k = 0; k < n; k++) out.push(r.cstring(base + r.u32(base + k * 8)));
  return out;
}

function parseMaterial(r: BinaryReader, o: number): LayoutMaterial {
  const tev = [0, 1, 2].map((i) => [0, 1, 2, 3].map((c) => r.s16(o + 20 + i * 8 + c * 2))) as LayoutMaterial['tevColors'];
  const konst = [0, 1, 2, 3].map((i) => rgba(r, o + 44 + i * 4)) as LayoutMaterial['konstColors'];
  const flags = r.u32(o + 0x3c);
  let p = o + 0x40;
  const textureMaps: LayoutTexMap[] = [];
  for (let i = 0; i < bits(flags, 0, 4); i++, p += 4) textureMaps.push({ texture: r.u16(p), wrapS: r.u8(p + 2), wrapT: r.u8(p + 3) });
  const texSrt: LayoutTexSrt[] = [];
  for (let i = 0; i < bits(flags, 4, 4); i++, p += 20) {
    texSrt.push({ translate: [r.f32(p), r.f32(p + 4)], rotate: r.f32(p + 8), scale: [r.f32(p + 12), r.f32(p + 16)] });
  }
  const texCoordGenCount = bits(flags, 8, 4);
  p += 4 * texCoordGenCount;
  p += 4 * bits(flags, 25, 1); // ChanCtrl
  let color: Rgba | null = null;
  if (bits(flags, 27, 1)) { color = rgba(r, p); p += 4; }
  p += 4 * bits(flags, 12, 1); // TevSwapTable
  p += 20 * bits(flags, 13, 2); // IndTexSRT
  p += 4 * bits(flags, 15, 3); // IndTexStage
  const tevStageCount = bits(flags, 18, 5);
  p += 16 * tevStageCount;
  let alphaCompare: number[] | null = null;
  if (bits(flags, 23, 1)) { alphaCompare = [r.u8(p), r.u8(p + 1), r.u8(p + 2), r.u8(p + 3)]; p += 4; }
  let blendMode: number[] | null = null;
  if (bits(flags, 24, 1)) { blendMode = [r.u8(p), r.u8(p + 1), r.u8(p + 2), r.u8(p + 3)]; p += 4; }
  return { name: r.cstring(o, 20), tevColors: tev, konstColors: konst, color, textureMaps, texSrt, texCoordGenCount, tevStageCount, alphaCompare, blendMode };
}

function parsePane(r: BinaryReader, o: number, magic: string): LayoutPane {
  const flags = r.u8(o + 8);
  const pane: LayoutPane = {
    type: PANE_TYPES[magic],
    name: r.cstring(o + 0x0c, 16),
    userData: r.cstring(o + 0x1c, 8),
    visible: (flags & 1) !== 0,
    influencedAlpha: (flags & 2) !== 0,
    locationAdjust: (flags & 4) !== 0,
    origin: r.u8(o + 9),
    alpha: r.u8(o + 10),
    translate: [r.f32(o + 0x24), r.f32(o + 0x28), r.f32(o + 0x2c)],
    rotate: [r.f32(o + 0x30), r.f32(o + 0x34), r.f32(o + 0x38)],
    scale: [r.f32(o + 0x3c), r.f32(o + 0x40)],
    size: [r.f32(o + 0x44), r.f32(o + 0x48)],
    children: [],
  };
  if (magic === 'pic1') {
    pane.picture = quad(r, o + 0x4c).q;
  } else if (magic === 'txt1') {
    const strBytes = r.u16(o + 0x4e);
    const strOff = r.u32(o + 0x58);
    let text = '';
    for (let p = o + strOff; p + 1 < o + strOff + strBytes; p += 2) {
      const c = r.u16(p);
      if (c === 0) break;
      text += String.fromCharCode(c);
    }
    pane.text = {
      material: r.u16(o + 0x50),
      font: r.u16(o + 0x52),
      text,
      maxChars: Math.max(0, r.u16(o + 0x4c) / 2 - 1),
      textOrigin: r.u8(o + 0x54),
      alignment: r.u8(o + 0x55),
      colors: [rgba(r, o + 0x5c), rgba(r, o + 0x60)],
      fontSize: [r.f32(o + 0x64), r.f32(o + 0x68)],
      charSpace: r.f32(o + 0x6c),
      lineSpace: r.f32(o + 0x70),
    };
  } else if (magic === 'wnd1') {
    const frameCount = r.u8(o + 0x5c);
    const content = quad(r, o + r.u32(o + 0x60)).q;
    const table = o + r.u32(o + 0x64);
    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      const f = o + r.u32(table + i * 4);
      frames.push({ material: r.u16(f), flip: r.u8(f + 2) });
    }
    pane.window = { inflation: [r.f32(o + 0x4c), r.f32(o + 0x50), r.f32(o + 0x54), r.f32(o + 0x58)], content, frames };
  }
  return pane;
}

/** Leitura completa: árvore de painéis, materiais, grupos e listas de recursos. */
export function parseBrlyt(data: ArrayBuffer | ArrayBufferView): BrlytFile {
  const r = new BinaryReader(data, 'brlyt');
  r.expectMagic(0, 'RLYT');
  if (r.u16(4) !== 0xfeff) throw new ParseError('brlyt', 'BOM inválido');
  const headerSize = r.u16(12), count = r.u16(14);
  const out: BrlytFile = { version: r.u16(6), centered: true, width: 0, height: 0, textures: [], fonts: [], materials: [], root: null, groups: [], sections: [] };

  let last: LayoutPane | null = null;
  const parents: LayoutPane[] = [];
  let lastGroup: LayoutGroup | null = null;
  const groupParents: LayoutGroup[] = [];

  let o = headerSize;
  for (let i = 0; i < count && o + 8 <= r.length; i++) {
    const m = r.magic(o), size = r.u32(o + 4);
    if (size < 8) throw new ParseError('brlyt', `seção ${m} com tamanho inválido`);
    r.ensure(o, size, m);
    out.sections.push(m);
    switch (m) {
      case 'lyt1':
        out.centered = r.u8(o + 8) !== 0;
        out.width = r.f32(o + 12);
        out.height = r.f32(o + 16);
        break;
      case 'txl1': out.textures = nameList(r, o); break;
      case 'fnl1': out.fonts = nameList(r, o); break;
      case 'mat1': {
        const n = r.u16(o + 8);
        for (let k = 0; k < n; k++) out.materials.push(parseMaterial(r, o + r.u32(o + 12 + k * 4)));
        break;
      }
      case 'pan1': case 'pic1': case 'txt1': case 'wnd1': case 'bnd1': {
        const pane = parsePane(r, o, m);
        const parent = parents[parents.length - 1];
        if (parent) parent.children.push(pane);
        else if (!out.root) out.root = pane;
        else throw new ParseError('brlyt', `mais de um painel raiz (${out.root.name}, ${pane.name})`);
        last = pane;
        break;
      }
      case 'pas1':
        if (!last) throw new ParseError('brlyt', 'pas1 sem painel anterior');
        parents.push(last);
        break;
      case 'pae1':
        last = parents.pop() ?? null;
        break;
      case 'grp1': {
        const n = r.u16(o + 0x18);
        const g: LayoutGroup = { name: r.cstring(o + 8, 16), panes: [], children: [] };
        for (let k = 0; k < n; k++) g.panes.push(r.cstring(o + 0x1c + k * 16, 16));
        const parent = groupParents[groupParents.length - 1];
        (parent ? parent.children : out.groups).push(g);
        lastGroup = g;
        break;
      }
      case 'grs1':
        if (lastGroup) groupParents.push(lastGroup);
        break;
      case 'gre1':
        lastGroup = groupParents.pop() ?? null;
        break;
      default:
        break; // usd1 e outras seções opcionais
    }
    o += size;
  }
  return out;
}

/** Todos os painéis da árvore, em pré-ordem. */
export function flattenPanes(root: LayoutPane | null): LayoutPane[] {
  const out: LayoutPane[] = [];
  const walk = (p: LayoutPane) => { out.push(p); p.children.forEach(walk); };
  if (root) walk(root);
  return out;
}

/** Só as listas de nomes (compatível com a API anterior). */
export function parseBrlytRefs(data: ArrayBuffer | ArrayBufferView): BrlytRefs {
  const l = parseBrlyt(data);
  return {
    textures: l.textures,
    fonts: l.fonts,
    materials: l.materials.map((m) => m.name),
    panes: flattenPanes(l.root).map((p) => p.name),
    sections: l.sections,
  };
}
