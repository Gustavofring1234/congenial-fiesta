import { describe, expect, it } from 'vitest';
import { FormatError } from '../src/core/binary.ts';
import { joinPath, makeAssetId, normalizePath, relativePath } from '../src/core/ids.ts';
import { isU8, parseU8 } from '../src/parsers/u8.ts';
import { decompressYaz0, isYaz0 } from '../src/parsers/yaz0.ts';
import { buildU8 } from '../src/serializers/u8.ts';
import { compressYaz0 } from '../src/serializers/yaz0.ts';

function pseudoRandom(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; out[i] = s >>> 24; }
  return out;
}

describe('Yaz0', () => {
  it('round-trips random, repetitive and long-match data', () => {
    const repetitive = new Uint8Array(70000).map((_, i) => (i % 7) * 3);
    const mixed = new Uint8Array(5000);
    mixed.set(pseudoRandom(1000), 0);
    mixed.set(pseudoRandom(1000), 1000);
    mixed.set(mixed.subarray(0, 2000), 2500); // long back-references (>= 0x12 bytes)
    for (const data of [new Uint8Array(0), Uint8Array.of(1), pseudoRandom(4096), repetitive, mixed]) {
      const packed = compressYaz0(data);
      expect(isYaz0(packed)).toBe(true);
      expect(new DataView(packed.buffer).getUint32(4)).toBe(data.length);
      expect(decompressYaz0(packed)).toEqual(data);
    }
  });

  it('compresses repetitive data', () => {
    const data = new Uint8Array(10000).fill(0xab);
    expect(compressYaz0(data).length).toBeLessThan(400);
  });

  it('decodes a hand-assembled stream (literal + 2-byte + 3-byte references)', () => {
    // "ABC" literals, then copy 6 bytes from dist 3 (2-byte form n=4), then 0x12+1 bytes from dist 1 (3-byte form)
    const stream = Uint8Array.of(
      0x59, 0x61, 0x7a, 0x30, 0, 0, 0, 3 + 6 + 0x13, 0, 0, 0, 0, 0, 0, 0, 0,
      0b11100000, 0x41, 0x42, 0x43, 0x40, 0x02, 0x00, 0x00, 0x01,
    );
    const out = new TextDecoder().decode(decompressYaz0(stream));
    expect(out).toBe('ABCABCABC' + 'C'.repeat(0x13));
  });

  it('rejects bad magic and truncated streams', () => {
    expect(() => decompressYaz0(new Uint8Array(16))).toThrow(FormatError);
    const packed = compressYaz0(pseudoRandom(256));
    expect(() => decompressYaz0(packed.subarray(0, packed.length - 10))).toThrow(/unexpected end|truncated/);
  });
});

describe('U8', () => {
  const files = [
    { path: 'arc/timg/b.tpl', data: Uint8Array.of(1, 2, 3) },
    { path: 'arc/timg/a.tpl', data: Uint8Array.of(4) },
    { path: 'arc/anim/x.brlan', data: pseudoRandom(100) },
    { path: 'root.bin', data: new Uint8Array(0) },
  ];

  it('validates the header and round-trips the directory tree', () => {
    const u8 = buildU8(files);
    expect(isU8(u8)).toBe(true);
    const dv = new DataView(u8.buffer);
    expect(dv.getUint32(0)).toBe(0x55aa382d);
    expect(dv.getUint32(4)).toBe(0x20);
    expect(dv.getUint32(12) % 0x20).toBe(0);
    const arc = parseU8(u8);
    expect(arc.header.nodeCount).toBe(1 + 3 + 4); // root + 3 dirs (arc, anim, timg) + 4 files
    expect(arc.directories.sort()).toEqual(['arc', 'arc/anim', 'arc/timg']);
    const byPath = new Map(arc.files.map((f) => [f.path, f.data]));
    for (const f of files) expect(byPath.get(f.path)).toEqual(f.data);
  });

  it('handles the "." root child used by Nintendo archives', () => {
    // Build with a placeholder directory name, then rename it to "." in the string table.
    const u8 = buildU8([{ path: 'DOTDIR/timg/a.tpl', data: Uint8Array.of(9) }]);
    const at = new TextDecoder('latin1').decode(u8).indexOf('DOTDIR');
    u8.set([0x2e, 0, 0, 0, 0, 0], at);
    const arc = parseU8(u8);
    expect(arc.directories).toContain('timg');
    expect(arc.files[0].path).toBe('timg/a.tpl');
  });

  it('rejects corrupt archives', () => {
    expect(() => parseU8(new Uint8Array(0x40))).toThrow(/magic/);
    const u8 = buildU8(files);
    const bad = u8.slice();
    new DataView(bad.buffer).setUint32(0x20 + 8, 0xffff); // absurd node count
    expect(() => parseU8(bad)).toThrow(FormatError);
  });
});

describe('ids & paths', () => {
  it('normalizes to POSIX relative paths', () => {
    expect(normalizePath('a\\b/./c/../d.tpl')).toBe('a/b/d.tpl');
    expect(normalizePath('/x//y/')).toBe('x/y');
    expect(joinPath('a/b', '../c')).toBe('a/c');
    expect(relativePath('anim', 'timg/a.png')).toBe('../timg/a.png');
  });

  it('produces deterministic, case-insensitive asset ids', () => {
    const id = makeAssetId('texture', 'timg/A.tpl');
    expect(id).toMatch(/^texture-[0-9a-f]{16}$/);
    expect(makeAssetId('texture', './timg\\a.tpl')).toBe(id);
    expect(makeAssetId('font', 'timg/a.tpl')).not.toBe(id);
  });
});
