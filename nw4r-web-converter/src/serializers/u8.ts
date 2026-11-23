import { BEWriter, encodeUtf8 } from '../core/binary.ts';
import { normalizePath } from '../core/ids.ts';
import { U8_MAGIC, type U8File } from '../parsers/u8.ts';

interface DirNode {
  name: string;
  dirs: Map<string, DirNode>;
  files: Map<string, Uint8Array>;
}

/** Build a U8 archive (sorted, data aligned to 0x20). Used for re-packing and test fixtures. */
export function buildU8(files: U8File[]): Uint8Array {
  const root: DirNode = { name: '', dirs: new Map(), files: new Map() };
  for (const f of files) {
    const parts = normalizePath(f.path).split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      if (!dir.dirs.has(p)) dir.dirs.set(p, { name: p, dirs: new Map(), files: new Map() });
      dir = dir.dirs.get(p)!;
    }
    dir.files.set(parts[parts.length - 1], f.data);
  }

  type FlatNode = { type: 0 | 1; name: string; parent: number; next: number; data?: Uint8Array };
  const nodes: FlatNode[] = [{ type: 1, name: '', parent: 0, next: 0 }];
  const walk = (dir: DirNode, selfIndex: number) => {
    const names = [...new Set([...dir.files.keys(), ...dir.dirs.keys()])].sort((x, y) => x.localeCompare(y));
    for (const name of names) {
      if (dir.files.has(name)) nodes.push({ type: 0, name, parent: selfIndex, next: 0, data: dir.files.get(name) });
      if (dir.dirs.has(name)) {
        const idx = nodes.length;
        nodes.push({ type: 1, name, parent: selfIndex, next: 0 });
        walk(dir.dirs.get(name)!, idx);
        nodes[idx].next = nodes.length;
      }
    }
  };
  walk(root, 0);
  nodes[0].next = nodes.length;

  const strings: number[] = [];
  const nameOffsets = nodes.map((n) => {
    const off = strings.length;
    strings.push(...encodeUtf8(n.name), 0);
    return off;
  });

  const rootOffset = 0x20;
  const headerSize = nodes.length * 12 + strings.length;
  const dataStart = Math.ceil((rootOffset + headerSize) / 0x20) * 0x20;

  let cursor = dataStart;
  const dataOffsets = nodes.map((n) => {
    if (n.type !== 0) return 0;
    const off = cursor;
    cursor = Math.ceil((cursor + n.data!.length) / 0x20) * 0x20;
    return off;
  });

  const w = new BEWriter();
  w.u32(U8_MAGIC).u32(rootOffset).u32(headerSize).u32(dataStart).zeros(16);
  nodes.forEach((n, i) => {
    w.u8(n.type).u24(nameOffsets[i]);
    if (n.type === 0) w.u32(dataOffsets[i]).u32(n.data!.length);
    else w.u32(n.parent).u32(n.next);
  });
  w.bytes(Uint8Array.from(strings)).align(0x20);
  nodes.forEach((n, i) => {
    if (n.type !== 0) return;
    while (w.length < dataOffsets[i]) w.u8(0);
    w.bytes(n.data!).align(0x20);
  });
  return w.finish();
}
