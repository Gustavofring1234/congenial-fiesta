#!/usr/bin/env python3
"""Etapa 2.1: retargeting das animações CHR0 dos avatares (corpos Mii ava_body*) para VRM -> .vrma.

Entrada : minigames/sports/assets/animations_manifest.json + Animations/**.chr0.json + sidecars dos corpos
          (tools/export_animations.py e export_models.py, NW4R_TARGET=web)
Saída   : minigames/sports/assets/Vrma/<nome>.vrma   (glTF binário com VRMC_vrm_animation 1.0)
          minigames/sports/assets/Vrma/vrma_manifest.json
          index/vrma-export.json
O WEBC já importa .vrma (estúdio de movimentos, three-vrm); minigames/sports/engine/animation/VrmaPlayer.js
toca os mesmos arquivos no avatar ativo do jogador (VRM 0.x e 1.0).

Método (referencial do Wii = do glTF, destro, Y para cima):
 1. Cinemática direta do esqueleto Mii em cada quadro (SRT local; R = Rz·Ry·Rx; componente sem trilha = repouso
    do sidecar, salvo flags scaleOne/rotTransZero/identity), com matrizes completas e segment scale compensate
    (flag 0x20 do MDL0: os braços esticados do boxe não entortam o antebraço).
 2. Base do personagem G a partir da pose de repouso: esquerda = ombro_l - ombro_r, cima = cabeça - quadril,
    frente = esquerda × cima. G leva essa base a (+X, +Y, +Z): o VRM 1.0 normalizado olha para +Z com a
    esquerda em +X.
 3. Para cada osso humanoide b: D_b = G·W_b(f)·(G·W_b(repouso))⁻¹ (quanto o osso girou no mundo desde o repouso).
    C_b = menor rotação que leva a direção do osso na pose T do VRM até a direção do osso Mii em repouso
    (ossos de ponta herdam o C do pai). Rotação de mundo no VRM: D_b·C_b; local = (mundo do pai)⁻¹·mundo.
    No .vrma todos os nós têm rotação de repouso identidade, então a trilha local já é a rotação normalizada
    que o three-vrm espera (VRMAnimationLoaderPlugin + createVRMAnimationClip).
 4. Quadril: posição de mundo do skl_root (em G, unidades/10 = metros); o three-vrm reescala pela altura do
    quadril do avatar.
 5. Família A0 (Mii sem braços: só hand_l/hand_r flutuando): o esqueleto de destino é o do corpo A1 e os braços
    saem de um IK de dois ossos até as mãos (cotovelo para baixo e para trás), com as mãos reescaladas pela
    razão das alturas de quadril A1/A0.
Mão de luva (finger_*1/2) vai para os quatro dedos; thumb_*1/2 para o polegar.

Uso: python3 tools/export_vrma.py [--only PADRAO] [--fps 60]
"""
import argparse
import json
import math
import os
import re
import struct
import sys
from pathlib import Path

os.environ.setdefault('NW4R_TARGET', 'web')
sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r.paths import ASSETS, INDEX, TARGET, write_bytes, write_json  # noqa: E402

OUT = ASSETS / 'Vrma'
UNIT = 0.1  # 10 unidades do jogo = 1 m

# ------------------------------------------------------------------ quaternions (x, y, z, w)
def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


def qinv(q):
    return (-q[0], -q[1], -q[2], q[3])


def qnorm(q):
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return tuple(c / n for c in q)


def qrot(q, v):
    x, y, z, w = q
    tx, ty, tz = 2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])
    return (v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx))


def qaxis(axis, deg):
    h = math.radians(deg) / 2
    s = math.sin(h)
    return (axis[0] * s, axis[1] * s, axis[2] * s, math.cos(h))


def qeuler_zyx(rx, ry, rz):
    """R = Rz·Ry·Rx (graus): aplica X, depois Y, depois Z."""
    return qmul(qaxis((0, 0, 1), rz), qmul(qaxis((0, 1, 0), ry), qaxis((1, 0, 0), rx)))


def vsub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def vadd(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def vscale(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def vdot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def vcross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def vlen(a):
    return math.sqrt(vdot(a, a))


def vnorm(a):
    n = vlen(a) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def q_from_unit_vectors(a, b):
    a, b = vnorm(a), vnorm(b)
    d = vdot(a, b)
    if d < -0.999999:
        ax = vcross((1, 0, 0), a)
        if vlen(ax) < 1e-6:
            ax = vcross((0, 1, 0), a)
        ax = vnorm(ax)
        return (ax[0], ax[1], ax[2], 0.0)
    c = vcross(a, b)
    return qnorm((c[0], c[1], c[2], 1 + d))


SSC_APPLY = 0x20


def mat_from_q(q):
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def mat_mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)] for r in range(3)]


def mat_vec(m, v):
    return (m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2])


def q_from_basis(x, y, z):
    """Quaternion da matriz com colunas x, y, z."""
    m00, m01, m02 = x[0], y[0], z[0]
    m10, m11, m12 = x[1], y[1], z[1]
    m20, m21, m22 = x[2], y[2], z[2]
    tr = m00 + m11 + m22
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        return qnorm(((m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s))
    if m00 > m11 and m00 > m22:
        s = math.sqrt(1.0 + m00 - m11 - m22) * 2
        return qnorm((0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s))
    if m11 > m22:
        s = math.sqrt(1.0 + m11 - m00 - m22) * 2
        return qnorm(((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s))
    s = math.sqrt(1.0 + m22 - m00 - m11) * 2
    return qnorm(((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s))


# ------------------------------------------------------------------ curvas (iguais a Nw4rCurves.js)
def sample(c, f):
    if c is None:
        return None
    t = c['type']
    if t == 'const':
        return c['value']
    if t == 'linear':
        v = c['values']
        if f <= 0:
            return v[0]
        if f >= len(v) - 1:
            return v[-1]
        i = int(f)
        return v[i] + (v[i + 1] - v[i]) * (f - i)
    k = c['keys']
    if f <= k[0][0]:
        return k[0][1]
    if f >= k[-1][0]:
        return k[-1][1]
    lo, hi = 0, len(k) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if k[mid][0] <= f:
            lo = mid
        else:
            hi = mid
    f0, v0, t0 = k[lo]
    f1, v1, t1 = k[hi]
    dt = f1 - f0
    if dt <= 0:
        return v1
    s = (f - f0) / dt
    s2, s3 = s * s, s * s * s
    return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * dt * t0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * dt * t1


# ------------------------------------------------------------------ esqueleto Mii
class Skeleton:
    def __init__(self, sidecar):
        self.bones = sidecar['bones']
        self.index = {b['name']: i for i, b in enumerate(self.bones)}
        self.children = {i: [] for i in range(len(self.bones))}
        for i, b in enumerate(self.bones):
            if b['parent'] >= 0:
                self.children[b['parent']].append(i)

    def local(self, i, track, f):
        b = self.bones[i]
        s, r, t = b['scale'], b['rotate'], b['translate']
        if track is not None:
            fl = track.get('flags') or {}
            if track.get('identity'):
                s, r, t = [1, 1, 1], [0, 0, 0], [0, 0, 0]
            else:
                if track.get('scale'):
                    s = [sample(c, f) if c else s[k] for k, c in enumerate(track['scale'])]
                elif fl.get('scaleOne'):
                    s = [1, 1, 1]
                if track.get('rotate'):
                    r = [sample(c, f) if c else r[k] for k, c in enumerate(track['rotate'])]
                elif fl.get('rotTransZero'):
                    r = [0, 0, 0]
                if track.get('translate'):
                    t = [sample(c, f) if c else t[k] for k, c in enumerate(track['translate'])]
                elif fl.get('rotTransZero'):
                    t = [0, 0, 0]
        return tuple(s), qeuler_zyx(*r), tuple(t)

    def world(self, tracks, f):
        """{i: (pos, rot, scale)} em todos os ossos, com matrizes completas como o three.js (ModelLoader.js):
        M = M_pai · T · R · S, ou M = M_pai · T · S_pai⁻¹ · R · S com segment scale compensate (flag 0x20).
        rot = rotação de mundo (colunas da parte linear normalizadas)."""
        out, lin, loc_s = {}, {}, {}
        for i, b in enumerate(self.bones):
            s, q, t = self.local(i, tracks.get(b['name']), f)
            loc_s[i] = s
            R = mat_from_q(q)
            L = [[R[r][c] * s[c] for c in range(3)] for r in range(3)]
            p = b['parent']
            if p < 0:
                lin[i], pos = L, t
            else:
                if (b.get('flags', 0) & SSC_APPLY):
                    ps = loc_s[p]
                    L = [[L[r][c] / (ps[r] or 1e-6) for c in range(3)] for r in range(3)]
                lin[i] = mat_mul(lin[p], L)
                pos = vadd(out[p][0], mat_vec(lin[p], t))
            cols = [vnorm((lin[i][0][c], lin[i][1][c], lin[i][2][c])) for c in range(3)]
            out[i] = (pos, q_from_basis(*cols), tuple(vlen((lin[i][0][c], lin[i][1][c], lin[i][2][c])) for c in range(3)))
        return out

    def pos(self, w, name):
        return w[self.index[name]][0]


# ------------------------------------------------------------------ mapa humanoide
FINGERS = ('Index', 'Middle', 'Ring', 'Little')
MAP = {  # osso Mii -> ossos VRM
    'skl_root': ['hips'], 'chest': ['spine'], 'chest1': ['spine'], 'chest2': ['chest'], 'head': ['head'],
    'hip': [],
}
for side, S in (('l', 'left'), ('r', 'right')):
    MAP.update({
        f'clavicle_{side}': [f'{S}Shoulder'], f'arm_{side}1': [f'{S}UpperArm'], f'arm_{side}2': [f'{S}LowerArm'],
        f'wrist_{side}': [f'{S}Hand'], f'leg_{side}1': [f'{S}UpperLeg'], f'leg_{side}2': [f'{S}LowerLeg'],
        f'ankle_{side}': [f'{S}Foot'], f'thumb_{side}1': [f'{S}ThumbMetacarpal'], f'thumb_{side}2': [f'{S}ThumbProximal'],
        f'finger_{side}1': [f'{S}{n}Proximal' for n in FINGERS], f'finger_{side}2': [f'{S}{n}Intermediate' for n in FINGERS],
    })

# filho usado para a direção do osso (None = ponta: herda a correção do pai)
CHILD = {'skl_root': ('chest2', 'chest1', 'chest'), 'chest': ('head',), 'chest1': ('chest2', 'head'), 'chest2': ('head',),
         'head': None}
for side in 'lr':
    CHILD.update({f'clavicle_{side}': (f'arm_{side}1',), f'arm_{side}1': (f'arm_{side}2',), f'arm_{side}2': (f'wrist_{side}',),
                  f'wrist_{side}': (f'finger_{side}1',), f'finger_{side}1': (f'finger_{side}2',), f'finger_{side}2': None,
                  f'thumb_{side}1': (f'thumb_{side}2',), f'thumb_{side}2': None,
                  f'leg_{side}1': (f'leg_{side}2',), f'leg_{side}2': (f'ankle_{side}',), f'ankle_{side}': None})

# hierarquia VRM (pai) e direção do osso na pose T do VRM 1.0 normalizado (+Z frente, +X esquerda)
VRM_PARENT = {'hips': None, 'spine': 'hips', 'chest': 'spine', 'upperChest': 'chest', 'neck': 'upperChest', 'head': 'neck'}
VRM_DIR = {'hips': (0, 1, 0), 'spine': (0, 1, 0), 'chest': (0, 1, 0), 'head': (0, 1, 0)}
for S, sx in (('left', 1), ('right', -1)):
    VRM_PARENT.update({f'{S}Shoulder': 'upperChest', f'{S}UpperArm': f'{S}Shoulder', f'{S}LowerArm': f'{S}UpperArm',
                       f'{S}Hand': f'{S}LowerArm', f'{S}ThumbMetacarpal': f'{S}Hand', f'{S}ThumbProximal': f'{S}ThumbMetacarpal',
                       f'{S}UpperLeg': 'hips', f'{S}LowerLeg': f'{S}UpperLeg', f'{S}Foot': f'{S}LowerLeg'})
    for n in FINGERS:
        VRM_PARENT[f'{S}{n}Proximal'] = f'{S}Hand'
        VRM_PARENT[f'{S}{n}Intermediate'] = f'{S}{n}Proximal'
        VRM_DIR[f'{S}{n}Proximal'] = VRM_DIR[f'{S}{n}Intermediate'] = (sx, 0, 0)
    for b in ('Shoulder', 'UpperArm', 'LowerArm', 'Hand'):
        VRM_DIR[f'{S}{b}'] = (sx, 0, 0)
    VRM_DIR[f'{S}ThumbMetacarpal'] = VRM_DIR[f'{S}ThumbProximal'] = vnorm((sx, 0, 1))
    VRM_DIR[f'{S}UpperLeg'] = VRM_DIR[f'{S}LowerLeg'] = (0, -1, 0)
    VRM_DIR[f'{S}Foot'] = vnorm((0, -0.4, 1))


def mapped_parent(vrm_bone, present):
    p = VRM_PARENT.get(vrm_bone)
    while p is not None and p not in present:
        p = VRM_PARENT.get(p)
    return p


# ------------------------------------------------------------------ retargeting
class Retargeter:
    def __init__(self, sk, rest_world):
        self.sk = sk
        self.rest = rest_world
        P = lambda n: sk.pos(rest_world, n)  # noqa: E731
        left = vsub(P('arm_l1'), P('arm_r1'))
        up = vsub(P('head'), P('skl_root'))
        left = vnorm(left)
        up = vnorm(vsub(up, vscale(left, vdot(up, left))))
        fwd = vcross(left, up)
        # G leva (left, up, fwd) a (X, Y, Z): é a inversa da rotação de colunas (left, up, fwd)
        self.G = qinv(q_from_basis(left, up, fwd))
        self.forward_wii = fwd
        self.src_bones = [n for n in MAP if n in sk.index and MAP[n]]
        self.vrm_bones = [v for n in self.src_bones for v in MAP[n]]
        self.src_of = {v: n for n in self.src_bones for v in MAP[n]}
        # correção de pose de repouso por osso VRM
        self.C = {}
        self.child_of = {}
        self.rest_dir_g = {}
        for n in self.src_bones:
            kids = CHILD.get(n)
            child = next((c for c in (kids or ()) if c in sk.index), None)
            for v in MAP[n]:
                if child is None:
                    continue
                d_src = qrot(self.G, vsub(P(child), P(n)))
                if vlen(d_src) < 1e-5:
                    continue
                self.child_of[n] = child
                self.rest_dir_g[n] = d_src
                self.C[v] = q_from_unit_vectors(VRM_DIR[v], d_src)
        for v in self.vrm_bones:  # pontas herdam do pai VRM
            if v not in self.C:
                p = mapped_parent(v, self.C)
                self.C[v] = self.C.get(p, (0, 0, 0, 1)) if p else (0, 0, 0, 1)
        self.rest_rot_g = {n: qmul(self.G, rest_world[sk.index[n]][1]) for n in self.src_bones}
        self.hips_rest = vscale(qrot(self.G, P('skl_root')), UNIT)

    def frame(self, w):
        """Rotações locais {osso VRM: q} e posição do quadril (m) para um quadro de mundo w."""
        world_t = {}
        for n in self.src_bones:
            wg = qmul(self.G, w[self.sk.index[n]][1])
            D = qmul(wg, qinv(self.rest_rot_g[n]))
            c = self.child_of.get(n)
            if c is not None:
                # osso esticado (translação/escala do filho animadas, ex.: soco do boxe): a rotação sozinha não leva
                # o osso até o filho; um giro mínimo extra alinha a direção prevista à real (identidade sem esticar)
                cur = qrot(self.G, vsub(self.sk.pos(w, c), self.sk.pos(w, n)))
                if vlen(cur) > 1e-6:
                    D = qmul(q_from_unit_vectors(qrot(D, self.rest_dir_g[n]), cur), D)
            for v in MAP[n]:
                world_t[v] = qnorm(qmul(D, self.C[v]))
        local = {}
        present = set(world_t)
        for v, q in world_t.items():
            p = mapped_parent(v, present)
            local[v] = qnorm(qmul(qinv(world_t[p]), q)) if p else q
        hips = vscale(qrot(self.G, self.sk.pos(w, 'skl_root')), UNIT)
        return local, hips


def solve_arm(sk, w, side, target, pole):
    """IK de dois ossos no mundo w (in place): ombro arm_x1, cotovelo arm_x2, pulso wrist_x até `target`."""
    i1, i2, i3 = sk.index[f'arm_{side}1'], sk.index[f'arm_{side}2'], sk.index[f'wrist_{side}']
    S, E0, H0 = w[i1][0], w[i2][0], w[i3][0]
    l1, l2 = vlen(vsub(E0, S)), vlen(vsub(H0, E0))
    d_vec = vsub(target, S)
    d = max(1e-4, min(vlen(d_vec), (l1 + l2) * 0.999))
    dirv = vnorm(d_vec)
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(0.0, l1 * l1 - a * a))
    pole = vnorm(vsub(pole, vscale(dirv, vdot(pole, dirv))))
    E = vadd(vadd(S, vscale(dirv, a)), vscale(pole, h))
    H = vadd(S, vscale(dirv, d))
    # braço: gira a direção atual para a nova
    q1 = qmul(q_from_unit_vectors(vsub(E0, S), vsub(E, S)), w[i1][1])
    w[i1] = (S, q1, w[i1][2])
    # antebraço: posição e rotação herdadas, depois aponta para a mão
    rest_rel2 = REST_REL[(side, 2)]
    q2 = qmul(q1, rest_rel2)
    dir_cur = qrot(q2, REST_DIR[(side, 2)])
    q2 = qmul(q_from_unit_vectors(dir_cur, vsub(H, E)), q2)
    w[i2] = (E, q2, w[i2][2])
    q3 = qmul(q2, REST_REL[(side, 3)])
    w[i3] = (H, q3, w[i3][2])


REST_REL, REST_DIR = {}, {}


def prepare_ik(sk, rest):
    for side in 'lr':
        i1, i2, i3 = sk.index[f'arm_{side}1'], sk.index[f'arm_{side}2'], sk.index[f'wrist_{side}']
        REST_REL[(side, 2)] = qmul(qinv(rest[i1][1]), rest[i2][1])
        REST_REL[(side, 3)] = qmul(qinv(rest[i2][1]), rest[i3][1])
        # direção do antebraço no referencial local do próprio antebraço
        REST_DIR[(side, 2)] = qrot(qinv(rest[i2][1]), vsub(rest[i3][0], rest[i2][0]))


# ------------------------------------------------------------------ .vrma (glTF binário)
def write_vrma(path, ret, frames, fps, rotations, hips):
    names = [v for v in ret.vrm_bones]
    present = set(names)
    order = sorted(names, key=lambda v: (0 if v == 'hips' else 1, names.index(v)))
    idx = {v: i for i, v in enumerate(order)}
    nodes = []
    rest_pos = {}
    for v in order:
        n = ret.src_of[v]
        rest_pos[v] = vscale(qrot(ret.G, ret.sk.pos(ret.rest, n)), UNIT)
    for v in order:
        p = mapped_parent(v, present)
        t = rest_pos[v] if p is None else vsub(rest_pos[v], rest_pos[p])
        nodes.append({'name': v, 'translation': [round(c, 6) for c in t]})
    for v in order:
        p = mapped_parent(v, present)
        if p is not None:
            nodes[idx[p]].setdefault('children', []).append(idx[v])
    blob = bytearray()
    views, accessors = [], []

    def add(data, fmt, count, typ, minmax=False):
        off = len(blob)
        blob.extend(struct.pack('<%d%s' % (len(data), fmt), *data))
        while len(blob) % 4:
            blob.append(0)
        views.append({'buffer': 0, 'byteOffset': off, 'byteLength': len(data) * 4})
        acc = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': count, 'type': typ}
        if minmax:
            acc['min'], acc['max'] = [min(data)], [max(data)]
        accessors.append(acc)
        return len(accessors) - 1

    times = [f / fps for f in range(frames + 1)]
    t_acc = add(times, 'f', len(times), 'SCALAR', True)
    samplers, channels = [], []
    for v in order:
        vals = [c for q in rotations[v] for c in q]
        a = add(vals, 'f', len(times), 'VEC4')
        samplers.append({'input': t_acc, 'output': a, 'interpolation': 'LINEAR'})
        channels.append({'sampler': len(samplers) - 1, 'target': {'node': idx[v], 'path': 'rotation'}})
    a = add([c for p in hips for c in p], 'f', len(times), 'VEC3')
    samplers.append({'input': t_acc, 'output': a, 'interpolation': 'LINEAR'})
    channels.append({'sampler': len(samplers) - 1, 'target': {'node': idx['hips'], 'path': 'translation'}})
    gl = {
        'asset': {'version': '2.0', 'generator': 'linuxsports-codigo-novo/tools/export_vrma.py'},
        'extensionsUsed': ['VRMC_vrm_animation'],
        'extensions': {'VRMC_vrm_animation': {'specVersion': '1.0',
                                              'humanoid': {'humanBones': {v: {'node': idx[v]} for v in order}}}},
        'scene': 0, 'scenes': [{'nodes': [idx['hips']]}], 'nodes': nodes,
        'animations': [{'name': path.stem, 'samplers': samplers, 'channels': channels}],
        'buffers': [{'byteLength': len(blob)}], 'bufferViews': views, 'accessors': accessors,
    }
    js = json.dumps(gl, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    data = struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(js), 0x4E4F534A) + js \
        + struct.pack('<II', len(blob), 0x004E4942) + bytes(blob)
    write_bytes(path, data)
    return len(data)


# ------------------------------------------------------------------ principal
def family(targets):
    t = set(targets)
    if 'hand_l' in t and 'arm_l1' not in t:
        return 'A0'
    if 'chest1' in t:
        return 'C0'
    return 'A1'


def main(argv):
    if TARGET != 'web':
        raise SystemExit('export_vrma.py grava a saída web (NW4R_TARGET=web)')
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default=None)
    ap.add_argument('--fps', type=int, default=60)
    args = ap.parse_args(argv)
    man = json.loads((ASSETS / 'animations_manifest.json').read_text(encoding='utf-8'))
    bodies = {}
    for f in (ASSETS / 'Models').rglob('ava_body*.nw4r.json'):
        s = json.loads(f.read_text(encoding='utf-8'))
        bodies[s['model']] = s
    entries, report = [], {'exported': 0, 'skipped': [], 'families': {}, 'forward': {}}
    for a in man['animations']:
        if a['type'] != 'CHR0' or not any(m['model'].startswith('ava_body') for m in a['models']):
            continue
        if args.only and not re.search(args.only, a['name']):
            continue
        fam = family(a['targets'])
        src_model = next(m['model'] for m in a['models'] if m['model'].startswith('ava_body'))
        tgt_model = 'ava_bodyA1' if fam == 'A0' else src_model
        if tgt_model not in bodies:
            report['skipped'].append({'name': a['name'], 'reason': f'sem sidecar {tgt_model}'})
            continue
        anim = json.loads((ASSETS / a['file']).read_text(encoding='utf-8'))
        sk = Skeleton(bodies[tgt_model])
        tracks = {b['bone']: b for b in anim['bones']}
        rest = sk.world({}, 0)
        ret = Retargeter(sk, rest)
        frames = max(1, round(anim['frames']))
        hand_scale = 1.0
        src_sk = None
        if fam == 'A0':
            prepare_ik(sk, rest)
            a0 = bodies.get(src_model)
            if a0:
                a0sk = Skeleton(a0)
                hand_scale = sk.pos(rest, 'skl_root')[1] / max(1e-4, a0sk.pos(a0sk.world({}, 0), 'skl_root')[1])
            src_sk = Skeleton(a0) if a0 else None  # as mãos do A0 vêm no espaço do skl_root dele
        rotations = {v: [] for v in ret.vrm_bones}
        hips = []
        prev = {}
        for f in range(frames + 1):
            w = sk.world(tracks, f)
            if fam == 'A0' and src_sk is not None:
                sw = src_sk.world(tracks, f)
                root_src = sw[src_sk.index['skl_root']]
                root_tgt = w[sk.index['skl_root']]
                pole = qrot(qinv(ret.G), (0, -1, -0.6))  # cotovelo para baixo e para trás (base do VRM)
                for side in 'lr':
                    hn = f'hand_{side}'
                    if hn not in src_sk.index:
                        continue
                    rel = qrot(qinv(root_src[1]), vsub(sw[src_sk.index[hn]][0], root_src[0]))
                    target = vadd(root_tgt[0], qrot(root_tgt[1], vscale(rel, hand_scale)))
                    solve_arm(sk, w, side, target, pole)
            local, hp = ret.frame(w)
            for v, q in local.items():
                if v in prev and vdot(q[:3], prev[v][:3]) + q[3] * prev[v][3] < 0:
                    q = tuple(-c for c in q)
                prev[v] = q
                rotations[v].append(q)
            hips.append(hp)
        out = OUT / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', a['name'])}.vrma"
        size = write_vrma(out, ret, frames, args.fps, rotations, hips)
        sport = {'bbl': 'baseball', 'bwg': 'bowling', 'box': 'boxing', 'glf': 'golf', 'tns': 'tennis'}.get(a['name'][:3], 'common')
        entries.append({'name': a['name'], 'sport': sport, 'file': out.relative_to(ASSETS).as_posix(), 'frames': frames,
                        'fps': args.fps, 'loop': a['loop'], 'family': fam, 'sourceModel': src_model, 'skeleton': tgt_model,
                        'source': a['id'], 'bones': len(ret.vrm_bones), 'ik': fam == 'A0', 'bytes': size})
        report['exported'] += 1
        report['families'][fam] = report['families'].get(fam, 0) + 1
        report['forward'][tgt_model] = [round(c, 3) for c in ret.forward_wii]
    write_json(OUT / 'vrma_manifest.json', {'format': 'linuxsports-vrma-manifest', 'version': 1,
                                            'specVersion': 'VRMC_vrm_animation 1.0', 'count': len(entries), 'animations': entries})
    write_json(INDEX / 'vrma-export.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
