import { describe, expect, it } from 'vitest';
import { yaz0Compress, yaz0Decompress, isYaz0 } from '../src/parsers/yaz0.ts';
import { buildU8, parseU8, isU8 } from '../src/parsers/u8.ts';
import { encodePng, decodePng, crc32 } from '../src/binary/png.ts';
import { BinaryReader, ParseError } from '../src/binary/reader.ts';
import { fnv1a64, makeAssetId, toPosixPath, isSafeRelativePosix } from '../src/binary/ids.ts';
import { decodeGxImage, decodePalette, GxFormat, gxImageSize } from '../src/codecs/gx.ts';

describe('Yaz0', () => {
  const samples = [
    new Uint8Array(0),
    new TextEncoder().encode('abcabcabcabcabcabcabcabcabcabcabcabc'.repeat(50)),
    Uint8Array.from({ length: 70000 }, (_, i) => (i * 7919) % 251),
    Uint8Array.from({ length: 5000 }, () => 0x41),
  ];
  it.each(samples.map((s, i) => [i, s]))('ida e volta da amostra %i', (_, s) => {
    const c = yaz0Compress(s as Uint8Array);
    expect(isYaz0(c) || (s as Uint8Array).length === 0).toBe(true);
    expect([...c.subarray(0, 4)]).toEqual([0x59, 0x61, 0x7a, 0x30]);
    expect(new DataView(c.buffer).getUint32(4)).toBe((s as Uint8Array).length);
    expect(yaz0Decompress(c)).toEqual(s);
  });
  it('comprime dados repetitivos', () => {
    expect(yaz0Compress(samples[3]).length).toBeLessThan(200);
  });
  it('rejeita magic errado e fluxo truncado', () => {
    expect(() => yaz0Decompress(new Uint8Array(16))).toThrow(ParseError);
    const c = yaz0Compress(samples[2]);
    expect(() => yaz0Decompress(c.subarray(0, 100))).toThrow(ParseError);
  });
});

describe('U8', () => {
  it('constrói e lê de volta preservando caminhos e conteúdo', () => {
    const files = [
      { path: 'arc/blyt/a.brlyt', data: Uint8Array.of(1, 2, 3) },
      { path: 'arc/timg/b.tpl', data: Uint8Array.from({ length: 100 }, (_, i) => i) },
      { path: 'top.bin', data: Uint8Array.of(9) },
    ];
    const u8 = buildU8(files);
    expect(isU8(u8)).toBe(true);
    expect(new DataView(u8.buffer).getUint32(0)).toBe(0x55aa382d);
    const back = parseU8(u8);
    expect(back.files.map((f) => f.path).sort()).toEqual(files.map((f) => f.path).sort());
    for (const f of files) expect(back.files.find((x) => x.path === f.path)!.data).toEqual(f.data);
    expect(back.directories).toEqual(expect.arrayContaining(['arc', 'arc/blyt', 'arc/timg']));
  });
  it('rejeita cabeçalho inválido', () => {
    expect(() => parseU8(new Uint8Array(64))).toThrow(ParseError);
  });
});

describe('PNG', () => {
  it('codifica e decodifica RGBA sem perdas, com CRC válido', () => {
    const rgba = Uint8Array.from({ length: 5 * 3 * 4 }, (_, i) => (i * 37) & 255);
    const png = encodePng(5, 3, rgba);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const d = decodePng(png);
    expect([d.width, d.height]).toEqual([5, 3]);
    expect(d.rgba).toEqual(rgba);
  });
  it('crc32 confere com o valor de referência', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('leitor binário e IDs', () => {
  it('lê big-endian e acusa leitura fora dos limites', () => {
    const r = new BinaryReader(Uint8Array.of(0x12, 0x34, 0x56, 0x78), 't');
    expect(r.u16(0)).toBe(0x1234);
    expect(r.u32(0)).toBe(0x12345678);
    expect(() => r.u32(2)).toThrow(/fora dos limites/);
  });
  it('gera IDs determinísticos e caminhos POSIX', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(makeAssetId('texture', 'a\\b/./c.tpl')).toBe(makeAssetId('texture', 'a/b/c.tpl'));
    expect(makeAssetId('texture', 'x.tpl')).not.toBe(makeAssetId('font', 'x.tpl'));
    expect(makeAssetId('texture', 'x.tpl')).toMatch(/^tex_[0-9a-f]{16}$/);
    expect(toPosixPath('/a//b\\c/')).toBe('a/b/c');
    expect(() => toPosixPath('a/../b')).toThrow();
    expect(isSafeRelativePosix('a/b.png')).toBe(true);
    expect(isSafeRelativePosix('/a')).toBe(false);
    expect(isSafeRelativePosix('a\\b')).toBe(false);
  });
});

describe('codec GX', () => {
  it('RGB5A3: cor opaca e translúcida', () => {
    const data = new Uint8Array(gxImageSize(GxFormat.RGB5A3, 4, 4));
    data.set([0xfc, 0x00], 0); // opaco vermelho puro
    data.set([0x4f, 0x00], 2); // alfa 4/7, vermelho máximo
    const px = decodeGxImage(data, 0, 4, 4, GxFormat.RGB5A3);
    expect([...px.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...px.subarray(4, 8)]).toEqual([255, 0, 0, 0x92]);
  });
  it('CMPR: cores de referência do bloco DXT1 no layout 2x2 de sub-blocos', () => {
    const data = new Uint8Array(32);
    for (let sb = 0; sb < 4; sb++) data.set([0xf8, 0x00, 0x00, 0x1f, 0, 0, 0, 0], sb * 8); // c0 vermelho, c1 azul, índices 0
    data[1 * 8 + 4] = 0b01000000; // sub-bloco 1 (x 4..7), pixel (4,0) usa c1
    const px = decodeGxImage(data, 0, 8, 8, GxFormat.CMPR);
    expect([...px.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...px.subarray(4 * 4, 4 * 4 + 4)]).toEqual([0, 0, 255, 255]);
  });
  it('I4 com desentrelaçamento de blocos 8x8', () => {
    const data = new Uint8Array(gxImageSize(GxFormat.I4, 16, 8));
    data[0] = 0xf0; // pixel (0,0) = 15
    data[32] = 0x0f; // segundo bloco, pixel (9,0) = 15
    const px = decodeGxImage(data, 0, 16, 8, GxFormat.I4);
    expect(px[0]).toBe(255);
    expect(px[9 * 4]).toBe(255);
    expect(px[8 * 4]).toBe(0);
  });
  it('CI8 com paleta RGB565', () => {
    const pal = decodePalette(Uint8Array.of(0x00, 0x00, 0x07, 0xe0), 0, 2, 1);
    const data = new Uint8Array(gxImageSize(GxFormat.CI8, 8, 4));
    data[0] = 1;
    const px = decodeGxImage(data, 0, 8, 4, GxFormat.CI8, pal);
    expect([...px.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    expect([...px.subarray(4, 8)]).toEqual([0, 0, 0, 255]);
  });
  it('acusa dados truncados', () => {
    expect(() => decodeGxImage(new Uint8Array(10), 0, 8, 8, GxFormat.RGBA8)).toThrow(/fora dos limites/);
  });
});
