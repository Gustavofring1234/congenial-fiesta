#!/usr/bin/env python3
"""Conversor BRRES (NW4R / Wii) -> GLB (glTF 2.0 binário). Só biblioteca padrão.

Converte modelos MDL0 (v8/v9) com geometria, normais, cores de vértice, UVs, materiais e
texturas TEX0 embutidas como PNG. Os vértices são exportados na pose de repouso, já
transformados para o espaço do modelo (sem esqueleto ou animação).

Uso:
  python3 scripts/brres2glb.py arquivo.brres [-o pasta_saida]
  python3 scripts/brres2glb.py pasta/ -o saida/        # converte todos os .brres (recursivo)
Opções: --escala F (padrão 1.0)  --sem-texturas  --unlit (ignora iluminação; bom para cenários
com luz pré-calculada nas cores de vértice)
"""
import argparse, json, math, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wii_texturas as wt  # noqa: E402


class Brres:
    def __init__(self, data):
        if data[:4] != b'bres':
            raise ValueError('não é um arquivo BRRES')
        self.d = data
        root = struct.unpack_from('>H', data, 12)[0]
        self.pastas = {n: self.grupo(o) for n, o in self.grupo(root + 8)}

    def u(self, fmt, off):
        return struct.unpack_from(fmt, self.d, off)

    def cstr(self, off):
        return self.d[off:self.d.index(b'\0', off)].decode('latin1')

    def grupo(self, off):
        """Index group (dicionário de nomes) do NW4R -> [(nome, offset absoluto)]."""
        _, n = self.u('>II', off)
        r = []
        for i in range(1, n + 1):
            e = off + 8 + i * 16
            _, _, _, _, no, do = self.u('>HHHHii', e)
            r.append((self.cstr(off + no), off + do))
        return r

    def itens(self, prefixo):
        for nome, itens in self.pastas.items():
            if nome.startswith(prefixo):
                yield from itens

    # ------------------------------------------------------------------ texturas
    def texturas(self):
        plts = {}
        for nome, o in self.itens('Palettes'):
            dat, = self.u('>I', o + 0x10)
            pfmt, n = self.u('>IH', o + 0x18)
            plts[nome] = wt.palette(self.d, o + dat, n, pfmt)
        tex = {}
        for nome, o in self.itens('Textures'):
            dat, = self.u('>I', o + 0x10)
            w, h, fmt = self.u('>HHI', o + 0x1C)
            if fmt in wt.BLOCK and 0 < w <= 2048 and 0 < h <= 2048:
                tex[nome] = (w, h, fmt, o + dat, plts.get(nome))
        return tex

    def decodificar(self, info):
        w, h, fmt, off, pal = info
        rgba = wt.decode(self.d, off, w, h, fmt, pal)
        return w, h, rgba


# ---------------------------------------------------------------------- MDL0
FMT = {0: ('B', 1), 1: ('b', 1), 2: ('H', 2), 3: ('h', 2), 4: ('f', 4)}


def mat_aplicar(m, p):
    return [m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3] for r in range(3)]


def mat_rotacionar(m, n):
    v = [m[r][0] * n[0] + m[r][1] * n[1] + m[r][2] * n[2] for r in range(3)]
    s = math.sqrt(sum(x * x for x in v))
    if s < 1e-6:
        return [0.0, 0.0, 1.0]  # normal nula no arquivo original
    return [x / s for x in v]


IDENT = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]


class Mdl0:
    SECOES = {8: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'mat', 'shd', 'obj', 'tex', 'plt'],
              9: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'mat', 'shd', 'obj', 'tex', 'plt'],
              10: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'furv', 'furl', 'mat', 'shd', 'obj', 'tex', 'plt', 'x'],
              11: ['defs', 'bones', 'verts', 'nrm', 'clr', 'uv', 'furv', 'furl', 'mat', 'shd', 'obj', 'tex', 'plt', 'x']}

    def __init__(self, br, nome, off):
        self.br, self.nome, self.o = br, nome, off
        u = br.u
        self.versao, = u('>I', off + 8)
        if self.versao not in self.SECOES:
            raise ValueError(f'MDL0 versão {self.versao} não suportada')
        nomes = self.SECOES[self.versao]
        secs = u('>%di' % len(nomes), off + 0x10)
        self.sec = {n: (br.grupo(off + s) if s else []) for n, s in zip(nomes, secs)}
        self._ossos()
        self.verts = {i: self._array(o, 'pos') for i, (_, o) in enumerate(self.sec['verts'])}
        self.nrms = {i: self._array(o, 'nrm') for i, (_, o) in enumerate(self.sec['nrm'])}
        self.clrs = {i: self._cores(o) for i, (_, o) in enumerate(self.sec['clr'])}
        self.uvs = {i: self._array(o, 'uv') for i, (_, o) in enumerate(self.sec['uv'])}
        self._indices_por_id()
        self.materiais = [self._material(n, o) for n, o in self.sec['mat']]
        self.desenho = self._desenho()

    def _indices_por_id(self):
        # arrays são referenciados pelo campo "index" do cabeçalho, não pela ordem no grupo
        for attr, sec in (('verts', 'verts'), ('nrms', 'nrm'), ('clrs', 'clr'), ('uvs', 'uv')):
            m = {}
            for pos, (_, o) in enumerate(self.sec[sec]):
                idx, = self.br.u('>I', o + 0x10)
                m[idx] = getattr(self, attr)[pos]
            setattr(self, attr, m)

    def _ossos(self):
        u = self.br.u
        self.mtx_osso = {}   # id de matriz -> matriz mundo 3x4
        self.ossos = []
        for nome, o in self.sec['bones']:
            _, mtx_id = u('>II', o + 0x0C)
            m = u('>12f', o + 0x70)
            mw = [list(m[0:4]), list(m[4:8]), list(m[8:12])]
            self.mtx_osso[mtx_id] = mw
            self.ossos.append(nome)

    def _array(self, o, tipo):
        u = self.br.u
        dat, = u('>i', o + 0x08)
        comp, fmt = u('>II', o + 0x14)
        div, passo, n = u('>BBH', o + 0x1C)
        if tipo == 'pos':
            nc = 2 if comp == 0 else 3
        elif tipo == 'nrm':
            nc = 3
            div = {1: 6, 3: 14}.get(fmt, div)  # normais inteiras usam ponto fixo fixo
        else:
            nc = 1 if comp == 0 else 2
        c, tam = FMT[fmt]
        esc = 1.0 / (1 << div) if fmt != 4 else 1.0
        base = o + dat
        if passo == 0:
            passo = nc * tam
        out = []
        for i in range(n):
            v = [x * esc for x in struct.unpack_from('>' + c * nc, self.br.d, base + i * passo)]
            if tipo == 'pos' and nc == 2:
                v.append(0.0)
            if tipo == 'uv' and nc == 1:
                v.append(0.0)
            out.append(v)
        return out

    def _cores(self, o):
        u, d = self.br.u, self.br.d
        dat, = u('>i', o + 0x08)
        _, fmt = u('>II', o + 0x14)
        passo, _, n = u('>BBH', o + 0x1C)
        base, out = o + dat, []
        for i in range(n):
            p = base + i * passo
            if fmt == 0:
                c = wt.c565(struct.unpack_from('>H', d, p)[0])
            elif fmt == 1:
                c = (d[p], d[p + 1], d[p + 2], 255)
            elif fmt == 2:
                c = (d[p], d[p + 1], d[p + 2], 255)
            elif fmt == 3:
                v, = struct.unpack_from('>H', d, p)
                c = tuple(((v >> s) & 15) * 17 for s in (12, 8, 4, 0))
            elif fmt == 4:
                v = d[p] << 16 | d[p + 1] << 8 | d[p + 2]
                c = tuple((((v >> s) & 63) * 255 + 31) // 63 for s in (18, 12, 6, 0))
            else:
                c = (d[p], d[p + 1], d[p + 2], d[p + 3])
            out.append([x / 255.0 for x in c])
        return out

    def _material(self, nome, o):
        u = self.br.u
        cull, = u('>I', o + 0x18)
        ncam, ocam = u('>Ii', o + 0x2C)
        camadas = []
        for i in range(ncam):
            c = o + ocam + i * 0x34
            no, = u('>i', c)
            ws, wt_ = u('>II', c + 0x18)
            camadas.append({'tex': self.br.cstr(c + no) if no else None, 'wrap': (ws, wt_)})
        return {'nome': nome, 'cull': cull, 'camadas': camadas}

    def _desenho(self):
        """Lê DrawOpa/DrawXlu: objeto -> (material, translúcido)."""
        r = {}
        for nome, o in self.sec['defs']:
            if nome not in ('DrawOpa', 'DrawXlu'):
                continue
            d, p = self.br.d, o
            while p < len(d):
                op = d[p]
                if op == 0x04:
                    mat, obj, _ = struct.unpack_from('>HHH', d, p + 1)
                    r[obj] = (mat, nome == 'DrawXlu')
                    p += 8
                elif op in (0x02, 0x05, 0x06):
                    p += 5
                elif op == 0x00:
                    p += 1
                else:
                    break
        return r

    # ------------------------------------------------------------- objetos
    def objetos(self):
        u, d = self.br.u, self.br.d
        for oi, (nome, o) in enumerate(self.sec['obj']):
            mtx_fixa, = u('>i', o + 0x08)
            vcd_lo, vcd_hi = u('>II', o + 0x0C)
            _, _, prim_off = u('>IIi', o + 0x24)
            prim_ini = o + 0x24 + prim_off  # relativo ao início do bloco de primitivos
            prim_tam, = u('>I', o + 0x24)
            idx, = u('>I', o + 0x3C)
            ids = u('>hhhh8h', o + 0x48)
            v_id, n_id, c_id = ids[0], ids[1], ids[2]
            uv_ids = ids[4:]

            def modo(bitpos, palavra):
                return (palavra >> bitpos) & 3

            tem_pnmtx = vcd_lo & 1
            tex_mtx = [(vcd_lo >> (1 + i)) & 1 for i in range(8)]
            m_pos, m_nrm, m_c0, m_c1 = (modo(9, vcd_lo), modo(11, vcd_lo), modo(13, vcd_lo), modo(15, vcd_lo))
            m_tex = [modo(2 * i, vcd_hi) for i in range(8)]

            slots = {}
            tris = []    # lista de vértices (pos, nrm, cor, uv0, mtx_id)
            p, fim = prim_ini, prim_ini + prim_tam
            while p < fim:
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
                tipo = op & 0xF8
                if tipo not in (0x80, 0x90, 0x98, 0xA0, 0xA8, 0xB0, 0xB8):
                    break  # fim do display list (padding)
                n, = struct.unpack_from('>H', d, p)
                p += 2
                vs = []
                for _ in range(n):
                    pn = None
                    if tem_pnmtx:
                        pn = d[p] // 3
                        p += 1
                    p += sum(tex_mtx)

                    def ler(m):
                        nonlocal p
                        if m == 2:
                            v = d[p]; p += 1; return v
                        if m == 3:
                            v, = struct.unpack_from('>H', d, p); p += 2; return v
                        if m == 1:
                            raise ValueError('atributo direto não suportado')
                        return None
                    ip, inn, ic0 = ler(m_pos), ler(m_nrm), ler(m_c0)
                    ler(m_c1)
                    its = [ler(m) for m in m_tex]
                    mid = slots.get(pn, mtx_fixa) if pn is not None else mtx_fixa
                    vs.append((ip, inn, ic0, its[0], mid))
                if tipo == 0x90:
                    tris += vs[:len(vs) // 3 * 3]
                elif tipo == 0x98:
                    for i in range(n - 2):
                        a, b, c = (vs[i], vs[i + 1], vs[i + 2]) if i % 2 == 0 else (vs[i + 1], vs[i], vs[i + 2])
                        tris += [a, b, c]
                elif tipo == 0xA0:
                    for i in range(1, n - 1):
                        tris += [vs[0], vs[i], vs[i + 1]]
                elif tipo == 0x80:
                    for i in range(0, n - 3, 4):
                        q = vs[i:i + 4]
                        tris += [q[0], q[1], q[2], q[0], q[2], q[3]]
                # linhas e pontos são ignorados
            yield {
                'nome': nome, 'indice': idx if idx < 0xFFFF else oi, 'tris': tris, 'unico': mtx_fixa,
                'pnmtx': bool(tem_pnmtx),
                'pos': self.verts.get(v_id), 'nrm': self.nrms.get(n_id) if n_id >= 0 else None,
                'clr': self.clrs.get(c_id) if c_id >= 0 else None,
                'uv': self.uvs.get(uv_ids[0]) if uv_ids[0] >= 0 else None,
            }


# ---------------------------------------------------------------------- glTF
class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.j = {'asset': {'version': '2.0', 'generator': 'linuxsports brres2glb'},
                  'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [],
                  'materials': [], 'accessors': [], 'bufferViews': [], 'buffers': [],
                  'textures': [], 'images': [], 'samplers': []}
        self.amostradores = {}

    def view(self, dados, alvo=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        bv = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(dados)}
        if alvo:
            bv['target'] = alvo
        self.bin += dados
        self.j['bufferViews'].append(bv)
        return len(self.j['bufferViews']) - 1

    def accessor(self, valores, tipo, n_comp, minmax=False):
        dados = struct.pack('<%df' % (len(valores) * n_comp), *[x for v in valores for x in v])
        a = {'bufferView': self.view(dados, 34962), 'componentType': 5126,
             'count': len(valores), 'type': tipo}
        if minmax:
            a['min'] = [min(v[i] for v in valores) for i in range(n_comp)]
            a['max'] = [max(v[i] for v in valores) for i in range(n_comp)]
        self.j['accessors'].append(a)
        return len(self.j['accessors']) - 1

    def indices(self, idx):
        dados = struct.pack('<%dI' % len(idx), *idx)
        self.j['accessors'].append({'bufferView': self.view(dados, 34963), 'componentType': 5125,
                                    'count': len(idx), 'type': 'SCALAR'})
        return len(self.j['accessors']) - 1

    def imagem(self, nome, png):
        self.j['images'].append({'name': nome, 'mimeType': 'image/png', 'bufferView': self.view(png)})
        return len(self.j['images']) - 1

    def amostrador(self, wrap):
        gl = {0: 33071, 1: 10497, 2: 33648}
        chave = (gl.get(wrap[0], 10497), gl.get(wrap[1], 10497))
        if chave not in self.amostradores:
            self.j['samplers'].append({'wrapS': chave[0], 'wrapT': chave[1],
                                       'magFilter': 9729, 'minFilter': 9987})
            self.amostradores[chave] = len(self.j['samplers']) - 1
        return self.amostradores[chave]

    def salvar(self, caminho):
        for k in [k for k, v in self.j.items() if v == []]:
            del self.j[k]
        while len(self.bin) % 4:
            self.bin.append(0)
        self.j['buffers'] = [{'byteLength': len(self.bin)}]
        js = json.dumps(self.j, separators=(',', ':')).encode()
        js += b' ' * (-len(js) % 4)
        with open(caminho, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin)))
            f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942) + bytes(self.bin))


def carregar_texturas_vizinhas(caminho):
    """Texturas de outros .brres na mesma pasta (modelos às vezes usam texturas compartilhadas)."""
    r = {}
    pasta = os.path.dirname(os.path.abspath(caminho))
    for n in sorted(os.listdir(pasta)):
        if n.endswith('.brres') and os.path.join(pasta, n) != os.path.abspath(caminho):
            try:
                br = Brres(open(os.path.join(pasta, n), 'rb').read())
                for nome, info in br.texturas().items():
                    r.setdefault(nome, (br, info))
            except Exception:
                pass
    return r


def converter_modelo(br, mdl, saida, args, texs_locais, vizinhas):
    g = Glb()
    cache_img, cache_mat, cache_tex, avisos = {}, {}, {}, set()

    def textura(nome, wrap):
        if nome not in cache_img:
            fonte = (br, texs_locais[nome]) if nome in texs_locais else vizinhas().get(nome)
            if not fonte:
                avisos.add(f'textura ausente: {nome}')
                cache_img[nome] = None
            else:
                w, h, rgba = fonte[0].decodificar(fonte[1])
                alfa = any(rgba[i] < 250 for i in range(3, len(rgba), 4))
                cache_img[nome] = (g.imagem(nome, wt.png_bytes(w, h, rgba)), alfa)
        img = cache_img[nome]
        if img is None:
            return None, False
        chave_tex = (img[0], g.amostrador(wrap))
        if chave_tex not in cache_tex:
            g.j['textures'].append({'source': chave_tex[0], 'sampler': chave_tex[1]})
            cache_tex[chave_tex] = len(g.j['textures']) - 1
        return cache_tex[chave_tex], img[1]

    def material(mi, xlu, tem_uv):
        chave = (mi, xlu, tem_uv)
        if chave in cache_mat:
            return cache_mat[chave]
        m = mdl.materiais[mi] if mi is not None and mi < len(mdl.materiais) else None
        gm = {'name': m['nome'] if m else 'padrao',
              'pbrMetallicRoughness': {'metallicFactor': 0.0, 'roughnessFactor': 1.0}}
        if args.unlit:
            gm.setdefault('extensions', {})['KHR_materials_unlit'] = {}
        if m:
            if m['cull'] == 0:
                gm['doubleSided'] = True
            # sem UV (ex.: textura de reflexo gerada pela normal) não dá para mapear a textura
            if m['camadas'] and m['camadas'][0]['tex'] and tem_uv and not args.sem_texturas:
                ti, alfa = textura(m['camadas'][0]['tex'], m['camadas'][0]['wrap'])
                if ti is not None:
                    gm['pbrMetallicRoughness']['baseColorTexture'] = {'index': ti}
                    if xlu:
                        gm['alphaMode'] = 'BLEND'
                    elif alfa:
                        gm['alphaMode'], gm['alphaCutoff'] = 'MASK', 0.5
        g.j['materials'].append(gm)
        cache_mat[chave] = len(g.j['materials']) - 1
        return cache_mat[chave]

    prims = []
    for ob in mdl.objetos():
        if not ob['tris'] or ob['pos'] is None:
            continue
        uniq = {}
        P, N, C, T, idx = [], [], [], [], []
        for (ip, inn, ic, it, mid) in ob['tris']:
            chave = (ip, inn, ic, it, mid)
            if chave not in uniq:
                uniq[chave] = len(P)
                pos = ob['pos'][ip]
                # vértice ligado a um único osso: guardado no espaço local do osso
                m = mdl.mtx_osso.get(mid) if (mid is not None and mid >= 0) else None
                if ob['pnmtx'] and mid not in mdl.mtx_osso:
                    m = None  # envelope (vários ossos): já está no espaço do modelo
                P.append([x * args.escala for x in (mat_aplicar(m, pos) if m else pos)])
                if ob['nrm'] is not None and inn is not None:
                    nv = ob['nrm'][inn]
                    N.append(mat_rotacionar(m, nv) if m else mat_rotacionar(IDENT, nv))
                if ob['clr'] is not None and ic is not None:
                    C.append(ob['clr'][ic])
                if ob['uv'] is not None and it is not None:
                    T.append(ob['uv'][it][:2])
            idx.append(uniq[chave])
        attrs = {'POSITION': g.accessor(P, 'VEC3', 3, minmax=True)}
        if len(N) == len(P):
            attrs['NORMAL'] = g.accessor(N, 'VEC3', 3)
        if len(C) == len(P):
            attrs['COLOR_0'] = g.accessor(C, 'VEC4', 4)
        if len(T) == len(P):
            attrs['TEXCOORD_0'] = g.accessor(T, 'VEC2', 2)
        # GX usa sentido horário como frente; glTF usa anti-horário -> inverter
        idx = [v for i in range(0, len(idx), 3) for v in (idx[i], idx[i + 2], idx[i + 1])]
        mi, xlu = mdl.desenho.get(ob['indice'], (None, False))
        prims.append((ob['nome'], {'attributes': attrs, 'indices': g.indices(idx),
                                   'material': material(mi, xlu, 'TEXCOORD_0' in attrs)}, xlu))

    if not prims:
        return None, avisos
    # opacos antes dos translúcidos
    for nome, prim, _ in sorted(prims, key=lambda t: t[2]):
        g.j['meshes'].append({'name': nome, 'primitives': [prim]})
        g.j['nodes'].append({'name': nome, 'mesh': len(g.j['meshes']) - 1})
        g.j['scenes'][0]['nodes'].append(len(g.j['nodes']) - 1)
    if args.unlit:
        g.j['extensionsUsed'] = ['KHR_materials_unlit']
    g.salvar(saida)
    return len(prims), avisos


def converter_arquivo(caminho, pasta_saida, args):
    br = Brres(open(caminho, 'rb').read())
    texs = br.texturas()
    cache = {}

    def vizinhas():
        if 'v' not in cache:
            cache['v'] = carregar_texturas_vizinhas(caminho)
        return cache['v']

    base = os.path.splitext(os.path.basename(caminho))[0]
    modelos = list(br.itens('3DModels'))
    resultados = []
    for nome, off in modelos:
        nome_saida = base if len(modelos) == 1 and nome == base else f'{base}__{nome}'
        saida = os.path.join(pasta_saida, nome_saida + '.glb')
        try:
            mdl = Mdl0(br, nome, off)
            n, avisos = converter_modelo(br, mdl, saida, args, texs, vizinhas)
            resultados.append((saida, n, sorted(avisos)))
        except Exception as e:  # um modelo ruim não interrompe o lote
            resultados.append((saida, None, [f'erro: {e}']))
    return resultados


def main():
    ap = argparse.ArgumentParser(description='Converte .brres (Wii) em .glb')
    ap.add_argument('entrada', help='arquivo .brres ou pasta')
    ap.add_argument('-o', '--saida', default='glb_saida')
    ap.add_argument('--escala', type=float, default=1.0)
    ap.add_argument('--sem-texturas', action='store_true')
    ap.add_argument('--unlit', action='store_true')
    a = ap.parse_args()
    if os.path.isdir(a.entrada):
        arquivos = sorted(os.path.join(r, n) for r, _, ns in os.walk(a.entrada) for n in ns if n.endswith('.brres'))
    else:
        arquivos = [a.entrada]
    ok = falhas = vazios = 0
    for arq in arquivos:
        rel = os.path.relpath(os.path.dirname(arq), a.entrada) if os.path.isdir(a.entrada) else '.'
        destino = os.path.normpath(os.path.join(a.saida, rel))
        os.makedirs(destino, exist_ok=True)
        try:
            res = converter_arquivo(arq, destino, a)
        except Exception as e:
            print(f'ERRO {arq}: {e}')
            falhas += 1
            continue
        for saida, n, avisos in res:
            if n is None and avisos and avisos[0].startswith('erro'):
                falhas += 1
                print(f'ERRO {saida}: {avisos[0]}')
            elif n is None:
                vazios += 1
            else:
                ok += 1
                print(f'ok   {saida} ({n} malhas)' + (f'  [{"; ".join(avisos)}]' if avisos else ''))
    print(f'\n{ok} GLB gerados, {vazios} modelos sem geometria, {falhas} falhas')


if __name__ == '__main__':
    main()
