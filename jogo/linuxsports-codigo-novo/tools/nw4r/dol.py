"""Leitura de endereços virtuais do main.dol (somente leitura).

Usado para tirar tabelas de dados do RFL (cores, mapas de arquivo, rotações) direto do executável,
em vez de copiá-las à mão. Formato DOL: 7 seções de texto + 11 de dados; cabeçalho com offsets,
endereços e tamanhos (3 × 18 u32 big-endian).
"""
import struct
from pathlib import Path

from nw4r.paths import SRC

DOL_PATH = SRC / 'raw/main.dol'
SDA2_BASE = 0x804C7A20   # r2 (lis/addi em __init_registers @ 0x8000630c)
SDA_BASE = 0x804C5380    # r13


class Dol:
    def __init__(self, path=DOL_PATH):
        self.data = Path(path).read_bytes()
        head = struct.unpack('>54I', self.data[:216])
        self.sections = [s for s in zip(head[0:18], head[18:36], head[36:54]) if s[2]]

    def read(self, va, n):
        for off, addr, size in self.sections:
            if addr <= va and va + n <= addr + size:
                return self.data[off + va - addr: off + va - addr + n]
        raise KeyError(f'endereço fora das seções do DOL: {va:#010x}')

    def u32s(self, va, n):
        return list(struct.unpack(f'>{n}I', self.read(va, 4 * n)))

    def f32(self, va):
        return struct.unpack('>f', self.read(va, 4))[0]

    def sda2_f32(self, off):
        return self.f32(SDA2_BASE + off)

    def rgba(self, va, n):
        b = self.read(va, 4 * n)
        return [list(b[i:i + 4]) for i in range(0, 4 * n, 4)]
