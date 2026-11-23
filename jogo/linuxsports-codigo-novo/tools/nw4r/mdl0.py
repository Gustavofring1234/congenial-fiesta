"""MDL0 (NW4R G3D v8/v9): esqueleto, envelopes e reprodução da geometria dos .glb.

Os .glb de linuxsports-web-wispt/models/ foram gerados por linuxsports-game/scripts/brres2glb.py,
que exporta a malha ESTÁTICA na pose de repouso (sem ossos). Para animar com CHR0 no Unity é
preciso saber, para cada vértice do .glb, a que matriz (osso ou envelope) ele pertence.
Este módulo refaz exatamente o mesmo percurso do conversor original (mesma leitura das display
lists, mesma deduplicação de vértices, mesma ordem de malhas: opacas antes das translúcidas),
então o vértice i daqui é o vértice i do .glb. O exportador confere a contagem e as posições.

Estrutura do osso (offsets relativos ao início do osso):
  0x08 nome  0x0C índice  0x10 id de matriz  0x14 flags  0x18 billboard
  0x20 escala(3f)  0x2C rotação em graus(3f)  0x38 translação(3f)
  0x5C pai  0x60 1º filho  0x64 próximo  0x68 anterior (offsets relativos ao osso; 0 = nenhum)
  0x70 matriz de mundo 3x4 (pose de repouso)  0xA0 inversa 3x4
NodeMix (defs): 0x03 [u16 id][u8 n] n×[u16 id do nó][f32 peso] (envelope)
                0x05 [u16 id][u16 índice do osso] (matriz = osso)   0x01 fim
"""
import struct

from . import gx

FMT = {0: ('B', 1), 1: ('b', 1), 2: ('H', 2), 3: ('h', 2), 4: ('f', 4)}
IDENT = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]
SECTIONS = {
    8: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'mat', 'shd', 'obj', 'tex', 'plt'],
    9: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'mat', 'shd', 'obj', 'tex', 'plt'],
    10: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'furv', 'furl', 'mat', 'shd', 'obj', 'tex', 'plt', 'x'],
    11: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'furv', 'furl', 'mat', 'shd', 'obj', 'tex', 'plt', 'x'],
}


def mat_apply(m, p):
    return [m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3],
            m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3],
            m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3]]


class Mdl0Geometry:
    def __init__(self, br, name, off):
        self.br, self.name, self.o = br, name, off
        u = br.u
        self.version, = u('>I', off + 8)
        if self.version not in SECTIONS:
            raise ValueError(f'MDL0 versão {self.version} não suportada')
        names = SECTIONS[self.version]
        secs = u('>%di' % len(names), off + 0x10)
        self.sec = {n: (br.group(off + s) if s else []) for n, s in zip(names, secs)}
        self._bones()
        self._envelopes()
        self.vert_arrays = {}      # índice -> (nome, [pos])
        for vname, o in self.sec['verts']:
            idx, = u('>I', o + 0x10)
            self.vert_arrays[idx] = (vname, self._array(o, 'pos'))
        self.verts = {i: v[1] for i, v in self.vert_arrays.items()}
        self.nrms = self._by_index('nrm', lambda o: self._array(o, 'nrm'))
        self.clrs = self._by_index('clr', self._colors)
        self.uvs = self._by_index('uv', lambda o: self._array(o, 'uv'))
        self.draw = self._draw()

    # ------------------------------------------------------------------ esqueleto
    def _bones(self):
        u = self.br.u
        self.bones, by_off = [], {}
        for name, o in self.sec['bones']:
            index, mtx_id, flags, billboard = u('>IIII', o + 0x0C)
            s = u('>3f', o + 0x20)
            r = u('>3f', o + 0x2C)
            t = u('>3f', o + 0x38)
            parent_rel, = u('>i', o + 0x5C)
            m = u('>12f', o + 0x70)
            by_off[o] = len(self.bones)
            self.bones.append({
                'name': name, 'index': index, 'mtxId': mtx_id, 'flags': flags, 'billboard': billboard,
                'scale': list(s), 'rotate': list(r), 'translate': list(t),
                '_parent_abs': (o + parent_rel) if parent_rel else None,
                'world': [list(m[0:4]), list(m[4:8]), list(m[8:12])],
            })
        for b in self.bones:
            pa = b.pop('_parent_abs')
            b['parent'] = by_off.get(pa, -1) if pa is not None else -1
        self.bone_by_mtx = {b['mtxId']: i for i, b in enumerate(self.bones)}
        self.mtx_world = {b['mtxId']: b['world'] for b in self.bones}

    def _envelopes(self):
        """id de matriz -> [(índice do osso, peso)] para matrizes que misturam ossos."""
        d = self.br.d
        self.envelopes = {}
        for name, p in self.sec['defs']:
            if name != 'NodeMix':
                continue
            while p < len(d):
                op = d[p]
                if op == 0x03:
                    mid, n = struct.unpack_from('>HB', d, p + 1)
                    mix = []
                    for k in range(n):
                        node, w = struct.unpack_from('>Hf', d, p + 4 + k * 6)
                        bi = self.bone_by_mtx.get(node)
                        if bi is not None and w > 0:
                            mix.append((bi, w))
                    self.envelopes[mid] = mix
                    p += 4 + n * 6
                elif op == 0x05:
                    p += 5
                elif op == 0x00:
                    p += 1
                else:
                    break

    def influences(self, mtx_id):
        """id de matriz -> [(osso, peso)] normalizado (vazio se não for osso nem envelope)."""
        if mtx_id is None or mtx_id < 0:
            return []
        if mtx_id in self.bone_by_mtx:
            return [(self.bone_by_mtx[mtx_id], 1.0)]
        mix = self.envelopes.get(mtx_id, [])
        tot = sum(w for _, w in mix)
        return [(b, w / tot) for b, w in mix] if tot > 0 else []

    # ------------------------------------------------------------------ arrays
    def _by_index(self, sec, reader):
        out = {}
        for _, o in self.sec[sec]:
            idx, = self.br.u('>I', o + 0x10)
            out[idx] = reader(o)
        return out

    def _array(self, o, kind):
        u = self.br.u
        dat, = u('>i', o + 0x08)
        comp, fmt = u('>II', o + 0x14)
        div, stride, n = u('>BBH', o + 0x1C)
        if kind == 'pos':
            nc = 2 if comp == 0 else 3
        elif kind == 'nrm':
            nc = 3
            div = {1: 6, 3: 14}.get(fmt, div)
        else:
            nc = 1 if comp == 0 else 2
        c, size = FMT[fmt]
        esc = 1.0 / (1 << div) if fmt != 4 else 1.0
        base = o + dat
        if stride == 0:
            stride = nc * size
        out = []
        for i in range(n):
            v = [x * esc for x in struct.unpack_from('>' + c * nc, self.br.d, base + i * stride)]
            if kind == 'pos' and nc == 2:
                v.append(0.0)
            if kind == 'uv' and nc == 1:
                v.append(0.0)
            out.append(v)
        return out

    def _colors(self, o):
        u, d = self.br.u, self.br.d
        dat, = u('>i', o + 0x08)
        _, fmt = u('>II', o + 0x14)
        stride, _, n = u('>BBH', o + 0x1C)
        base, out = o + dat, []
        for i in range(n):
            p = base + i * stride
            if fmt == 0:
                c = gx.c565(struct.unpack_from('>H', d, p)[0])
            elif fmt in (1, 2):
                c = (d[p], d[p + 1], d[p + 2], 255)
            elif fmt == 3:
                v, = struct.unpack_from('>H', d, p)
                c = tuple(((v >> s) & 15) * 17 for s in (12, 8, 4, 0))
            elif fmt == 4:
                v = d[p] << 16 | d[p + 1] << 8 | d[p + 2]
                c = tuple((((v >> s) & 63) * 255 + 31) // 63 for s in (18, 12, 6, 0))
            else:
                c = (d[p], d[p + 1], d[p + 2], d[p + 3])
            out.append(c)
        return out

    def _draw(self):
        r = {}
        d = self.br.d
        for name, p in self.sec['defs']:
            if name not in ('DrawOpa', 'DrawXlu'):
                continue
            while p < len(d):
                op = d[p]
                if op == 0x04:
                    mat, obj, _ = struct.unpack_from('>HHH', d, p + 1)
                    r[obj] = (mat, name == 'DrawXlu')
                    p += 8
                elif op in (0x02, 0x05, 0x06):
                    p += 5
                elif op == 0x00:
                    p += 1
                else:
                    break
        return r

    # ------------------------------------------------------------------ objetos
    def _objects(self):
        u, d = self.br.u, self.br.d
        for oi, (name, o) in enumerate(self.sec['obj']):
            mtx_fixed, = u('>i', o + 0x08)
            vcd_lo, vcd_hi = u('>II', o + 0x0C)
            _, _, prim_off = u('>IIi', o + 0x24)
            prim_start = o + 0x24 + prim_off
            prim_size, = u('>I', o + 0x24)
            idx, = u('>I', o + 0x3C)
            ids = u('>hhhh8h', o + 0x48)
            v_id, n_id, c_id = ids[0], ids[1], ids[2]
            uv_ids = ids[4:]
            has_pnmtx = vcd_lo & 1
            tex_mtx = [(vcd_lo >> (1 + i)) & 1 for i in range(8)]
            m_pos, m_nrm, m_c0, m_c1 = ((vcd_lo >> 9) & 3, (vcd_lo >> 11) & 3, (vcd_lo >> 13) & 3, (vcd_lo >> 15) & 3)
            m_tex = [(vcd_hi >> (2 * i)) & 3 for i in range(8)]
            slots, tris = {}, []
            p, end = prim_start, prim_start + prim_size
            while p < end:
                op = d[p]
                p += 1
                if op == 0x00:
                    continue
                if op == 0x08:
                    p += 5
                    continue
                if op == 0x10:
                    n, = struct.unpack_from('>H', d, p)
                    p += 4 + (n + 1) * 4
                    continue
                if op in (0x20, 0x28, 0x30, 0x38):
                    val, = struct.unpack_from('>I', d, p)
                    p += 4
                    if op == 0x20:
                        slots[(val & 0xFFF) // 12] = val >> 16
                    continue
                kind = op & 0xF8
                if kind not in (0x80, 0x90, 0x98, 0xA0, 0xA8, 0xB0, 0xB8):
                    break
                n, = struct.unpack_from('>H', d, p)
                p += 2
                vs = []
                for _ in range(n):
                    pn = None
                    if has_pnmtx:
                        pn = d[p] // 3
                        p += 1
                    p += sum(tex_mtx)

                    def read(m):
                        nonlocal p
                        if m == 2:
                            v = d[p]
                            p += 1
                            return v
                        if m == 3:
                            v, = struct.unpack_from('>H', d, p)
                            p += 2
                            return v
                        if m == 1:
                            raise ValueError('atributo direto não suportado')
                        return None
                    ip, inn, ic0 = read(m_pos), read(m_nrm), read(m_c0)
                    read(m_c1)
                    its = [read(m) for m in m_tex]
                    mid = slots.get(pn, mtx_fixed) if pn is not None else mtx_fixed
                    vs.append((ip, inn, ic0, its[0], mid))
                if kind == 0x90:
                    tris += vs[:len(vs) // 3 * 3]
                elif kind == 0x98:
                    for i in range(n - 2):
                        a, b, c = (vs[i], vs[i + 1], vs[i + 2]) if i % 2 == 0 else (vs[i + 1], vs[i], vs[i + 2])
                        tris += [a, b, c]
                elif kind == 0xA0:
                    for i in range(1, n - 1):
                        tris += [vs[0], vs[i], vs[i + 1]]
                elif kind == 0x80:
                    for i in range(0, n - 3, 4):
                        q = vs[i:i + 4]
                        tris += [q[0], q[1], q[2], q[0], q[2], q[3]]
            yield {
                'name': name, 'index': idx if idx < 0xFFFF else oi, 'tris': tris, 'fixed': mtx_fixed,
                'pnmtx': bool(has_pnmtx), 'posId': v_id, 'pos': self.verts.get(v_id),
            }

    def meshes(self, scale=1.0):
        """Malhas na ordem do .glb: [{name, translucent, posId, vertices: [(ip, mtxId, pos_modelo)]}]."""
        out = []
        for ob in self._objects():
            if not ob['tris'] or ob['pos'] is None:
                continue
            uniq, verts = {}, []
            for key in ob['tris']:
                if key not in uniq:
                    uniq[key] = len(verts)
                    ip, mid = key[0], key[4]
                    m = self.mtx_world.get(mid) if (mid is not None and mid >= 0) else None
                    if ob['pnmtx'] and mid not in self.mtx_world:
                        m = None
                    pos = ob['pos'][ip]
                    verts.append((ip, mid, [x * scale for x in (mat_apply(m, pos) if m else pos)], m))
            mi, xlu = self.draw.get(ob['index'], (None, False))
            out.append({'name': ob['name'], 'translucent': xlu, 'posId': ob['posId'], 'fixed': ob['fixed'],
                        'pnmtx': ob['pnmtx'], 'vertices': verts})
        # sorted() é estável: mesma ordem do conversor original
        return sorted(out, key=lambda m: m['translucent'])
