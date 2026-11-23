/**
 * Deterministic identifiers and POSIX path utilities shared by the converters,
 * the manifest schema and the web runtime.
 */

export type AssetKind = 'texture' | 'font' | 'animation' | 'collision' | 'raw';

/** Normalise any path to a relative POSIX path: `\` -> `/`, no `.`/`..`/leading slash. */
export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export function dirname(p: string): string {
  const n = normalizePath(p);
  const i = n.lastIndexOf('/');
  return i < 0 ? '' : n.slice(0, i);
}

export function basename(p: string): string {
  const n = normalizePath(p);
  return n.slice(n.lastIndexOf('/') + 1);
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

/** Strip the last extension: `a/b.tpl` -> `a/b`. */
export function stripExt(p: string): string {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  return dot > slash + 1 ? p.slice(0, dot) : p;
}

export function extname(p: string): string {
  const b = basename(p);
  const dot = b.lastIndexOf('.');
  return dot <= 0 ? '' : b.slice(dot).toLowerCase();
}

/** Relative POSIX path from directory `fromDir` to file `to` (both bundle-relative). */
export function relativePath(fromDir: string, to: string): string {
  const a = normalizePath(fromDir).split('/').filter(Boolean);
  const b = normalizePath(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a over the UTF-8 bytes of `s`, as 16 hex chars. */
export function fnv1a64(s: string): string {
  let h = FNV64_OFFSET;
  for (const byte of new TextEncoder().encode(s)) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Deterministic asset id: same kind + same source path => same id on every run,
 * every machine and every runtime. Paths are compared case-insensitively because
 * the Wii disc filesystem / NW4R resource accessors are case-insensitive.
 */
export function makeAssetId(kind: AssetKind, sourcePath: string): string {
  return `${kind}-${fnv1a64(`${kind}:${normalizePath(sourcePath).toLowerCase()}`)}`;
}

export const ASSET_ID_PATTERN = /^(texture|font|animation|collision|raw)-[0-9a-f]{16}$/;
