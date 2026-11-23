"""Decodificação de texturas Wii/GameCube (TEX0, .tpl, .bti). Só biblioteca padrão.
Copiado de linuxsports-re/scripts/textures.py."""
import struct, zlib, os, sys, re
from collections import Counter
def png(path, w, h, rgba):
    raw = b''.join(b'\0' + bytes(rgba[y*w*4:(y+1)*w*4]) for y in range(h))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw, 6)) + ch(b'IEND', b''))
def c565(v): r, g, b = (v>>11)&31, (v>>5)&63, v&31; return (r<<3|r>>2, g<<2|g>>4, b<<3|b>>2, 255)
def c5a3(v):
    if v & 0x8000: r, g, b = (v>>10)&31, (v>>5)&31, v&31; return (r<<3|r>>2, g<<3|g>>2, b<<3|b>>2, 255)
    a, r, g, b = (v>>12)&7, (v>>8)&15, (v>>4)&15, v&15; return (r*17, g*17, b*17, a<<5|a<<2|a>>1)
def cia8(v): i, a = v & 0xff, v >> 8; return (i, i, i, a)
PAL_DEC = {0: cia8, 1: c565, 2: c5a3}
BLOCK = {0:(8,8,4),1:(8,4,8),2:(8,4,8),3:(4,4,16),4:(4,4,16),5:(4,4,16),6:(4,4,32),8:(8,8,4),9:(8,4,8),10:(4,4,16),14:(8,8,4)}
def size(fmt, w, h):
    bw, bh, bpp = BLOCK[fmt]; return ((w+bw-1)//bw)*((h+bh-1)//bh)*bw*bh*bpp//8
def decode(d, off, w, h, fmt, pal=None):
    out = bytearray(w*h*4); bw, bh, bpp = BLOCK[fmt]; p = off
    def put(x, y, c):
        if x < w and y < h: out[(y*w+x)*4:(y*w+x)*4+4] = bytes(c)
    for by in range(0, h, bh):
        for bx in range(0, w, bw):
            if fmt == 6:
                blk = d[p:p+64]; p += 64
                for i in range(16):
                    put(bx+i%4, by+i//4, (blk[i*2+1], blk[32+i*2], blk[32+i*2+1], blk[i*2]))
            elif fmt == 14:
                for sb in range(4):
                    sx, sy = bx + (sb%2)*4, by + (sb//2)*4
                    c0, c1 = struct.unpack('>HH', d[p:p+4]); idx = d[p+4:p+8]; p += 8
                    a, b = c565(c0), c565(c1)
                    if c0 > c1: cols = [a, b, tuple((2*a[k]+b[k])//3 for k in range(3))+(255,), tuple((a[k]+2*b[k])//3 for k in range(3))+(255,)]
                    else: cols = [a, b, tuple((a[k]+b[k])//2 for k in range(3))+(255,), (0,0,0,0)]
                    for yy in range(4):
                        for xx in range(4): put(sx+xx, sy+yy, cols[(idx[yy] >> (6-2*xx)) & 3])
            else:
                for yy in range(bh):
                    for xx in range(bw):
                        if bpp == 4:
                            v = d[p >> 0]; v = (v >> 4) if (xx % 2 == 0) else (v & 15)
                            if xx % 2 == 1: p += 1
                            c = (v*17,)*3+(255,) if fmt == 0 else (pal[v] if pal and v < len(pal) else (v*17,)*3+(255,))
                        elif bpp == 8:
                            v = d[p]; p += 1
                            if fmt == 1: c = (v, v, v, 255)
                            elif fmt == 2: i, a = (v & 15)*17, (v >> 4)*17; c = (i, i, i, a)
                            else: c = pal[v] if pal and v < len(pal) else (v, v, v, 255)
                        else:
                            v = struct.unpack('>H', d[p:p+2])[0]; p += 2
                            if fmt == 3: c = (d[p-1], d[p-1], d[p-1], d[p-2])
                            elif fmt == 4: c = c565(v)
                            elif fmt == 5: c = c5a3(v)
                            else: v &= 0x3fff; c = pal[v] if pal and v < len(pal) else (0,0,0,255)
                        put(bx+xx, by+yy, c)
    return out
def palette(d, off, n, pfmt): return [PAL_DEC[pfmt](struct.unpack('>H', d[off+i*2:off+i*2+2])[0]) for i in range(n)]
def png_bytes(w, h, rgba):
    raw = b''.join(b'\0' + bytes(rgba[y*w*4:(y+1)*w*4]) for y in range(h))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + ch(b'IDAT', zlib.compress(raw, 6)) + ch(b'IEND', b''))
