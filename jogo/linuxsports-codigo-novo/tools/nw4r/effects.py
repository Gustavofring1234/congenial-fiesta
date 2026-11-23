"""Efeitos NW4R EF: .breff (definição dos emissores/partículas) e .breft (texturas de efeito), versão 7.

Contêiner (os dois formatos):
  0x00 magic 'REFF'/'REFT', u16 BOM 0xFEFF, u16 versão (7), u32 tamanho, u16 tam. cabeçalho, u16 nº blocos
  0x10 bloco 'REFF'/'REFT': u32 tamanho, 0x18 u32 offset (a partir de 0x18) da tabela,
       0x24 u16 tamanho do nome do projeto, 0x28 nome
  Tabela T: u32 tamanho, u16 n, u16 0, n × [u16 tamanho do nome][nome\\0][u32 offset a partir de T][u32 tamanho]

BREFT, cada textura (a partir de T + offset): cabeçalho 0x20
  0x00 u32 0  0x04 u16 largura  0x06 u16 altura  0x08 u32 tamanho dos dados  0x0C u8 formato GX
  0x0D u8 formato da paleta  0x0E u16 nº de cores  0x10 u32 tamanho da paleta  0x14 u8 mipmap
  0x15 u8 filtro min  0x16 u8 filtro mag  0x18 f32 LOD bias; dados em +0x20, paleta logo depois.

BREFF, cada emissor: u32 0, u32 tamanho do EmitterDesc (0x140), EmitterDesc, u32 tamanho dos
parâmetros da partícula, ParticleParameterDesc, bloco de animações. Os campos do EmitterDesc batem com
o layout v9 (Brawl) campo a campo (conferido em sports_physical.breff: vida 23, 20 partículas, escala 1,
translação (0, -45, 0)).

Curvas de animação (cabeçalho 0x20): u8 0xAC, u8 alvo, u8 tipo de valor (0 u8, 3 float, 4 textura,
5 filho, 6 rotação), u8 máscara de componentes, u8 flags (bit 7 = quadros relativos à vida), u8 laço,
u16 semente, u16 duração, u16 0, u32 tamanho de: chaves, faixas, aleatório, nomes, info.
Chaves: u16 n, u16 0, n × [u16 quadro][10 bytes de controle][valores]; valores u8 ocupam
ceil(componentes/2)*2 bytes, float 4 bytes por componente. Tamanhos conferidos nas 1.172 curvas dos 10 arquivos.

A interpretação dos alvos (cor, alfa, tamanho, escala, rotação, textura, campos) segue a ordem de
AnimCurveTarget do NW4R; `interpretation` no JSON marca as que são inferidas pelos dados.
"""
import math
import struct

from . import gx

FORMS = {0: 'disc', 1: 'line', 2: 'cube', 3: 'cylinder', 4: 'sphere', 5: 'point', 6: 'torus'}
# alvo -> (nome, componentes padrão, interpretação)
CURVE_TARGETS = {
    0x00: ('color0', 'rgb', 'nw4r'), 0x01: ('alpha0', 'a', 'nw4r'),
    0x02: ('color1', 'rgb', 'nw4r'), 0x03: ('alpha1', 'a', 'nw4r'),
    0x04: ('color0Secondary', 'rgb', 'nw4r'), 0x05: ('alpha0Secondary', 'a', 'nw4r'),
    0x06: ('color1Secondary', 'rgb', 'nw4r'), 0x07: ('alpha1Secondary', 'a', 'nw4r'),
    0x0A: ('size', 'xy', 'nw4r'), 0x0B: ('scale', 'xy', 'nw4r'), 0x0C: ('rotate', 'xyz', 'nw4r'),
    0x0E: ('texture0', 'index', 'nw4r'), 0x0F: ('texture1', 'index', 'nw4r'), 0x10: ('texture2', 'index', 'nw4r'),
    0x11: ('texScale0', 'xy', 'nw4r'), 0x12: ('texRotate0', 'x', 'nw4r'), 0x13: ('texTranslate0', 'xy', 'nw4r'),
    0x14: ('texScale1', 'xy', 'nw4r'), 0x15: ('texRotate1', 'x', 'nw4r'), 0x16: ('texTranslate1', 'xy', 'nw4r'),
    0x17: ('texScale2', 'xy', 'nw4r'), 0x18: ('texRotate2', 'x', 'nw4r'), 0x19: ('texTranslate2', 'xy', 'nw4r'),
    0x1A: ('child', 'raw', 'nw4r'),
    0x20: ('fieldGravity', 'x', 'inferido: valores ~0,01-0,1 unidade/quadro²'),
    0x21: ('fieldAirResistance', 'x', 'inferido: fator de velocidade por quadro 0,8-1'),
    0x26: ('fieldSpin', 'raw', 'inferido'), 0x27: ('fieldRandom', 'x', 'inferido'),
}


def _container(d, magic):
    if d[:4] != magic.encode():
        raise ValueError(f'não é {magic}')
    version, = struct.unpack_from('>H', d, 6)
    b = 0x10
    name_len, = struct.unpack_from('>H', d, b + 0x14)
    project = d[b + 0x18:b + 0x18 + max(0, name_len - 1)].decode('latin1')
    t = b + 8 + struct.unpack_from('>I', d, b + 8)[0]
    _, n = struct.unpack_from('>IH', d, t)
    p, entries = t + 8, []
    for _ in range(n):
        ln, = struct.unpack_from('>H', d, p)
        name = d[p + 2:p + 2 + ln - 1].decode('latin1')
        off, size = struct.unpack_from('>II', d, p + 2 + ln)
        entries.append((name, t + off, size))
        p += 2 + ln + 8
    return version, project, entries


# ---------------------------------------------------------------------- BREFT
def read_breft(d):
    version, project, entries = _container(d, 'REFT')
    out = []
    for name, o, size in entries:
        _, w, h, data_size, fmt, pfmt, ncol, psize, mip, fmin, fmag = struct.unpack_from('>IHHIBBHIBBB', d, o)
        pal = gx.palette(d, o + 0x20 + data_size, ncol, pfmt) if fmt in (8, 9, 10) and ncol else None
        if fmt not in gx.BLOCK:
            raise ValueError(f'{name}: formato GX {fmt} desconhecido')
        rgba = gx.decode(d, o + 0x20, w, h, fmt, pal)
        out.append({'name': name, 'width': w, 'height': h, 'format': gx.FORMAT_NAMES.get(fmt, fmt),
                    'mipmaps': mip, 'rgba': rgba, 'alpha': gx.has_alpha(rgba)})
    return {'version': version, 'project': project, 'textures': out}


# ---------------------------------------------------------------------- BREFF
def _f(d, p, n=1):
    v = struct.unpack_from('>%df' % n, d, p)
    return [round(x, 6) if math.isfinite(x) else 0.0 for x in v] if n > 1 else (round(v[0], 6) if math.isfinite(v[0]) else 0.0)


def _color(d, p):
    return list(d[p:p + 4])


def emitter_desc(d, e):
    common, emit_flag = struct.unpack_from('>II', d, e)
    emit_life, ptcl_life = struct.unpack_from('>HH', d, e + 8)
    life_rnd, _, interval_rnd, emit_rnd = struct.unpack_from('>bbbb', d, e + 0x0C)
    emit_start, emit_past, interval = struct.unpack_from('>HHH', d, e + 0x14)
    emit_div, vel_init_rnd, vel_mom_rnd = struct.unpack_from('>Hbb', d, e + 0x34)
    lod = list(d[e + 0x84:e + 0x88])
    seed, = struct.unpack_from('>I', d, e + 0x88)
    return {
        'commonFlags': common, 'emitFlags': emit_flag,
        'form': FORMS.get(emit_flag & 0xFF, f'form{emit_flag & 0xFF}'),
        'emitLife': emit_life, 'particleLife': ptcl_life, 'particleLifeRandomPct': life_rnd,
        'emitIntervalRandomPct': interval_rnd, 'emitRandomPct': emit_rnd,
        'emitCount': _f(d, e + 0x10), 'emitStart': emit_start, 'emitPast': emit_past, 'emitInterval': interval,
        'formParams': _f(d, e + 0x1C, 6), 'emitDivision': emit_div,
        'velocityInitRandomPct': vel_init_rnd, 'velocityMomentumRandomPct': vel_mom_rnd,
        'velocity': {
            'radial': _f(d, e + 0x38), 'yAxis': _f(d, e + 0x3C), 'random': _f(d, e + 0x40),
            'normal': _f(d, e + 0x44), 'normalDiffusion': _f(d, e + 0x48),
            'specified': _f(d, e + 0x4C), 'specifiedDiffusion': _f(d, e + 0x50), 'specifiedDirection': _f(d, e + 0x54, 3),
        },
        'scale': _f(d, e + 0x60, 3), 'rotate': _f(d, e + 0x6C, 3), 'translate': _f(d, e + 0x78, 3),
        'lod': lod, 'randomSeed': seed,
        'drawSettingsRaw': d[e + 0x94:e + 0x140].hex(),
    }


def _names_at(d, p, end, count=3):
    names, q = [], p
    for _ in range(count):
        if q + 2 > end:
            return None
        ln, = struct.unpack_from('>H', d, q)
        if ln == 0 or q + 2 + ln > end or d[q + 2 + ln - 1] != 0:
            return None
        s = d[q + 2:q + 2 + ln - 1]
        if any(c < 0x20 or c > 0x7E for c in s):
            return None
        names.append(s.decode('latin1') or None)
        q += 2 + ln
    return names


def particle_desc(d, p, size, known_textures):
    """ParticleParameterDesc: 4 cores, tamanho, escala, rotação, SRT de 3 texturas, nomes das texturas."""
    out = {
        'color0Primary': _color(d, p), 'color0Secondary': _color(d, p + 4),
        'color1Primary': _color(d, p + 8), 'color1Secondary': _color(d, p + 12),
        'size': _f(d, p + 0x10, 2), 'scale': _f(d, p + 0x18, 2), 'rotate': _f(d, p + 0x20, 3),
        'textureScale': [_f(d, p + 0x2C + 8 * i, 2) for i in range(3)],
        'textureRotate': _f(d, p + 0x44, 3),
        'textureTranslate': [_f(d, p + 0x50 + 8 * i, 2) for i in range(3)],
    }
    wrap, = struct.unpack_from('>H', d, p + 0x68)
    out['textureWrap'] = wrap
    out['textureReverse'] = d[p + 0x6A]
    out['alphaCompareRef'] = [d[p + 0x6B], d[p + 0x6C]]
    # nomes: 3 × [u16 tamanho][texto\\0], procurados a partir do fim dos campos fixos
    end = p + size
    names = None
    for q in range(p + 0x6E, end - 5, 2):
        cand = _names_at(d, q, end)
        if cand and (cand[0] is None or cand[0] in known_textures or q >= p + 0x80):
            names = cand
            out['namesOffset'] = q - p
            break
    out['textures'] = names or [None, None, None]
    return out


def curve(d, q):
    h = d[q:q + 0x20]
    if h[0] != 0xAC:
        raise ValueError('curva sem 0xAC')
    target, vtype, mask, flags, loop = h[1], h[2], h[3], h[4], h[5]
    seed, length = struct.unpack_from('>HH', h, 6)
    kt, rt, rnd, nm, inf = struct.unpack_from('>5I', h, 12)
    comps = bin(mask & 0xF).count('1') or 1
    tname, layout, interp = CURVE_TARGETS.get(target, (f'target{target:#04x}', 'raw', 'desconhecido'))
    c = {'target': tname, 'targetId': target, 'valueType': {0: 'u8', 3: 'float', 4: 'texture', 5: 'child', 6: 'rotate'}.get(vtype, vtype),
         'componentMask': mask, 'relativeToLife': bool(flags & 0x80), 'flags': flags, 'loop': loop,
         'length': length, 'interpretation': interp, 'keys': []}
    kp = q + 0x20
    n, = struct.unpack_from('>H', d, kp) if kt >= 4 else (0,)
    if vtype == 0:
        vsize = ((comps + 1) // 2) * 2
    elif vtype in (3, 6):
        vsize = 4 * comps
    else:
        vsize = ((kt - 4) // n - 12) if n else 0
    ksize = 12 + vsize
    if n and 4 + n * ksize <= kt:
        for k in range(n):
            o = kp + 4 + k * ksize
            frame, = struct.unpack_from('>H', d, o)
            ctrl = d[o + 2:o + 12]
            if vtype == 0:
                vals = list(d[o + 12:o + 12 + comps])
            elif vtype in (3, 6):
                vals = _f(d, o + 12, comps)
                vals = vals if isinstance(vals, list) else [vals]
            else:
                vals = list(d[o + 12:o + 12 + vsize])
            c['keys'].append({'frame': frame, 'interp': ctrl[0], 'values': vals})
    else:
        c['rawKeys'] = d[kp:kp + kt].hex()
    if rt:
        c['rangeRaw'] = d[kp + kt:kp + kt + rt].hex()
    if rnd:
        c['randomRaw'] = d[kp + kt + rt:kp + kt + rt + rnd].hex()
    total = 0x20 + kt + rt + rnd + nm + inf
    return c, total


def read_breff(d, known_textures=()):
    version, project, entries = _container(d, 'REFF')
    emitters = []
    for name, b, size in entries:
        _, esz = struct.unpack_from('>II', d, b)
        em = {'name': name}
        em['emitter'] = emitter_desc(d, b + 8)
        p = b + 8 + esz
        psz, = struct.unpack_from('>I', d, p)
        em['particle'] = particle_desc(d, p + 4, psz, set(known_textures))
        a = p + 4 + psz
        counts = struct.unpack_from('>4H', d, a)
        em['trackCounts'] = {'particle': counts[0], 'particleInit': counts[1], 'emitter': counts[2], 'emitterInit': counts[3]}
        q = a + 8
        while q < b + size and d[q] != 0xAC:
            q += 4
        curves = []
        while q < b + size and d[q] == 0xAC and len(curves) < sum(counts):
            c, n = curve(d, q)
            curves.append(c)
            q += n
        em['curves'] = curves
        emitters.append(em)
    return {'version': version, 'project': project, 'emitters': emitters}
