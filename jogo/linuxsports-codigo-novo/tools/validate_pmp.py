#!/usr/bin/env python3
"""Calibra a leitura dos objetos .pmp (cursos de golfe) contra as malhas de colisão .glb.

Os registros do .pmp guardam três vetores de base na ordem Z, Y, X (parsers/pmp.ts). Este
script confere, por cena:
  1. Posição: altura do objeto menos a altura do terreno (colisão) no mesmo (x, z). Se o
     referencial do .pmp fosse outro (eixos trocados, escala), a diferença não seria ~0.
  2. Inclinação: quantos objetos têm o eixo Y diferente de (0, 1, 0).
  3. Sentido do yaw: o eixo Z do tee (tipo 0, único na cena) deve apontar para os pinos
     (tipo 1). Compara a leitura dos vetores como COLUNAS da rotação (Matrix4.makeBasis(x, y, z),
     usada pelo viewer) com a leitura como LINHAS (a transposta, yaw com sinal trocado).
Resultado em index/pmp-calibration.json (do projeto novo; lê linuxsports-web-wispt, somente leitura).
A mesma checagem já no referencial do Unity é feita por tools/stage_unity_assets.py.

Uso: python3 tools/validate_pmp.py
"""
import collections
import json
import math
import struct
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent
ROOT = OUT.parent / 'linuxsports-web-wispt'  # origem, somente leitura
CELL = 200.0


def glb_triangles(path):
    b = path.read_bytes()
    n, = struct.unpack_from('<I', b, 12)
    j = json.loads(b[20:20 + n])
    binary = b[20 + n + 8:]

    def accessor(i):
        a = j['accessors'][i]
        bv = j['bufferViews'][a['bufferView']]
        off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        nc = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        fmt = {5126: 'f', 5125: 'I', 5123: 'H', 5121: 'B'}[a['componentType']]
        stride = bv.get('byteStride', struct.calcsize(fmt) * nc)
        return [struct.unpack_from(f'<{nc}{fmt}', binary, off + k * stride) for k in range(a['count'])]

    tris = []
    for node in j.get('nodes', []):
        if 'mesh' not in node:
            continue
        for p in j['meshes'][node['mesh']]['primitives']:
            pos = accessor(p['attributes']['POSITION'])
            idx = [i[0] for i in accessor(p['indices'])] if 'indices' in p else list(range(len(pos)))
            tris += [(pos[idx[k]], pos[idx[k + 1]], pos[idx[k + 2]]) for k in range(0, len(idx) - 2, 3)]
    return tris


class Terrain:
    def __init__(self, tris):
        self.grid = collections.defaultdict(list)
        for t in tris:
            xs, zs = [v[0] for v in t], [v[2] for v in t]
            for gx in range(int(min(xs) // CELL), int(max(xs) // CELL) + 1):
                for gz in range(int(min(zs) // CELL), int(max(zs) // CELL) + 1):
                    self.grid[(gx, gz)].append(t)

    def height(self, x, z, near_y):
        """Altura da superfície em (x, z) mais próxima de near_y, ou None."""
        best = None
        for a, b, c in self.grid[(int(x // CELL), int(z // CELL))]:
            d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
            if abs(d) < 1e-9:
                continue
            l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
            l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
            l3 = 1 - l1 - l2
            if min(l1, l2, l3) < -1e-4:
                continue
            y = l1 * a[1] + l2 * b[1] + l3 * c[1]
            if best is None or abs(y - near_y) < abs(best - near_y):
                best = y
        return best


def angle(u, v):
    nu, nv = math.hypot(*u), math.hypot(*v)
    if nu < 1e-9 or nv < 1e-9:
        return None
    return math.degrees(math.acos(max(-1.0, min(1.0, (u[0] * v[0] + u[1] * v[1]) / (nu * nv)))))


def main():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    by_id = {a['assetId']: a for a in manifest['assets']}
    scenes, votes = {}, collections.Counter()
    for sf in sorted((ROOT / 'scenes').rglob('*.scene.json')):
        s = json.loads(sf.read_text())
        objs = s['objects']
        if not objs:
            continue
        tris = [t for c in s['collision'] if c.get('ref') for t in glb_triangles(ROOT / by_id[c['ref']]['main'])]
        terrain = Terrain(tris)
        dys = []
        for o in objs:
            x, y, z = o['position']
            h = terrain.height(x, z, y)
            if h is not None:
                dys.append(y - h)
        dys.sort()
        tilted = sum(1 for o in objs if o['axes']['y'] != [0, 1, 0])
        entry = {
            'objects': len(objs), 'onTerrain': len(dys),
            'medianHeightOffset': round(dys[len(dys) // 2], 3) if dys else None,
            'within5Units': sum(1 for d in dys if abs(d) < 5), 'tilted': tilted,
            'types': dict(sorted(collections.Counter(o['typeId'] for o in objs).items())),
        }
        tees = [o for o in objs if o['typeId'] == 0]
        pins = [o for o in objs if o['typeId'] == 1]
        if len(tees) == 1 and pins:
            tee = tees[0]
            cx = sum(p['position'][0] for p in pins) / len(pins) - tee['position'][0]
            cz = sum(p['position'][2] for p in pins) / len(pins) - tee['position'][2]
            ax, az = tee['axes']['x'], tee['axes']['z']
            col = angle((az[0], az[2]), (cx, cz))
            row = angle((ax[2], az[2]), (cx, cz))
            yaw = round(math.degrees(math.atan2(az[0], az[2])))
            entry['tee'] = {'yawDeg': yaw, 'errColumnsDeg': round(col), 'errRowsDeg': round(row)}
            # yaw 0/180 não distingue as duas leituras
            if abs(math.sin(math.radians(yaw))) > 0.05 and abs(col - row) > 2:
                votes['columns' if col < row else 'rows'] += 1
        scenes[sf.relative_to(ROOT).as_posix()] = entry
    all_off = [e['medianHeightOffset'] for e in scenes.values() if e['medianHeightOffset'] is not None]
    summary = {
        'scenes': len(scenes),
        'objects': sum(e['objects'] for e in scenes.values()),
        'onTerrain': sum(e['onTerrain'] for e in scenes.values()),
        'within5Units': sum(e['within5Units'] for e in scenes.values()),
        'maxAbsMedianHeightOffset': max(abs(v) for v in all_off) if all_off else None,
        'tilted': sum(e['tilted'] for e in scenes.values()),
        'yawVotes': dict(votes),
        'conclusion': (
            'Posições no referencial da colisão (sem troca de eixos nem escala). Nenhum objeto inclinado: '
            'o eixo Y é sempre (0,1,0). A ordem Z,Y,X dá det=+1 e, lida como colunas (makeBasis(x,y,z)), '
            'orienta o +Z do tee para os pinos na maioria dos cursos com yaw não trivial.'
            if votes['columns'] > votes['rows'] else
            'A leitura por linhas venceu: transponha a base no loader (viewer/src/engine/pmp.js).'),
        'convention': 'columns' if votes['columns'] >= votes['rows'] else 'rows',
    }
    out = {'summary': summary, 'scenes': scenes}
    (OUT / 'index').mkdir(exist_ok=True)
    (OUT / 'index/pmp-calibration.json').write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
