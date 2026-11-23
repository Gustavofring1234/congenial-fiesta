"""Leitor BRRES (NW4R G3D, big-endian), só biblioteca padrão.

Cobre o índice de pastas (index groups) e, no MDL0, os materiais com todas as camadas de
textura e as listas de desenho (objeto -> material). Os offsets seguem o conversor de
geometria original (linuxsports-game/scripts/brres2glb.py), que gerou os .glb de models/.
"""
import struct

WII_FOLDERS = {
    '3DModels(NW4R)': 'MDL0', 'Textures(NW4R)': 'TEX0', 'Palettes(NW4R)': 'PLT0',
    'AnmChr(NW4R)': 'CHR0', 'AnmTexSrt(NW4R)': 'SRT0', 'AnmTexPat(NW4R)': 'PAT0', 'AnmClr(NW4R)': 'CLR0',
    'AnmVis(NW4R)': 'VIS0', 'AnmShp(NW4R)': 'SHP0', 'AnmScn(NW4R)': 'SCN0',
}
WRAP = {0: 'clamp', 1: 'repeat', 2: 'mirror'}


class Brres:
    def __init__(self, data):
        if data[:4] != b'bres':
            raise ValueError('não é um arquivo BRRES')
        self.d = data
        root, = struct.unpack_from('>H', data, 12)
        self.folders = {name: self.group(off) for name, off in self.group(root + 8)}

    def u(self, fmt, off):
        return struct.unpack_from(fmt, self.d, off)

    def cstr(self, off):
        return self.d[off:self.d.index(b'\0', off)].decode('latin1')

    def group(self, off):
        """Index group -> [(nome, offset absoluto dos dados)] na ordem do arquivo."""
        _, n = self.u('>II', off)
        out = []
        for i in range(1, n + 1):
            e = off + 8 + i * 16
            _, _, _, _, name_off, data_off = self.u('>HHHHii', e)
            out.append((self.cstr(off + name_off), off + data_off))
        return out

    def entries(self, kind):
        """Itens de um tipo ('MDL0', 'CHR0', ...) -> [(nome, offset)]."""
        return [it for folder, items in self.folders.items() if WII_FOLDERS.get(folder) == kind for it in items]

    def model(self, name):
        for n, off in self.entries('MDL0'):
            if n == name:
                return Mdl0(self, n, off)
        raise KeyError(f'MDL0 {name} não existe')


class Mdl0:
    SECTIONS = {
        8: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'mat', 'shd', 'obj', 'tex', 'plt'],
        9: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'mat', 'shd', 'obj', 'tex', 'plt'],
        10: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'furv', 'furl', 'mat', 'shd', 'obj', 'tex', 'plt', 'user'],
        11: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'furv', 'furl', 'mat', 'shd', 'obj', 'tex', 'plt', 'user'],
    }

    def __init__(self, br, name, off):
        self.br, self.name, self.o = br, name, off
        self.version, = br.u('>I', off + 8)
        if self.version not in self.SECTIONS:
            raise ValueError(f'MDL0 versão {self.version} não suportada')
        names = self.SECTIONS[self.version]
        offs = br.u('>%di' % len(names), off + 0x10)
        self.sec = {n: (br.group(off + s) if s else []) for n, s in zip(names, offs)}

    def materials(self):
        """[{name, index, cull, layers: [{texture, palette, wrapS, wrapT}]}] na ordem do grupo."""
        u, out = self.br.u, []
        for name, o in self.sec['mat']:
            index, = u('>i', o + 0x0C)
            cull, = u('>I', o + 0x18)
            n_layers, layers_off = u('>Ii', o + 0x2C)
            layers = []
            for i in range(n_layers):
                c = o + layers_off + i * 0x34
                tex_off, plt_off = u('>ii', c)
                ws, wt = u('>II', c + 0x18)
                layers.append({
                    'texture': self.br.cstr(c + tex_off) if tex_off else None,
                    'palette': self.br.cstr(c + plt_off) if plt_off else None,
                    'wrapS': WRAP.get(ws, ws), 'wrapT': WRAP.get(wt, wt),
                })
            out.append({'name': name, 'index': index, 'cull': cull, 'layers': layers})
        return out

    def objects(self):
        return [name for name, _ in self.sec['obj']]

    def draw_list(self):
        """DrawOpa/DrawXlu -> [(índice do objeto, índice do material, translúcido)]."""
        d, out = self.br.d, []
        for name, p in self.sec['defs']:
            if name not in ('DrawOpa', 'DrawXlu'):
                continue
            while p < len(d):
                op = d[p]
                if op == 0x04:
                    mat, obj, _ = struct.unpack_from('>HHH', d, p + 1)
                    out.append((obj, mat, name == 'DrawXlu'))
                    p += 8
                elif op in (0x02, 0x05, 0x06):
                    p += 5
                elif op == 0x00:
                    p += 1
                else:
                    break
        return out
