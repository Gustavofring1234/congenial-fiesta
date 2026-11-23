"""Animações NW4R G3D dentro de .brres: CHR0, SRT0, PAT0, CLR0, VIS0, SHP0, SCN0.

Versões presentes neste jogo (contadas em linuxsports-web/**.brres):
  CHR0 v4 (158)  SRT0 v4 (56)  CLR0 v3 (39)  SCN0 v4 (32)  PAT0 v3 (11)  SHP0 v3 (4)  VIS0 v3 (1)

Cabeçalhos (offsets relativos ao início do sub-arquivo; o campo de nome foi conferido em todos):
  CHR0 v4 / SRT0 v4: 0x10 dados  0x14 nome  0x18 caminho  0x1C u16 quadros  0x1E u16 entradas  0x20 loop  0x24 modo
  CLR0 v3 / VIS0 v3: 0x10 dados  0x14 nome  0x18 caminho  0x1C u16 quadros  0x1E u16 entradas  0x20 loop
  PAT0 v3:           0x10 dados  0x14 tabela tex  0x18 tabela plt  0x1C ptr tex  0x20 ptr plt  0x24 nome
                     0x28 caminho  0x2C u16 quadros  0x2E u16 entradas  0x30 u16 nTex  0x32 u16 nPlt  0x34 loop
  SHP0 v3:           0x10 dados  0x14 lista de nomes de vértices  0x18 nome  0x1C caminho
                     0x20 u16 quadros  0x22 u16 entradas  0x24 loop
  SCN0 v4:           0x10 dados  0x14 lightSet  0x18 ambiente  0x1C luzes  0x20 névoa  0x24 câmeras  0x28 nome
                     0x2C caminho  0x30 u16 quadros  0x32 u16 luzes especulares  0x34 loop
                     0x38 u16 nLightSet u16 nAmb  0x3C u16 nLuz u16 nNévoa  0x40 u16 nCâmera

Chaves: cada trilha sai como {"type": "hermite", "keys": [[quadro, valor, tangente], ...]},
{"type": "linear", "values": [v0, v1, ...]} (um valor por quadro) ou {"type": "const", "value": v}.
Hermite segue o NW4R: tangente em unidades por quadro, interpolação cúbica de Hermite entre chaves.
Todas as rotações são graus, no referencial do Wii (destro, Y para cima); a troca para o Unity
(canhoto, X espelhado) é feita no importador C#, igual ao que o glTFast faz com os .glb.

Offsets internos ambíguos (dados de chave relativos ao início da entrada ou ao próprio campo) são
resolvidos por validação: a leitura só é aceita se as chaves estiverem em ordem e dentro da duração.
"""
import math
import struct


class AnimError(ValueError):
    pass


class Reader:
    def __init__(self, br, off):
        self.d, self.o = br.d, off
        self.br = br

    def u(self, fmt, rel):
        return struct.unpack_from(fmt, self.d, self.o + rel)

    def at(self, fmt, absolute):
        return struct.unpack_from(fmt, self.d, absolute)

    def cstr(self, absolute):
        return self.br.cstr(absolute)


def _finite(*vals):
    return all(isinstance(v, (int, float)) and math.isfinite(v) for v in vals)


# ---------------------------------------------------------------------- chaves CHR0
def read_i4(d, p, frames):
    n, _ = struct.unpack_from('>HH', d, p)
    frame_scale, step, base = struct.unpack_from('>3f', d, p + 4)
    keys = []
    for i in range(n):
        v, = struct.unpack_from('>I', d, p + 0x10 + i * 4)
        f = v >> 24
        st = (v >> 12) & 0xFFF
        tan = ((v & 0xFFF) ^ 0x800) - 0x800
        keys.append([float(f), base + step * st, tan / 32.0])
    return keys


def read_i6(d, p, frames):
    n, _ = struct.unpack_from('>HH', d, p)
    frame_scale, step, base = struct.unpack_from('>3f', d, p + 4)
    keys = []
    for i in range(n):
        f, st, tan = struct.unpack_from('>hHh', d, p + 0x10 + i * 6)  # quadro com sinal (pré-roll)
        keys.append([f / 32.0, base + step * st, tan / 256.0])
    return keys


def read_i12(d, p, frames):
    n, _ = struct.unpack_from('>HH', d, p)
    keys = []
    for i in range(n):
        f, v, t = struct.unpack_from('>3f', d, p + 8 + i * 12)
        keys.append([f, v, t])
    return keys


def read_l(d, p, frames, kind):
    count = frames + 1
    if kind == 6:
        return list(struct.unpack_from('>%df' % count, d, p))
    step, base = struct.unpack_from('>2f', d, p)
    if kind == 4:
        raw = struct.unpack_from('>%dB' % count, d, p + 8)
    else:
        raw = struct.unpack_from('>%dH' % count, d, p + 8)
    return [base + step * r for r in raw]


def keys_ok(keys, frames):
    """Chaves plausíveis: finitas e em ordem não decrescente. Quadros fora de [0, duração] são
    legítimos (pré/pós-roll de laços, ex.: tns_A0_clapR começa em -1,27) e quadros repetidos
    marcam degraus."""
    if not keys:
        return False
    prev = -1e9
    for f, v, t in keys:
        if not _finite(f, v, t) or f < prev - 1e-4 or abs(f) > 2 * frames + 64 or abs(v) > 1e7:
            return False
        prev = f
    return True


def chr0_track(d, base_candidates, fmt, frames):
    """Lê uma trilha CHR0 no formato `fmt` (1 I4, 2 I6, 3 I12, 4 L1, 5 L2, 6 L4)."""
    for p in base_candidates:
        if p <= 0 or p >= len(d):
            continue
        try:
            if fmt in (1, 2, 3):
                keys = (read_i4, read_i6, read_i12)[fmt - 1](d, p, frames)
                if keys_ok(keys, frames):
                    return {'type': 'hermite', 'keys': keys}
            else:
                vals = read_l(d, p, frames, fmt)
                if all(_finite(v) for v in vals):
                    return {'type': 'linear', 'values': vals}
        except struct.error:
            continue
    raise AnimError(f'trilha CHR0 formato {fmt} ilegível')


# ---------------------------------------------------------------------- CHR0
def parse_chr0(br, name, off):
    r = Reader(br, off)
    data, = r.u('>i', 0x10)
    frames, n = r.u('>HH', 0x1C)
    loop, scaling = r.u('>II', 0x20)
    bones = []
    for bname, e in br.group(off + data):
        code, = r.at('>I', e + 4)
        p = e + 8
        node = {'bone': bname, 'code': code}
        fmt_s, fmt_r, fmt_t = (code >> 25) & 3, (code >> 27) & 7, (code >> 30) & 3
        has_s, has_r, has_t = code & (1 << 22), code & (1 << 23), code & (1 << 24)
        if code & 2:  # identidade
            node.update(identity=True)
            bones.append(node)
            continue

        def channel(present, iso, fixed_bits, fmt, default):
            nonlocal p
            if not present:
                return None
            axes = 1 if iso else 3
            out = []
            for a in range(axes):
                if code & (1 << fixed_bits[a]):
                    v, = r.at('>f', p)
                    out.append({'type': 'const', 'value': v})
                else:
                    rel, = r.at('>i', p)
                    out.append(chr0_track(br.d, (e + rel, p + rel), fmt, frames))
                p += 4
            if iso:
                out = out * 3
            return out
        node['scale'] = channel(has_s, code & (1 << 4), (13, 14, 15), fmt_s, 1.0)
        node['rotate'] = channel(has_r, code & (1 << 5), (16, 17, 18), fmt_r, 0.0)
        node['translate'] = channel(has_t, code & (1 << 6), (19, 20, 21), fmt_t, 0.0)
        node['flags'] = {
            'rotTransZero': bool(code & 4), 'scaleOne': bool(code & 8),
            'useModelScale': bool(code & (1 << 7)), 'useModelRotate': bool(code & (1 << 8)),
            'useModelTranslate': bool(code & (1 << 9)), 'segmentScaleCompensate': bool(code & (1 << 10)),
        }
        bones.append(node)
    if len(bones) != n:
        raise AnimError(f'CHR0 {name}: {len(bones)} ossos lidos, cabeçalho diz {n}')
    return {'type': 'CHR0', 'name': name, 'frames': frames, 'loop': bool(loop), 'scalingRule': scaling, 'bones': bones}


# ---------------------------------------------------------------------- SRT0
SRT_KEYS = ('scaleS', 'scaleT', 'rotate', 'translateS', 'translateT')


def i12_track(d, candidates, frames):
    for p in candidates:
        if 0 < p < len(d):
            try:
                keys = read_i12(d, p, frames)
            except struct.error:
                continue
            if keys_ok(keys, frames):
                return {'type': 'hermite', 'keys': keys}
    raise AnimError('trilha I12 ilegível')


def parse_srt0(br, name, off):
    r = Reader(br, off)
    data, = r.u('>i', 0x10)
    frames, n = r.u('>HH', 0x1C)
    loop, mode = r.u('>II', 0x20)
    mats = []
    for mname, e in br.group(off + data):
        tex_flags, ind_flags = r.at('>II', e + 4)
        slots = [i for i in range(8) if tex_flags & (1 << i)] + [8 + i for i in range(3) if ind_flags & (1 << i)]
        entry = {'material': mname, 'textures': []}
        for k, slot in enumerate(slots):
            rel, = r.at('>i', e + 12 + k * 4)
            te = e + rel
            code, = r.at('>I', te)
            p = te + 4
            tr = {'slot': slot if slot < 8 else None, 'indirect': slot - 8 if slot >= 8 else None}
            vals = {}
            fixed = {'scaleS': 5, 'scaleT': 6, 'rotate': 7, 'translateS': 8, 'translateT': 9}

            def read(key):
                nonlocal p
                if code & (1 << fixed[key]):
                    v, = r.at('>f', p)
                    vals[key] = {'type': 'const', 'value': v}
                else:
                    rr, = r.at('>i', p)
                    vals[key] = i12_track(br.d, (te + rr, p + rr, e + rr), frames)
                p += 4
            if not code & 2:  # escala != 1
                read('scaleS')
                if code & 0x10:
                    vals['scaleT'] = vals['scaleS']
                else:
                    read('scaleT')
            if not code & 4:  # rotação != 0
                read('rotate')
            if not code & 8:  # translação != 0
                read('translateS')
                read('translateT')
            tr.update(vals)
            entry['textures'].append(tr)
        mats.append(entry)
    return {'type': 'SRT0', 'name': name, 'frames': frames, 'loop': bool(loop), 'matrixMode': mode, 'materials': mats}


# ---------------------------------------------------------------------- CLR0
CLR_TARGETS = ('mat0', 'mat1', 'amb0', 'amb1', 'tev0', 'tev1', 'tev2', 'kon0', 'kon1', 'kon2', 'kon3')


def parse_clr0(br, name, off):
    r = Reader(br, off)
    data, = r.u('>i', 0x10)
    frames, n = r.u('>HH', 0x1C)
    loop, = r.u('>I', 0x20)
    mats = []
    for mname, e in br.group(off + data):
        flags, = r.at('>I', e + 4)
        p = e + 8
        targets = []
        for i, tname in enumerate(CLR_TARGETS):
            if not flags & (1 << (2 * i)):
                continue
            mask, = r.at('>I', p)
            if flags & (1 << (2 * i + 1)):
                c, = r.at('>I', p + 4)
                targets.append({'target': tname, 'mask': mask, 'const': [(c >> 24) & 255, (c >> 16) & 255, (c >> 8) & 255, c & 255]})
            else:
                rel, = r.at('>i', p + 4)
                cols = None
                for base in (p + 4 + rel, e + rel, p + rel):
                    if 0 < base and base + (frames + 1) * 4 <= len(br.d):
                        cols = [list(br.d[base + k * 4: base + k * 4 + 4]) for k in range(frames + 1)]
                        break
                if cols is None:
                    raise AnimError(f'CLR0 {name}/{mname}: cores fora do arquivo')
                targets.append({'target': tname, 'mask': mask, 'frames': cols})
            p += 8
        mats.append({'material': mname, 'targets': targets})
    return {'type': 'CLR0', 'name': name, 'frames': frames, 'loop': bool(loop), 'materials': mats}


# ---------------------------------------------------------------------- VIS0
def parse_vis0(br, name, off):
    r = Reader(br, off)
    data, = r.u('>i', 0x10)
    frames, n = r.u('>HH', 0x1C)
    loop, = r.u('>I', 0x20)
    bones = []
    for bname, e in br.group(off + data):
        flags, = r.at('>I', e + 4)
        if flags & 2:
            bones.append({'bone': bname, 'const': bool(flags & 1)})
            continue
        count = frames + 1
        nbytes = ((count + 31) // 32) * 4
        bits = br.d[e + 8:e + 8 + nbytes]
        vis = [bool(bits[k >> 3] & (0x80 >> (k & 7))) for k in range(count)]
        bones.append({'bone': bname, 'frames': vis})
    return {'type': 'VIS0', 'name': name, 'frames': frames, 'loop': bool(loop), 'bones': bones}


# ---------------------------------------------------------------------- PAT0
def _name_table(br, table_abs, count):
    out = []
    for k in range(count):
        rel, = struct.unpack_from('>i', br.d, table_abs + k * 4)
        out.append(br.cstr(table_abs + rel) if rel else None)
    return out


def parse_pat0(br, name, off):
    r = Reader(br, off)
    data, tex_tbl, plt_tbl = r.u('>iii', 0x10)
    frames, n, ntex, nplt = r.u('>HHHH', 0x2C)
    loop, = r.u('>I', 0x34)
    tex_names = _name_table(br, off + tex_tbl, ntex) if ntex else []
    plt_names = _name_table(br, off + plt_tbl, nplt) if nplt else []
    mats = []
    for mname, e in br.group(off + data):
        flags, = r.at('>I', e + 4)
        p = e + 8
        slots = []
        for slot in range(8):
            f = (flags >> (slot * 4)) & 0xF
            if not f & 1:
                continue
            entry = {'slot': slot, 'hasTexture': bool(f & 4), 'hasPalette': bool(f & 8)}
            if f & 2:  # fixo
                ti, pi = r.at('>HH', p)
                entry['const'] = {'texture': tex_names[ti] if ti < len(tex_names) else None,
                                  'palette': plt_names[pi] if pi < len(plt_names) and f & 8 else None}
            else:
                rel, = r.at('>i', p)
                keys = None
                for base in (e + rel, p + rel):
                    if not 0 < base < len(br.d):
                        continue
                    try:
                        cnt, _ = r.at('>HH', base)
                        ks = [list(r.at('>fHH', base + 8 + k * 8)) for k in range(cnt)]
                    except struct.error:
                        continue
                    if ks and all(_finite(k[0]) and abs(k[0]) <= 2 * frames + 64 and k[1] < max(1, ntex) for k in ks) \
                            and all(ks[i][0] <= ks[i + 1][0] for i in range(len(ks) - 1)):
                        keys = ks
                        break
                if keys is None:
                    raise AnimError(f'PAT0 {name}/{mname}: chaves ilegíveis')
                entry['keys'] = [{'frame': fr, 'texture': tex_names[ti] if ti < len(tex_names) else None,
                                  'palette': plt_names[pi] if (f & 8 and pi < len(plt_names)) else None} for fr, ti, pi in keys]
            p += 4
            slots.append(entry)
        mats.append({'material': mname, 'slots': slots})
    return {'type': 'PAT0', 'name': name, 'frames': frames, 'loop': bool(loop),
            'textures': tex_names, 'palettes': plt_names, 'materials': mats}


# ---------------------------------------------------------------------- SHP0
def parse_shp0(br, name, off):
    r = Reader(br, off)
    data, names_tbl = r.u('>ii', 0x10)
    frames, n = r.u('>HH', 0x20)
    loop, = r.u('>I', 0x24)
    # lista de nomes dos conjuntos de vértices: `n` (u16 em 0x22) offsets i32 relativos à própria lista
    tbl = off + names_tbl
    vertex_sets = []
    for k in range(n):
        rel, = struct.unpack_from('>i', br.d, tbl + k * 4)
        nm = None
        for c in (tbl + rel, tbl + k * 4 + rel, off + rel):
            if 0 < c < len(br.d):
                try:
                    cand = br.cstr(c)
                except ValueError:
                    continue
                if cand and cand.isprintable():
                    nm = cand
                    break
        vertex_sets.append(nm)
    shapes = []
    for sname, e in br.group(off + data):
        flags, name_rel = r.at('>Ii', e)
        base_id, nidx = r.at('>hH', e + 8)
        fixed, idx_rel = r.at('>Ii', e + 12)
        idxs = [struct.unpack_from('>H', br.d, e + idx_rel + k * 2)[0] for k in range(nidx)]
        targets = []
        for k, vi in enumerate(idxs):
            field = e + 0x14 + k * 4
            if fixed & (1 << k):
                v, = r.at('>f', field)
                tr = {'type': 'const', 'value': v}
            else:
                rel, = r.at('>i', field)
                tr = i12_track(br.d, (e + rel, field + rel), frames)
            targets.append({'vertexSet': vertex_sets[vi] if vi < len(vertex_sets) else None, 'weight': tr})
        shapes.append({'shape': sname, 'base': vertex_sets[base_id] if 0 <= base_id < len(vertex_sets) else None,
                       'flags': flags, 'targets': targets})
    return {'type': 'SHP0', 'name': name, 'frames': frames, 'loop': bool(loop), 'vertexSets': vertex_sets, 'shapes': shapes}


# ---------------------------------------------------------------------- SCN0
def scn0_keys(d, p, frames):
    """Chaves de SCN0: u16 n, u16 ?, n × {f32, f32, f32}; a ordem dos 3 floats é detectada."""
    n, _ = struct.unpack_from('>HH', d, p)
    if n == 0 or n > 4096:
        return None
    raw = [struct.unpack_from('>3f', d, p + 4 + k * 12) for k in range(n)]
    for order in ((1, 2, 0), (0, 1, 2)):  # (tangente, quadro, valor) primeiro, depois (quadro, valor, tangente)
        keys = [[k[order[0]], k[order[1]], k[order[2]]] for k in raw]
        if keys_ok(keys, frames):
            return {'type': 'hermite', 'keys': keys}
    return None


CAM_FIELDS = [  # (nome, offset, bit "constante" em flags1)
    ('posX', 0x20, 1), ('posY', 0x24, 2), ('posZ', 0x28, 3), ('aspect', 0x2C, 4), ('near', 0x30, 5), ('far', 0x34, 6),
    ('rotX', 0x38, 13), ('rotY', 0x3C, 14), ('rotZ', 0x40, 15), ('aimX', 0x44, 9), ('aimY', 0x48, 10), ('aimZ', 0x4C, 11),
    ('twist', 0x50, 12), ('fovY', 0x54, 7), ('orthoHeight', 0x58, 8),
]


def _scn0_float(br, field_abs, entry_abs, constant, frames):
    if constant:
        v, = struct.unpack_from('>f', br.d, field_abs)
        return {'type': 'const', 'value': v}
    rel, = struct.unpack_from('>i', br.d, field_abs)
    if rel == 0:  # campo vazio (câmeras-placeholder sem nome têm todos os campos zerados)
        return {'type': 'const', 'value': 0.0}
    for base in (field_abs + rel, entry_abs + rel):
        if 0 < base < len(br.d):
            k = scn0_keys(br.d, base, frames)
            if k:
                return k
    v, = struct.unpack_from('>f', br.d, field_abs)
    return {'type': 'const', 'value': v, 'unresolved': True}


def _color(c):
    return [(c >> 24) & 255, (c >> 16) & 255, (c >> 8) & 255, c & 255]


def parse_scn0(br, name, off):
    r = Reader(br, off)
    data, light_sets, ambs, lights, fogs, cams = r.u('>6i', 0x10)
    frames, spec = r.u('>HH', 0x30)
    loop, = r.u('>I', 0x34)
    n_ls, n_amb, n_light, n_fog = r.u('>4H', 0x38)
    n_cam, = r.u('>H', 0x40)
    out = {'type': 'SCN0', 'name': name, 'frames': frames, 'loop': bool(loop),
           'cameras': [], 'lights': [], 'ambients': [], 'lightSets': [], 'fogs': []}
    # entradas em ordem: cada bloco começa com SCN0CommonHeader (tamanho, offset do scn0, nome, índices)
    p = off + cams
    for _ in range(n_cam if cams else 0):
        size, _, name_rel = r.at('>iii', p)
        cname = br.cstr(p + name_rel) if name_rel else ''
        proj, flags1, flags2 = r.at('>iHH', p + 0x14)
        cam = {'name': cname, 'projection': 'ortho' if proj == 1 else 'perspective',
               'type': 'aim' if flags2 & 1 else 'rotate', 'placeholder': not cname and flags1 == 0}
        for fname, fo, bit in CAM_FIELDS:
            cam[fname] = _scn0_float(br, p + fo, p, bool(flags1 & (1 << bit)), frames)
        out['cameras'].append(cam)
        p += size if size > 0 else 0x5C
    p = off + ambs
    for _ in range(n_amb if ambs else 0):
        size, _, name_rel = r.at('>iii', p)
        fixed, enable = r.at('>B2xB', p + 0x14)
        c, = r.at('>I', p + 0x18)
        amb = {'name': br.cstr(p + name_rel) if name_rel else '', 'enable': enable}
        if fixed & 0x80:
            amb['color'] = _color(c)
        else:
            base = p + 0x18 + c
            amb['frames'] = [_color(struct.unpack_from('>I', br.d, base + 4 * k)[0]) for k in range(frames + 1)]
        out['ambients'].append(amb)
        p += size if size > 0 else 0x1C
    p = off + lights
    # SCN0Light (0x5C): 0x1C u16 fixos, 0x1E u16 uso (bits 0-1 tipo: 0 ponto, 1 direcional, 2 spot; bit 2 ativa)
    # 0x24 início(3f) 0x30 cor 0x34 fim/alvo(3f) 0x40 função de distância 0x44 dist. ref. 0x48 brilho ref.
    # 0x4C função spot 0x50 corte(graus) 0x54 cor especular 0x58 brilho especular
    for _ in range(n_light if lights else 0):
        size, _, name_rel = r.at('>iii', p)
        fixed, usage = r.at('>HH', p + 0x1C)
        light = {'name': br.cstr(p + name_rel) if name_rel else '',
                 'kind': ('point', 'directional', 'spot', 'point')[usage & 3], 'usage': usage}
        for i, axis in enumerate('XYZ'):
            light['start' + axis] = _scn0_float(br, p + 0x24 + i * 4, p, bool(fixed & (1 << (3 + i))), frames)
            light['end' + axis] = _scn0_float(br, p + 0x34 + i * 4, p, bool(fixed & (1 << (7 + i))), frames)
        c, = r.at('>I', p + 0x30)
        if fixed & (1 << 6):
            light['color'] = _color(c)
        else:
            base = p + 0x30 + c
            light['colorFrames'] = [_color(struct.unpack_from('>I', br.d, base + 4 * k)[0]) for k in range(frames + 1)]
        dist_fn, ref_d, ref_b, spot_fn, cutoff = r.at('>iffif', p + 0x40)
        spec, shin = r.at('>If', p + 0x54)
        light.update(distanceFunction=dist_fn, refDistance=ref_d, refBrightness=ref_b, spotFunction=spot_fn,
                     cutoffDeg=cutoff, specular=_color(spec), shininess=shin)
        out['lights'].append(light)
        p += size if size > 0 else 0x5C
    p = off + light_sets
    for _ in range(n_ls if light_sets else 0):
        size, _, name_rel = r.at('>iii', p)
        amb_rel, = r.at('>i', p + 0x14)
        nl, = r.at('>B', p + 0x1A)
        names = []
        for k in range(min(nl, 8)):
            rel, = r.at('>i', p + 0x1C + k * 4)
            names.append(br.cstr(p + 0x1C + rel) if rel else None)
        out['lightSets'].append({'name': br.cstr(p + name_rel) if name_rel else '',
                                 'ambient': br.cstr(p + 0x14 + amb_rel) if amb_rel else None, 'lights': names})
        p += size if size > 0 else 0x4C
    return out


PARSERS = {'CHR0': parse_chr0, 'SRT0': parse_srt0, 'CLR0': parse_clr0, 'VIS0': parse_vis0,
           'PAT0': parse_pat0, 'SHP0': parse_shp0, 'SCN0': parse_scn0}


def parse(br, kind, name, off):
    return PARSERS[kind](br, name, off)


# ---------------------------------------------------------------------- amostragem
def sample(track, frame):
    """Valor de uma trilha no quadro (mesma regra do player C#)."""
    if track is None:
        return None
    t = track['type']
    if t == 'const':
        return track['value']
    if t == 'linear':
        v = track['values']
        if frame <= 0:
            return v[0]
        if frame >= len(v) - 1:
            return v[-1]
        i = int(frame)
        f = frame - i
        return v[i] + (v[i + 1] - v[i]) * f
    k = track['keys']
    if frame <= k[0][0]:
        return k[0][1]
    if frame >= k[-1][0]:
        return k[-1][1]
    i = 0
    while i + 1 < len(k) and k[i + 1][0] <= frame:
        i += 1
    (f0, v0, t0), (f1, v1, t1) = k[i], k[i + 1]
    dt = f1 - f0
    if dt <= 0:
        return v1
    s = (frame - f0) / dt
    s2, s3 = s * s, s * s * s
    return ((2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * dt * t0
            + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * dt * t1)
