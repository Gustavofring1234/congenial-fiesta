import { BEReader, FormatError, toBytes } from '../core/binary.ts';

export const YAZ0_MAGIC = 'Yaz0';

export function isYaz0(data: Uint8Array): boolean {
  return data.length >= 16 && data[0] === 0x59 && data[1] === 0x61 && data[2] === 0x7a && data[3] === 0x30;
}

/**
 * Decompress a Yaz0 stream.
 * Header: "Yaz0" | u32 decompressedSize | 8 reserved bytes.
 * Body: groups of 1 code byte (MSB first) followed by 8 chunks:
 *   bit 1 -> literal byte; bit 0 -> back-reference (2 or 3 bytes).
 */
export function decompressYaz0(src: ArrayBuffer | ArrayBufferView): Uint8Array {
  const r = new BEReader(src, 'Yaz0');
  if (!isYaz0(r.bytes)) throw new FormatError('Yaz0', 'missing "Yaz0" magic');
  const size = r.u32(4);
  const input = r.bytes;
  const out = new Uint8Array(size);
  let s = 16;
  let d = 0;
  let code = 0;
  let bits = 0;

  while (d < size) {
    if (bits === 0) {
      if (s >= input.length) throw new FormatError('Yaz0', 'unexpected end of compressed stream');
      code = input[s++];
      bits = 8;
    }
    if (code & 0x80) {
      if (s >= input.length) throw new FormatError('Yaz0', 'truncated literal');
      out[d++] = input[s++];
    } else {
      if (s + 1 >= input.length) throw new FormatError('Yaz0', 'truncated back-reference');
      const b1 = input[s++];
      const b2 = input[s++];
      const dist = (((b1 & 0x0f) << 8) | b2) + 1;
      let n = b1 >> 4;
      if (n === 0) {
        if (s >= input.length) throw new FormatError('Yaz0', 'truncated back-reference length');
        n = input[s++] + 0x12;
      } else {
        n += 2;
      }
      let from = d - dist;
      if (from < 0) throw new FormatError('Yaz0', `back-reference before start of output at 0x${d.toString(16)}`);
      for (let i = 0; i < n && d < size; i++) out[d++] = out[from++];
    }
    code = (code << 1) & 0xff;
    bits--;
  }
  return out;
}

/** Unwrap Yaz0 if present, otherwise return the input bytes unchanged. */
export function maybeDecompressYaz0(src: ArrayBuffer | ArrayBufferView): { data: Uint8Array; wasCompressed: boolean } {
  const bytes = toBytes(src);
  return isYaz0(bytes) ? { data: decompressYaz0(bytes), wasCompressed: true } : { data: bytes, wasCompressed: false };
}
