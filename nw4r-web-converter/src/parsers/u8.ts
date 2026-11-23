import { BEReader, FormatError, toBytes } from '../core/binary.ts';
import { joinPath } from '../core/ids.ts';

export const U8_MAGIC = 0x55aa382d;

export interface U8File {
  /** POSIX path inside the archive (no leading slash, no "." root). */
  path: string;
  data: Uint8Array;
}

export interface U8Archive {
  header: { rootNodeOffset: number; headerSize: number; dataOffset: number; nodeCount: number };
  directories: string[];
  files: U8File[];
}

export function isU8(data: Uint8Array): boolean {
  return data.length >= 0x20 && data[0] === 0x55 && data[1] === 0xaa && data[2] === 0x38 && data[3] === 0x2d;
}

/**
 * Parse a U8 archive.
 * Header (0x20): magic | rootNodeOffset | headerSize (nodes + strings) | dataOffset | 16 reserved.
 * Node (12 bytes): u8 type (0=file,1=dir) | u24 nameOffset | u32 dataOffset/parentIndex | u32 size/nextIndex.
 */
export function parseU8(src: ArrayBuffer | ArrayBufferView): U8Archive {
  const r = new BEReader(toBytes(src), 'U8');
  if (r.length < 0x20 || r.u32(0) !== U8_MAGIC) throw new FormatError('U8', 'missing 0x55AA382D magic');
  const rootNodeOffset = r.u32(4);
  const headerSize = r.u32(8);
  const dataOffset = r.u32(12);

  if (r.u8(rootNodeOffset) !== 1) throw new FormatError('U8', 'root node is not a directory');
  const nodeCount = r.u32(rootNodeOffset + 8);
  if (nodeCount < 1 || rootNodeOffset + nodeCount * 12 > r.length) {
    throw new FormatError('U8', `invalid node count ${nodeCount}`);
  }
  const stringTable = rootNodeOffset + nodeCount * 12;

  const files: U8File[] = [];
  const directories: string[] = [];
  // Stack of [endIndex, path] for open directories.
  const stack: Array<{ end: number; path: string }> = [{ end: nodeCount, path: '' }];

  for (let i = 1; i < nodeCount; i++) {
    while (stack.length > 1 && i >= stack[stack.length - 1].end) stack.pop();
    const node = rootNodeOffset + i * 12;
    const type = r.u8(node);
    const name = r.cstring(stringTable + r.u24(node + 1));
    const a = r.u32(node + 4);
    const b = r.u32(node + 8);
    const path = joinPath(stack[stack.length - 1].path, name);
    if (type === 1) {
      if (b <= i || b > nodeCount) throw new FormatError('U8', `directory "${path}" has invalid end index ${b}`);
      directories.push(path);
      stack.push({ end: b, path });
    } else if (type === 0) {
      files.push({ path, data: r.slice(a, b) });
    } else {
      throw new FormatError('U8', `unknown node type ${type} at index ${i}`);
    }
  }

  return { header: { rootNodeOffset, headerSize, dataOffset, nodeCount }, directories, files };
}
