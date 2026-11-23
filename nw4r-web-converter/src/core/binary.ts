/**
 * Low-level binary helpers. Only ArrayBuffer / DataView / Uint8Array are used,
 * so everything here runs unchanged in Node.js, browsers and Web Workers.
 */

export class FormatError extends Error {
  constructor(format: string, message: string) {
    super(`[${format}] ${message}`);
    this.name = 'FormatError';
  }
}

export function toBytes(src: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (src instanceof Uint8Array) return src;
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  return new Uint8Array(src);
}

/** Random-access big-endian reader (all GameCube/Wii formats are big-endian). */
export class BEReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;

  constructor(src: ArrayBuffer | ArrayBufferView, readonly format = 'binary') {
    this.bytes = toBytes(src);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  ensure(offset: number, size: number, what = 'data'): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.bytes.byteLength) {
      throw new FormatError(
        this.format,
        `${what} out of bounds (offset 0x${offset.toString(16)}, size ${size}, file ${this.bytes.byteLength} bytes)`,
      );
    }
  }

  u8(o: number): number { this.ensure(o, 1); return this.view.getUint8(o); }
  s8(o: number): number { this.ensure(o, 1); return this.view.getInt8(o); }
  u16(o: number): number { this.ensure(o, 2); return this.view.getUint16(o, false); }
  s16(o: number): number { this.ensure(o, 2); return this.view.getInt16(o, false); }
  u24(o: number): number { this.ensure(o, 3); return (this.view.getUint8(o) << 16) | this.view.getUint16(o + 1, false); }
  u32(o: number): number { this.ensure(o, 4); return this.view.getUint32(o, false); }
  s32(o: number): number { this.ensure(o, 4); return this.view.getInt32(o, false); }
  f32(o: number): number { this.ensure(o, 4); return this.view.getFloat32(o, false); }

  /** Fixed-length ASCII string (stops at the first NUL). */
  ascii(o: number, len: number): string {
    this.ensure(o, len);
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = this.bytes[o + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** NUL-terminated string (ASCII/Latin-1). */
  cstring(o: number, max = 0x1000): string {
    this.ensure(o, 1);
    let s = '';
    for (let i = o; i < this.bytes.length && i < o + max; i++) {
      const c = this.bytes[i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  slice(o: number, len: number): Uint8Array {
    this.ensure(o, len);
    return this.bytes.subarray(o, o + len);
  }

  magic(o: number): string {
    return this.ascii(o, 4).padEnd(4, '\0');
  }
}

/** Growable little-endian writer, used for GLB / ZIP-like outputs. */
export class LEWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private grow(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void { this.grow(1); this.view.setUint8(this.length, v); this.length += 1; }
  u16(v: number): void { this.grow(2); this.view.setUint16(this.length, v, true); this.length += 2; }
  u32(v: number): void { this.grow(4); this.view.setUint32(this.length, v >>> 0, true); this.length += 4; }
  f32(v: number): void { this.grow(4); this.view.setFloat32(this.length, v, true); this.length += 4; }
  bytes(b: Uint8Array): void { this.grow(b.length); this.buf.set(b, this.length); this.length += b.length; }
  align(n: number, fill = 0): void { while (this.length % n) this.u8(fill); }
  finish(): Uint8Array { return this.buf.slice(0, this.length); }
}

/** Growable big-endian writer, used to build U8 / Yaz0 archives and test fixtures. */
export class BEWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private grow(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this { this.grow(1); this.view.setUint8(this.length, v & 0xff); this.length += 1; return this; }
  s8(v: number): this { this.grow(1); this.view.setInt8(this.length, v); this.length += 1; return this; }
  u16(v: number): this { this.grow(2); this.view.setUint16(this.length, v & 0xffff, false); this.length += 2; return this; }
  s16(v: number): this { this.grow(2); this.view.setInt16(this.length, v, false); this.length += 2; return this; }
  u24(v: number): this { this.u8(v >>> 16); this.u16(v & 0xffff); return this; }
  u32(v: number): this { this.grow(4); this.view.setUint32(this.length, v >>> 0, false); this.length += 4; return this; }
  f32(v: number): this { this.grow(4); this.view.setFloat32(this.length, v, false); this.length += 4; return this; }
  ascii(s: string, len = s.length): this {
    for (let i = 0; i < len; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0);
    return this;
  }
  bytes(b: Uint8Array): this { this.grow(b.length); this.buf.set(b, this.length); this.length += b.length; return this; }
  zeros(n: number): this { this.grow(n); this.buf.fill(0, this.length, this.length + n); this.length += n; return this; }
  align(n: number): this { const pad = (n - (this.length % n)) % n; return this.zeros(pad); }
  /** Overwrite a u32 at an absolute offset (for back-patching). */
  patchU32(offset: number, v: number): this { this.view.setUint32(offset, v >>> 0, false); return this; }
  patchU16(offset: number, v: number): this { this.view.setUint16(offset, v & 0xffff, false); return this; }
  finish(): Uint8Array { return this.buf.slice(0, this.length); }
}

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();
export const encodeUtf8 = (s: string): Uint8Array => utf8Enc.encode(s);
export const decodeUtf8 = (b: Uint8Array): string => utf8Dec.decode(b);
