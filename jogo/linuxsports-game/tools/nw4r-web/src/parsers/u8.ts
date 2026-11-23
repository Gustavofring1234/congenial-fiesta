/** U8 (magic 0x55AA382D): arquivo de diretórios usado dentro dos .carc/.arc. */
import { BinaryReader, BinaryWriter, ParseError, toBytes } from '../binary/reader.ts';
import { toPosixPath } from '../binary/ids.ts';

export const U8_MAGIC = 0x55aa382d;

export interface U8File { path: string; data: Uint8Array }
export interface U8Archive { files: U8File[]; directories: string[] }

export function isU8(data: ArrayBuffer | ArrayBufferView): boolean {
  const b = toBytes(data);
  return b.length >= 32 && b[0] === 0x55 && b[1] === 0xaa && b[2] === 0x38 && b[3] === 0x2d;
}

export function parseU8(data: ArrayBuffer | ArrayBufferView): U8Archive {
  const r = new BinaryReader(data, 'u8');
  if (r.u32(0) !== U8_MAGIC) throw new ParseError('u8', 'magic 0x55AA382D não encontrado');
  const rootOff = r.u32(4);
  const count = r.u32(rootOff + 8);
  if (r.u8(rootOff) !== 1) throw new ParseError('u8', 'nó raiz não é diretório');
  if (count < 1 || rootOff + count * 12 > r.length) throw new ParseError('u8', `número de nós inválido (${count})`);
  const strings = rootOff + count * 12;
  const files: U8File[] = [];
  const directories: string[] = [];
  const stack: { end: number; path: string }[] = [{ end: count, path: '' }];
  for (let i = 1; i < count; i++) {
    while (stack.length > 1 && i >= stack[stack.length - 1].end) stack.pop();
    const n = rootOff + i * 12;
    const type = r.u8(n);
    const nameOff = r.u32(n) & 0xffffff;
    const a = r.u32(n + 4), b = r.u32(n + 8);
    const name = r.cstring(strings + nameOff);
    const parent = stack[stack.length - 1].path;
    const path = parent ? `${parent}/${name}` : name;
    if (type === 1) {
      if (b <= i || b > count) throw new ParseError('u8', `diretório "${name}" com fim inválido (${b})`);
      stack.push({ end: b, path });
      const norm = safe(path);
      if (norm) directories.push(norm);
    } else if (type === 0) {
      files.push({ path: safe(path), data: r.slice(a, b) });
    } else {
      throw new ParseError('u8', `tipo de nó desconhecido ${type}`);
    }
  }
  return { files, directories };
}

function safe(p: string): string {
  return toPosixPath(p.split('/').filter((s) => s !== '..').join('/'));
}

/** Constrói um U8 a partir de uma lista de arquivos (usado em testes e reempacotamento). */
export function buildU8(files: U8File[]): Uint8Array {
  type Dir = { name: string; dirs: Map<string, Dir>; files: U8File[] };
  const root: Dir = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = toPosixPath(f.path).split('/');
    let d = root;
    for (const seg of parts.slice(0, -1)) {
      if (!d.dirs.has(seg)) d.dirs.set(seg, { name: seg, dirs: new Map(), files: [] });
      d = d.dirs.get(seg)!;
    }
    d.files.push({ path: parts[parts.length - 1], data: f.data });
  }
  type Node = { dir: boolean; name: string; parent: number; end: number; data?: Uint8Array };
  const nodes: Node[] = [];
  const walk = (d: Dir, parent: number) => {
    const idx = nodes.length;
    nodes.push({ dir: true, name: d.name, parent, end: 0 });
    const entries = [...d.files.map((f) => ({ k: f.path, f })), ...[...d.dirs.values()].map((x) => ({ k: x.name, d: x }))]
      .sort((a, b) => (a.k.toLowerCase() < b.k.toLowerCase() ? -1 : 1));
    for (const e of entries) {
      if ('f' in e && e.f) nodes.push({ dir: false, name: e.f.path, parent: idx, end: 0, data: e.f.data });
      else if ('d' in e && e.d) walk(e.d, idx);
    }
    nodes[idx].end = nodes.length;
  };
  walk(root, 0);
  const enc = new TextEncoder();
  const names: number[] = [];
  const nameOffs = nodes.map((n) => { const o = names.length; names.push(...enc.encode(n.name), 0); return o; });
  const headerSize = nodes.length * 12 + names.length;
  const dataStart = Math.ceil((0x20 + headerSize) / 0x20) * 0x20;
  const w = new BinaryWriter();
  w.u32(U8_MAGIC).u32(0x20).u32(headerSize).u32(dataStart).u32(0).u32(0).u32(0).u32(0);
  let dataOff = dataStart;
  const placed: { off: number; data: Uint8Array }[] = [];
  nodes.forEach((n, i) => {
    w.u32(((n.dir ? 1 : 0) << 24) | nameOffs[i]);
    if (n.dir) { w.u32(n.parent).u32(n.end); }
    else {
      w.u32(dataOff).u32(n.data!.length);
      placed.push({ off: dataOff, data: n.data! });
      dataOff = Math.ceil((dataOff + n.data!.length) / 0x20) * 0x20;
    }
  });
  w.bytes(Uint8Array.from(names));
  for (const p of placed) {
    while (w.length < p.off) w.u8(0);
    w.bytes(p.data);
  }
  w.align(0x20);
  return w.finish();
}
