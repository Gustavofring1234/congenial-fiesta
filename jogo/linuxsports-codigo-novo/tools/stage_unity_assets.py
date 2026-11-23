#!/usr/bin/env python3
"""Etapa 1 para o Unity: cenas (.pmp calibrado), colisões, layouts 2D, fontes, texturas de UI e textos.

Lê linuxsports-web-wispt/ (somente leitura) e grava em linuxsports-codigo-novo/:
  Assets/Nw4r/Collision/<caminho>.glb             malhas de colisão (o Editor gera prefabs com MeshCollider)
  Assets/StreamingAssets/Scenes/<caminho>.scene.json
      cena no referencial do Unity: models[] e collision[] com o recurso (Resources) do prefab,
      objects[] do .pmp com position/rotation(quaternion)/scale JÁ convertidos (ver abaixo)
  Assets/StreamingAssets/Scenes/scenes_index.json
  Assets/StreamingAssets/UI/...                   .layout.json, .anim.json, .png, .font.json (mesmos caminhos do wispt)
  Assets/StreamingAssets/UI/ui_manifest.json      layouts -> texturas, fontes e animações (só o necessário ao player)
  Assets/StreamingAssets/Text/<idioma>/*.text.json + Text/tsv/*.tsv + Text/text_index.json
  index/pmp-unity-calibration.json

Conversão Wii -> Unity (a mesma do glTFast para os .glb, que espelha o eixo X):
  posição  (x, y, z)            -> (-x, y, z)
  rotação  R = [X Y Z] (colunas) -> R' = S·R·S, S = diag(-1, 1, 1)  -> quaternion (qx, -qy, -qz, qw)
  escala   inalterada
Os eixos do .pmp vêm na ordem Z, Y, X; tools/validate_pmp.py mostrou que formam as COLUNAS da rotação
(5 de 6 cursos com yaw não trivial: +Z do tee aponta para os pinos). Este script refaz a checagem já
no espaço do Unity, contra as malhas de colisão também espelhadas: altura do objeto sobre o terreno e
direção do tee -> pinos.
"""
import collections
import json
import math
import shutil
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r.paths import ASSETS, INDEX, NW4R, SRC, STREAMING, manifest, write_bytes, write_json  # noqa: E402

CELL = 200.0


# ---------------------------------------------------------------------- matemática
def quat_from_basis(x, y, z):
    """Quaternion (x, y, z, w) da matriz de rotação com colunas x, y, z."""
    m00, m01, m02 = x[0], y[0], z[0]
    m10, m11, m12 = x[1], y[1], z[1]
    m20, m21, m22 = x[2], y[2], z[2]
    tr = m00 + m11 + m22
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]
    if m00 > m11 and m00 > m22:
        s = math.sqrt(1.0 + m00 - m11 - m22) * 2
        return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
    if m11 > m22:
        s = math.sqrt(1.0 + m11 - m00 - m22) * 2
        return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
    s = math.sqrt(1.0 + m22 - m00 - m11) * 2
    return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]


def normalize(v):
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return [c / n for c in v]


def wii_to_unity_object(o):
    ax = {k: normalize(v) for k, v in o['axes'].items()}
    q = quat_from_basis(ax['x'], ax['y'], ax['z'])
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    q = [c / n for c in q]
    qu = [q[0], -q[1], -q[2], q[3]]
    p = o['position']
    return {'typeId': o['typeId'], 'variant': o['variant'], 'position': [-p[0], p[1], p[2]],
            'rotation': [round(c, 7) for c in qu], 'scale': o['scale']}


def rotate(q, v):
    x, y, z, w = q
    # v' = q v q*
    tx = 2 * (y * v[2] - z * v[1])
    ty = 2 * (z * v[0] - x * v[2])
    tz = 2 * (x * v[1] - y * v[0])
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]


# ---------------------------------------------------------------------- colisão
def glb_triangles(path, mirror=True):
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
            if mirror:
                pos = [(-v[0], v[1], v[2]) for v in pos]
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


# ---------------------------------------------------------------------- etapas
def copy_file(src, dst):
    dst = Path(dst)
    if dst.exists() and dst.stat().st_size == src.stat().st_size and dst.read_bytes() == src.read_bytes():
        return dst
    return write_bytes(dst, src.read_bytes())


def stage_scenes(by_id):
    index, calib, votes = [], {}, collections.Counter()
    collision_index = {}
    for sf in sorted((SRC / 'scenes').rglob('*.scene.json')):
        s = json.loads(sf.read_text(encoding='utf-8'))
        rel = sf.relative_to(SRC / 'scenes')
        models = []
        for m in s['models']:
            a = by_id.get(m.get('ref'))
            models.append({'name': m['name'], 'assetId': m.get('ref'),
                           'prefab': f"Prefabs/Models/{m['ref']}" if a else None})
        collision = []
        tris = []
        for c in s['collision']:
            a = by_id.get(c.get('ref'))
            if not a:
                collision.append({'name': c['name'], 'assetId': c.get('ref'), 'prefab': None})
                continue
            src = SRC / a['main']
            dst = NW4R / 'Collision' / Path(a['main']).relative_to('assets')
            copy_file(src, dst)
            tris += glb_triangles(src, mirror=True)
            collision.append({'name': c['name'], 'assetId': c['ref'], 'prefab': f"Prefabs/Collision/{c['ref']}",
                              'glb': dst.relative_to(ASSETS).as_posix()})
            collision_index[dst.relative_to(ASSETS).as_posix()] = c['ref']
        objects = [wii_to_unity_object(o) for o in s['objects']]
        entry = {'objects': len(objects)}
        if objects and tris:
            terrain = Terrain(tris)
            dys = sorted(o['position'][1] - h for o in objects
                         if (h := terrain.height(o['position'][0], o['position'][2], o['position'][1])) is not None)
            entry.update(onTerrain=len(dys), medianHeightOffset=round(dys[len(dys) // 2], 3) if dys else None,
                         within5Units=sum(1 for d in dys if abs(d) < 5))
            tees = [o for o in objects if o['typeId'] == 0]
            pins = [o for o in objects if o['typeId'] == 1]
            if len(tees) == 1 and pins:
                tee = tees[0]
                fwd = rotate(tee['rotation'], [0, 0, 1])
                cx = sum(p['position'][0] for p in pins) / len(pins) - tee['position'][0]
                cz = sum(p['position'][2] for p in pins) / len(pins) - tee['position'][2]
                dot = (fwd[0] * cx + fwd[2] * cz) / ((math.hypot(fwd[0], fwd[2]) * math.hypot(cx, cz)) or 1)
                err = math.degrees(math.acos(max(-1, min(1, dot))))
                entry['teeForwardToPinsDeg'] = round(err)
                votes['aligned' if err < 90 else 'opposite'] += 1
        calib[rel.as_posix()] = entry
        out = {
            'format': 'nw4r-unity-scene', 'version': 1, 'assetId': s['assetId'], 'source': s['source'],
            'sport': s.get('sport'), 'coordinateSystem': 'unity-left-handed (X espelhado em relação ao Wii)',
            'models': models, 'collision': collision, 'objects': objects,
            'data': [{'role': d.get('role'), 'name': d.get('name'), 'assetId': d.get('ref'),
                      'raw': by_id[d['ref']]['main'] if d.get('ref') in by_id else None} for d in s.get('data', [])],
        }
        dst = STREAMING / 'Scenes' / rel
        write_json(dst, out, compact=True)
        index.append({'assetId': s['assetId'], 'sport': s.get('sport'), 'file': dst.relative_to(STREAMING).as_posix(),
                      'name': rel.name.removesuffix('.scene.json'), 'objects': len(objects)})
    write_json(NW4R / 'Collision' / 'collision_index.json',
               {'format': 'nw4r-collision-index', 'version': 1,
                'entries': [{'glb': k, 'assetId': v} for k, v in sorted(collision_index.items())]})
    write_json(STREAMING / 'Scenes' / 'scenes_index.json', {'format': 'nw4r-scenes-index', 'version': 1, 'scenes': index})
    summary = {
        'scenes': len(index), 'objects': sum(e['objects'] for e in calib.values()),
        'onTerrain': sum(e.get('onTerrain', 0) for e in calib.values()),
        'within5Units': sum(e.get('within5Units', 0) for e in calib.values()),
        'maxAbsMedianHeightOffset': max((abs(e['medianHeightOffset']) for e in calib.values() if e.get('medianHeightOffset') is not None), default=None),
        'teeVotes': dict(votes),
        'convention': 'Wii colunas (X,Y,Z) a partir do registro Z,Y,X; Unity = espelho em X: pos(-x,y,z), quat(x,-y,-z,w)',
    }
    write_json(INDEX / 'pmp-unity-calibration.json', {'summary': summary, 'scenes': calib})
    return summary


def stage_ui(by_id):
    layouts, files = [], set()
    anims_by_layout = collections.defaultdict(list)
    for a in by_id.values():
        if a['kind'] == 'animation':
            for r in a['refs']:
                if r.startswith('lyt_'):
                    anims_by_layout[r].append(a)
    missing = {m['animation']: m['missing'] for m in json.loads((SRC / 'index/anim-missing-targets.json').read_text())}

    def need(path):
        files.add(path)
        return path

    for a in sorted((x for x in by_id.values() if x['kind'] == 'layout'), key=lambda x: x['main']):
        lj = json.loads((SRC / a['main']).read_text(encoding='utf-8'))
        textures = []
        for t in lj['textures']:
            ta = by_id.get(t.get('ref'))
            png = next((f for f in ta['files'] if f.endswith('.png')), None) if ta else None
            textures.append({'name': t['name'], 'png': need(png) if png else None})
        fonts = []
        for f in lj['fonts']:
            fa = by_id.get(f.get('ref'))
            if fa:
                need(fa['main'])
                for x in fa['files']:
                    need(x)
            fonts.append({'name': f['name'], 'font': fa['main'] if fa else None})
        anims = []
        for an in sorted(anims_by_layout[a['assetId']], key=lambda x: x['main']):
            aj = json.loads((SRC / an['main']).read_text(encoding='utf-8'))
            atex = []
            for t in aj.get('textures', []):
                ta = by_id.get(t.get('ref'))
                png = next((f for f in ta['files'] if f.endswith('.png')), None) if ta else None
                atex.append(need(png) if png else None)
            anims.append({'assetId': an['assetId'], 'file': need(an['main']), 'name': Path(an['main']).name.split('.')[0],
                          'frames': aj.get('frameSize'), 'loop': aj.get('loop'), 'textures': atex,
                          'missingTargets': missing.get(an['assetId'], [])})
        layouts.append({'assetId': a['assetId'], 'name': Path(a['main']).name.removesuffix('.layout.json'),
                        'file': need(a['main']), 'textures': textures, 'fonts': fonts, 'animations': anims})
    for f in sorted(files):
        copy_file(SRC / f, STREAMING / 'UI' / f)
    fonts_all = sorted({f['font'] for l in layouts for f in l['fonts'] if f['font']})
    write_json(STREAMING / 'UI' / 'ui_manifest.json', {
        'format': 'nw4r-ui-manifest', 'version': 1, 'root': 'UI', 'fonts': fonts_all, 'layouts': layouts})
    return {'layouts': len(layouts), 'animations': sum(len(l['animations']) for l in layouts),
            'animationsWithMissingTargets': sum(1 for l in layouts for x in l['animations'] if x['missingTargets']),
            'files': len(files)}


def stage_text():
    idx = json.loads((SRC / 'index/text-index.json').read_text())
    out = []
    for e in idx:
        dst = STREAMING / 'Text' / e['language'] / Path(e['path']).name
        copy_file(SRC / e['path'], dst)
        out.append({**e, 'path': dst.relative_to(STREAMING).as_posix()})
    tsv = []
    for f in sorted((SRC / 'raw/docs/textos').glob('*.tsv')):
        dst = STREAMING / 'Text' / 'tsv' / f.name
        copy_file(f, dst)
        tsv.append({'file': f.stem, 'path': dst.relative_to(STREAMING).as_posix()})
    write_json(STREAMING / 'Text' / 'text_index.json', {'format': 'nw4r-text-index', 'version': 1, 'bmg': out, 'tsv': tsv})
    return {'bmgFiles': len(out), 'messages': sum(e['messages'] for e in out), 'tsvFiles': len(tsv)}


def main():
    by_id = manifest()
    summary = {'scenes': stage_scenes(by_id), 'ui': stage_ui(by_id), 'text': stage_text()}
    write_json(INDEX / 'stage-summary.json', summary)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
