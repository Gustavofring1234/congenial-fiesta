import { unzlibSync, zlibSync } from 'fflate';
import { FormatError } from '../core/binary.ts';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, start = 0, end = data.length, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Encode RGBA8 pixels as a PNG (colour type 6, 8 bit). Each scanline uses the
 * filter with the lowest sum of absolute differences (standard heuristic).
 */
export function encodePng(rgba: Uint8Array, width: number, height: number, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  if (rgba.length !== width * height * 4) throw new FormatError('PNG', `expected ${width * height * 4} bytes, got ${rgba.length}`);
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = rgba[row + i];
        const a = i >= 4 ? rgba[row + i - 4] : 0;
        const b = y > 0 ? rgba[prev + i] : 0;
        const c = y > 0 && i >= 4 ? rgba[prev + i - 4] : 0;
        const v = f === 0 ? x : f === 1 ? x - a : f === 2 ? x - b : f === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, c);
        out[i] = v & 0xff;
        score += out[i] < 128 ? out[i] : 256 - out[i];
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    raw[y * (stride + 1)] = best;
    raw.set(cand[best], y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = zlibSync(raw, { level });

  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = PNG_SIG.length + chunks.reduce((s, c) => s + c.length, 0);
  const png = new Uint8Array(total);
  png.set(PNG_SIG, 0);
  let o = PNG_SIG.length;
  for (const c of chunks) { png.set(c, o); o += c.length; }
  return png;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * Minimal decoder for the PNGs produced by {@link encodePng} (8-bit RGBA, non-interlaced).
 * Used by tests and by tooling that needs to read atlases back without a canvas.
 */
export function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  for (let i = 0; i < 8; i++) if (png[i] !== PNG_SIG[i]) throw new FormatError('PNG', 'bad signature');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  let width = 0, height = 0;
  const idat: Uint8Array[] = [];
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    if (crc32(png, o + 4, o + 8 + len) !== dv.getUint32(o + 8 + len)) throw new FormatError('PNG', `CRC mismatch in ${type}`);
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8);
      height = dv.getUint32(o + 12);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new FormatError('PNG', 'only 8-bit RGBA non-interlaced is supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
  let p = 0;
  for (const d of idat) { joined.set(d, p); p += d.length; }
  const raw = unzlibSync(joined);
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[y * stride + i - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 4 ? rgba[(y - 1) * stride + i - 4] : 0;
      const x = raw[src + i];
      rgba[y * stride + i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xff;
    }
  }
  return { width, height, rgba };
}
