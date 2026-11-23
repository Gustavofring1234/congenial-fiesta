"""RVL Face Library (RFL): RFL_Res.dat e RFLCharData (.rcd, 74 bytes).

Tudo aqui foi tirado do código do RFL ligado ao main.dol (nomes em functions.tsv):

RFL_Res.dat (parseOnmemoryRes_ / RFLiLoadShape / RFLiGetShapeSize)
  u16 numArchives (=18), u16 ?, u32 archiveOffset[18]
  arquivo: u16 numParts, u16 maxPartSize, u32 partOffset[numParts + 1], dados
  parte i = dados[partOffset[i] : partOffset[i + 1]]  (dados começam em archive + 4 + 4*(numParts+1))

Mapas parte -> arquivo (tabelas do DOL):
  forma   (0x80380f0c): Nose 13, Forehead 5, Faceline 3, Hair 8, Cap 16, Beard 0, Noseline 14, Mask 9, Glass 6
  textura (0x80380ea0): Eye 1, Eyebrow 2, Mouth 11, Mustache 12, Mole 10
  textura de forma (0x80380ec8): Faceline(maquiagem) 4, Cap 17, Noseline 15, Glass 7

Forma (RFLiInitShapeRes): char[4] nome; (só Faceline) 3 × float3 âncoras (nariz, barba, cabelo);
  u16 nPos, s16[3]*nPos (ponto fixo 8 bits); u16 nNrm, s16[3]*nNrm (14 bits);
  (exceto Nose, Forehead, Hair, Beard) u16 nTex, s16[2]*nTex (13 bits);
  u8 nPrim; por primitiva: u8 nVtx, u8 tipo GX, nVtx × (u8 pos, u8 nrm[, u8 tex]).
Textura: cabeçalho BTI de 32 bytes (formato, largura, altura, wrapS, wrapT, ..., offset dos dados em 0x1C).

RFLCharData -> RFLiCharInfo: convertRaw2InfoCore_ @ 0x80172dac (reproduzido bit a bit em raw_to_info).
"""
import struct

SHAPE_ARC = {'nose': 13, 'forehead': 5, 'faceline': 3, 'hair': 8, 'cap': 16, 'beard': 0,
             'noseline': 14, 'mask': 9, 'glass': 6}
TEX_ARC = {'eye': 1, 'eyebrow': 2, 'mouth': 11, 'mustache': 12, 'mole': 10}
SHPTEX_ARC = {'faceline': 4, 'cap': 17, 'noseline': 15, 'glass': 7}
# Formas sem coordenada de textura (máscara 0x2b em RFLiInitShapeRes: kinds 0,1,3,5)
NO_TEXCOORD = {'nose', 'forehead', 'hair', 'beard'}
GX_PRIM = {0x80: 'quads', 0x90: 'triangles', 0x98: 'tristrip', 0xA0: 'trifan'}


class RflRes:
    def __init__(self, data):
        self.data = data
        n = struct.unpack('>H', data[:2])[0]
        self.offsets = struct.unpack(f'>{n}I', data[4:4 + 4 * n])

    def parts(self, arc):
        o = self.offsets[arc]
        n, _max = struct.unpack('>HH', self.data[o:o + 4])
        table = struct.unpack(f'>{n + 1}I', self.data[o + 4:o + 8 + 4 * n])
        base = o + 8 + 4 * n
        return [self.data[base + table[i]:base + table[i + 1]] for i in range(n)]


def _triangles(prims):
    """Primitivas GX -> lista de triângulos (índices de vértice da primitiva), na ordem do GX."""
    tris = []
    for kind, v in prims:
        if kind == 0x90:
            tris += [tuple(v[i:i + 3]) for i in range(0, len(v) - 2, 3)]
        elif kind == 0x98:
            for i in range(len(v) - 2):
                tris.append((v[i], v[i + 1], v[i + 2]) if i % 2 == 0 else (v[i + 1], v[i], v[i + 2]))
        elif kind == 0xA0:
            tris += [(v[0], v[i], v[i + 1]) for i in range(1, len(v) - 1)]
        elif kind == 0x80:
            for i in range(0, len(v) - 3, 4):
                tris += [(v[i], v[i + 1], v[i + 2]), (v[i], v[i + 2], v[i + 3])]
        else:
            raise ValueError(f'primitiva GX não suportada: {kind:#x}')
    return [t for t in tris if len(set(t)) == 3]


def parse_shape(kind, blob):
    """Forma -> dict com vértices unificados (pos, nrm, uv) e triângulos.

    Posição em unidades do RFL (s16 / 256), sistema destro do Wii (Y para cima, Z para a frente).
    Triângulos orientados para fora: cross(b-a, c-a) · normal > 0 (sentido anti-horário visto de fora).
    """
    if len(blob) <= 9:
        return None
    p = 4
    out = {'name': blob[:4].decode('ascii')}
    if kind == 'faceline':
        out['anchors'] = {k: [round(x, 5) for x in struct.unpack('>3f', blob[p + 12 * i:p + 12 * i + 12])]
                          for i, k in enumerate(('nose', 'beard', 'hair'))}
        p += 36

    def vec(count, comps, scale):
        nonlocal p
        vals = struct.unpack(f'>{count * comps}h', blob[p:p + 2 * count * comps])
        p += 2 * count * comps
        return [tuple(vals[i + k] / scale for k in range(comps)) for i in range(0, len(vals), comps)]

    n = struct.unpack('>H', blob[p:p + 2])[0]; p += 2
    if n == 0:
        return None
    pos = vec(n, 3, 256.0)
    n = struct.unpack('>H', blob[p:p + 2])[0]; p += 2
    nrm = vec(n, 3, 16384.0)
    tex = []
    if kind not in NO_TEXCOORD:
        n = struct.unpack('>H', blob[p:p + 2])[0]; p += 2
        tex = vec(n, 2, 8192.0)
    nprim = blob[p]; p += 1
    stride = 2 if kind in NO_TEXCOORD else 3
    verts, index, prims = [], {}, []
    for _ in range(nprim):
        cnt, gtype = blob[p], blob[p + 1]; p += 2
        ids = []
        for _ in range(cnt):
            key = tuple(blob[p:p + stride]); p += stride
            if key not in index:
                index[key] = len(verts); verts.append(key)
            ids.append(index[key])
        prims.append((gtype, ids))
    tris = _triangles(prims)
    # Orientação: o GX não diz qual sentido é a frente; decide-se pelas normais de vértice.
    agree = 0
    for a, b, c in tris:
        pa, pb, pc = (pos[verts[i][0]] for i in (a, b, c))
        e1 = [pb[k] - pa[k] for k in range(3)]; e2 = [pc[k] - pa[k] for k in range(3)]
        cr = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
        nn = [sum(nrm[verts[i][1]][k] for i in (a, b, c)) for k in range(3)]
        agree += (cr[0] * nn[0] + cr[1] * nn[1] + cr[2] * nn[2]) > 0
    flipped = agree < len(tris) / 2
    if flipped:
        tris = [(a, c, b) for a, b, c in tris]
    r = lambda v: [round(x, 5) for x in v]
    out['positions'] = [x for v in verts for x in r(pos[v[0]])]
    out['normals'] = [x for v in verts for x in r(nrm[v[1]])]
    if tex:
        out['uvs'] = [x for v in verts for x in r(tex[v[2]])]
    out['triangles'] = [i for t in tris for i in t]
    out['stats'] = {'vertices': len(verts), 'triangles': len(tris), 'primitives': len(prims),
                    'gxPrimTypes': sorted({GX_PRIM.get(g, hex(g)) for g, _ in prims}),
                    'windingAgreement': round(max(agree, len(tris) - agree) / max(1, len(tris)), 4)}
    return out


def parse_texture(blob):
    """BTI de 32 bytes + dados -> (meta, offset dos dados)."""
    fmt, _alpha, w, h, ws, wt = struct.unpack('>BBHHBB', blob[:8])
    off = struct.unpack('>I', blob[0x1C:0x20])[0]
    return {'format': fmt, 'width': w, 'height': h, 'wrapS': ws, 'wrapT': wt}, off


def raw_to_info(raw):
    """RFLCharData (74 bytes) -> campos do RFLiCharInfo (convertRaw2InfoCore_ + RFLiConvertRaw2Info)."""
    assert len(raw) == 74, len(raw)
    h = lambda off: struct.unpack('>H', raw[off:off + 2])[0]
    face, hair = h(0x20), h(0x22)
    b24, b26, e28, e2a = h(0x24), h(0x26), h(0x28), h(0x2A)
    nose, mouth, glass, beard, mole = h(0x2C), h(0x2E), h(0x30), h(0x32), h(0x34)
    eye = (e28 & 0x1F) << 5 | (e2a & 0x1E0) << 5 | (e28 & 0x3E0) << 9 | (e2a & 0x1E00) << 10 \
        | (e2a & 0xE000) << 10 | (e28 & 0xFC00) << 16
    brow = (b26 & 0x1F0) << 2 | (b26 & 0xF) << 11 | (b24 & 0x7C0) << 9 | (b26 & 0x1E00) << 11 \
        | (b26 & 0xE000) << 11 | (b24 & 0xF800) << 16
    mole_i = (mole >> 5) & 0x3E | (mole & 0x3E) << 5 | mole & 0x7800 | mole & 0x8000
    personal = ((h(0x20) >> 2) & 1) | (h(0x00) << 1)
    name = raw[0x02:0x16].decode('utf-16-be').split('\0')[0]
    creator = raw[0x36:0x4A].decode('utf-16-be').split('\0')[0]
    f = lambda v, sh, w: (v >> sh) & ((1 << w) - 1)
    return {
        'name': name, 'creator': creator,
        'sex': f(h(0x00), 14, 1), 'birthMonth': f(h(0x00), 10, 4), 'birthDay': f(h(0x00), 5, 5),
        'favoriteColor': f(personal, 2, 4), 'favorite': f(h(0x00), 0, 1),
        'height': raw[0x16], 'build': raw[0x17], 'createId': raw[0x18:0x20].hex(),
        'faceline': {'type': f(face, 13, 3), 'color': f(face, 10, 3), 'texture': f(face, 6, 4)},
        'hair': {'type': f(hair, 9, 7), 'color': f(hair, 6, 3), 'flip': f(hair, 5, 1)},
        'eye': {'type': f(eye, 26, 6), 'color': f(eye, 23, 3), 'scale': f(eye, 19, 4),
                'rotate': f(eye, 14, 5), 'x': f(eye, 10, 4), 'y': f(eye, 5, 5)},
        'eyebrow': {'type': f(brow, 27, 5), 'color': f(brow, 24, 3), 'scale': f(brow, 20, 4),
                    'rotate': f(brow, 15, 5), 'x': f(brow, 11, 4), 'y': f(brow, 6, 5)},
        'nose': {'type': f(nose, 12, 4), 'scale': f(nose, 8, 4), 'y': f(nose, 3, 5)},
        'mouth': {'type': f(mouth, 11, 5), 'color': f(mouth, 9, 2), 'scale': f(mouth, 5, 4), 'y': f(mouth, 0, 5)},
        'beard': {'mustache': f(beard, 14, 2), 'type': f(beard, 12, 2), 'color': f(beard, 9, 3),
                  'scale': f(beard, 5, 4), 'y': f(beard, 0, 5)},
        'glass': {'type': f(glass, 12, 4), 'color': f(glass, 9, 3), 'scale': f(glass, 5, 4), 'y': f(glass, 0, 5)},
        'mole': {'type': f(mole_i, 15, 1), 'scale': f(mole_i, 11, 4), 'x': f(mole_i, 6, 5), 'y': f(mole_i, 1, 5)},
    }
