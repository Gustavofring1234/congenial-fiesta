/** Yaz0: compressão LZ usada nos .carc/.szs. */
import { BinaryReader, ParseError, toBytes } from '../binary/reader.ts';

export const YAZ0_MAGIC = 'Yaz0';

export function isYaz0(data: ArrayBuffer | ArrayBufferView): boolean {
  const b = toBytes(data);
  return b.length >= 16 && b[0] === 0x59 && b[1] === 0x61 && b[2] === 0x7a && b[3] === 0x30;
}

export function yaz0Decompress(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  const r = new BinaryReader(data, 'yaz0');
  r.expectMagic(0, YAZ0_MAGIC);
  const size = r.u32(4);
  const src = r.bytes;
  const out = new Uint8Array(size);
  let i = 16, o = 0;
  while (o < size) {
    if (i >= src.length) throw new ParseError('yaz0', 'fluxo comprimido terminou antes do esperado');
    const code = src[i++];
    for (let bit = 0; bit < 8 && o < size; bit++) {
      if (code & (0x80 >> bit)) {
        out[o++] = src[i++];
      } else {
        const b1 = src[i], b2 = src[i + 1];
        i += 2;
        const dist = (((b1 & 0x0f) << 8) | b2) + 1;
        let n = b1 >> 4;
        n = n === 0 ? src[i++] + 0x12 : n + 2;
        if (dist > o) throw new ParseError('yaz0', `referência inválida (distância ${dist} > ${o})`);
        for (let k = 0; k < n && o < size; k++, o++) out[o] = out[o - dist];
      }
    }
  }
  return out;
}

/** Compressor Yaz0 guloso (janela 4 KiB). Compatível com o descompressor do jogo. */
export function yaz0Compress(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  const src = toBytes(input);
  const out: number[] = [0x59, 0x61, 0x7a, 0x30,
    (src.length >>> 24) & 0xff, (src.length >>> 16) & 0xff, (src.length >>> 8) & 0xff, src.length & 0xff,
    0, 0, 0, 0, 0, 0, 0, 0];
  const heads = new Map<number, number[]>();
  const key = (p: number) => (src[p] << 16) | (src[p + 1] << 8) | src[p + 2];
  const remember = (p: number) => {
    if (p + 2 >= src.length) return;
    const k = key(p);
    let l = heads.get(k);
    if (!l) heads.set(k, (l = []));
    l.push(p);
    if (l.length > 64) l.shift();
  };
  let p = 0;
  while (p < src.length) {
    const codePos = out.length;
    out.push(0);
    let code = 0;
    for (let bit = 0; bit < 8 && p < src.length; bit++) {
      let bestLen = 0, bestDist = 0;
      if (p + 2 < src.length) {
        const cands = heads.get(key(p)) ?? [];
        for (let c = cands.length - 1; c >= 0; c--) {
          const q = cands[c];
          const dist = p - q;
          if (dist > 0x1000) break;
          let len = 0;
          while (len < 0x111 && p + len < src.length && src[q + len] === src[p + len]) len++;
          if (len > bestLen) { bestLen = len; bestDist = dist; if (len === 0x111) break; }
        }
      }
      if (bestLen >= 3) {
        const d = bestDist - 1;
        if (bestLen >= 0x12) out.push((d >> 8) & 0x0f, d & 0xff, bestLen - 0x12);
        else out.push((((bestLen - 2) << 4) | ((d >> 8) & 0x0f)), d & 0xff);
        for (let k = 0; k < bestLen; k++) remember(p + k);
        p += bestLen;
      } else {
        code |= 0x80 >> bit;
        out.push(src[p]);
        remember(p);
        p++;
      }
    }
    out[codePos] = code;
  }
  return Uint8Array.from(out);
}
