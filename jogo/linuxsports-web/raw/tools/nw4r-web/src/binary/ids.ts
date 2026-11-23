/** Caminhos POSIX normalizados e IDs determinísticos. */
export function toPosixPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new Error(`caminho não pode subir de nível: ${p}`);
    parts.push(seg);
  }
  return parts.join('/');
}

export function isSafeRelativePosix(p: string): boolean {
  return p.length > 0 && !p.includes('\\') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p)
    && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** FNV-1a 64 bits em hexadecimal (estável entre plataformas). */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export type AssetKind = 'texture' | 'font' | 'animation' | 'collision' | 'layout' | 'model' | 'scene' | 'binary';
const PREFIX: Record<AssetKind, string> = {
  texture: 'tex', font: 'fnt', animation: 'anm', collision: 'col', layout: 'lyt', model: 'mdl', scene: 'scn', binary: 'bin',
};

/** assetId = prefixo + hash do (tipo, caminho de origem normalizado). */
export function makeAssetId(kind: AssetKind, sourcePath: string): string {
  return `${PREFIX[kind]}_${fnv1a64(`${kind}:${toPosixPath(sourcePath).toLowerCase()}`)}`;
}

export function basename(p: string): string {
  const s = toPosixPath(p);
  return s.slice(s.lastIndexOf('/') + 1);
}

export function stripExt(p: string): string {
  const b = p.lastIndexOf('/');
  const d = p.lastIndexOf('.');
  return d > b + 0 && d > 0 ? p.slice(0, d) : p;
}
