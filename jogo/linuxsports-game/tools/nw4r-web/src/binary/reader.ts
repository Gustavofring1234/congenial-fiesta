/** Leitor big-endian com verificação de limites. Usa só DataView/Uint8Array (Node e browser). */
export class ParseError extends Error {
  constructor(format: string, message: string) {
    super(`[${format}] ${message}`);
    this.name = 'ParseError';
  }
}

export function toBytes(src: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (src instanceof Uint8Array) return src;
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  return new Uint8Array(src);
}

export class BinaryReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;

  constructor(src: ArrayBuffer | ArrayBufferView, readonly format = 'binary') {
    this.bytes = toBytes(src);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  ensure(offset: number, size: number, what = 'dados'): void {
    if (!Number.isInteger(offset) || offset < 0 || size < 0 || offset + size > this.length) {
      throw new ParseError(this.format, `${what} fora dos limites (offset 0x${offset.toString(16)}, ${size} bytes, arquivo ${this.length})`);
    }
  }

  u8(o: number): number { this.ensure(o, 1); return this.view.getUint8(o); }
  s8(o: number): number { this.ensure(o, 1); return this.view.getInt8(o); }
  u16(o: number): number { this.ensure(o, 2); return this.view.getUint16(o, false); }
  s16(o: number): number { this.ensure(o, 2); return this.view.getInt16(o, false); }
  u32(o: number): number { this.ensure(o, 4); return this.view.getUint32(o, false); }
  s32(o: number): number { this.ensure(o, 4); return this.view.getInt32(o, false); }
  f32(o: number): number { this.ensure(o, 4); return this.view.getFloat32(o, false); }

  magic(o: number, len = 4): string {
    this.ensure(o, len, 'magic');
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.bytes[o + i]);
    return s;
  }

  /** String terminada em NUL (latin1). */
  cstring(o: number, max = 1024): string {
    this.ensure(o, 1, 'string');
    let s = '';
    for (let i = o; i < Math.min(this.length, o + max); i++) {
      const c = this.bytes[i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  slice(o: number, len: number): Uint8Array {
    this.ensure(o, len, 'bloco');
    return this.bytes.subarray(o, o + len);
  }

  expectMagic(o: number, expected: string): void {
    const m = this.magic(o, expected.length);
    if (m !== expected) throw new ParseError(this.format, `magic inválido em 0x${o.toString(16)}: esperado "${expected}", encontrado "${m}"`);
  }
}

/** Escritor big-endian simples, usado pelos construtores de teste (U8, Yaz0). */
export class BinaryWriter {
  private buf = new Uint8Array(256);
  length = 0;

  private grow(n: number) {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.length));
    this.buf = nb;
  }
  u8(v: number) { this.grow(1); this.buf[this.length++] = v & 0xff; return this; }
  u16(v: number) { return this.u8(v >>> 8).u8(v); }
  u32(v: number) { return this.u16(v >>> 16).u16(v & 0xffff); }
  bytes(b: Uint8Array) { this.grow(b.length); this.buf.set(b, this.length); this.length += b.length; return this; }
  align(n: number) { while (this.length % n) this.u8(0); return this; }
  setU32(o: number, v: number) {
    new DataView(this.buf.buffer).setUint32(o, v >>> 0, false);
  }
  finish(): Uint8Array { return this.buf.slice(0, this.length); }
}
