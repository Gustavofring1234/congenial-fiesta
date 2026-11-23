import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));

describe('browser / worker portability', () => {
  it('only the CLI touches Node built-ins; the library uses ArrayBuffer/DataView/Uint8Array only', () => {
    for (const file of walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('cli.ts'))) {
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // strip comments
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec.startsWith('.') || spec === 'fflate' || spec === 'zod/mini', `${path.relative(SRC, file)} imports ${spec}`).toBe(true);
      }
      expect(src, file).not.toMatch(/\bBuffer\.|\brequire\(|process\./);
    }
  });
});
