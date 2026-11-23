#!/usr/bin/env python3
"""Etapa 1 para o WEBC (Three.js 0.180): cenas, .pmp calibrado, colisões, layouts 2D, fontes e textos.

Lê linuxsports-web-wispt/ (somente leitura) e grava em minigames/sports/assets/ (NW4R_TARGET=web):
  Collision/<caminho>.glb + Collision/collision_index.json   malhas de colisão (o SceneLoader monta a MeshBVH)
  Scenes/<caminho>.scene.json + Scenes/scenes_index.json
      models[]    -> sidecar (Models/...nw4r.json) com o .glb e os materiais/texturas por material
      collision[] -> .glb de colisão
      objects[]   -> objetos do .pmp com position, quaternion [x, y, z, w] e scale prontos para o three.js
  UI/...  layouts, animações 2D, texturas e fontes (+ UI/ui_manifest.json)
  Text/us/*.text.json, Text/tsv/*.tsv, Text/text_index.json
  index/pmp-three-calibration.json

Referencial: o do Wii (destro, Y para cima) é o mesmo do glTF e do three.js, então NADA é espelhado
(o stage_unity_assets.py espelha X para o Unity). Os eixos do .pmp vêm na ordem Z, Y, X; lidos como as
COLUNAS da rotação, a checagem abaixo refaz, no espaço do three.js, a altura de cada objeto sobre a
malha de colisão e o sentido tee -> pinos.
"""
import collections
import json
import math
import os
import sys
from pathlib import Path

os.environ.setdefault('NW4R_TARGET', 'web')
sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r.paths import ASSETS, INDEX, SRC, TARGET, manifest, write_json  # noqa: E402
from stage_unity_assets import Terrain, copy_file, glb_triangles, normalize, quat_from_basis, rotate, stage_text, stage_ui  # noqa: E402

if TARGET != 'web':
    raise SystemExit('stage_web_assets.py grava a saída web; para o Unity use stage_unity_assets.py')


def pmp_object(o):
    """Registro .pmp -> transformação do three.js (colunas X, Y, Z da rotação a partir do registro Z, Y, X)."""
    ax = {k: normalize(v) for k, v in o['axes'].items()}
    q = quat_from_basis(ax['x'], ax['y'], ax['z'])
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return {'typeId': o['typeId'], 'variant': o['variant'], 'position': list(o['position']),
            'quaternion': [round(c / n, 7) for c in q], 'scale': o['scale']}


def sidecars_by_asset():
    out = {}
    for f in (ASSETS / 'Models').rglob('*.nw4r.json'):
        s = json.loads(f.read_text(encoding='utf-8'))
        out[s['assetId']] = f.relative_to(ASSETS).as_posix()
    return out


def stage_scenes(by_id):
    sidecars = sidecars_by_asset()
    index, calib, votes = [], {}, collections.Counter()
    collision_index = {}
    for sf in sorted((SRC / 'scenes').rglob('*.scene.json')):
        s = json.loads(sf.read_text(encoding='utf-8'))
        rel = sf.relative_to(SRC / 'scenes')
        models = [{'name': m['name'], 'assetId': m.get('ref'), 'sidecar': sidecars.get(m.get('ref'))} for m in s['models']]
        collision, tris = [], []
        for c in s['collision']:
            a = by_id.get(c.get('ref'))
            if not a:
                collision.append({'name': c['name'], 'assetId': c.get('ref'), 'glb': None})
                continue
            src = SRC / a['main']
            dst = ASSETS / 'Collision' / Path(a['main']).relative_to('assets')
            copy_file(src, dst)
            tris += glb_triangles(src, mirror=False)
            glb = dst.relative_to(ASSETS).as_posix()
            collision.append({'name': c['name'], 'assetId': c['ref'], 'glb': glb})
            collision_index[glb] = c['ref']
        objects = [pmp_object(o) for o in s['objects']]
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
                fwd = rotate(tee['quaternion'], [0, 0, 1])
                cx = sum(p['position'][0] for p in pins) / len(pins) - tee['position'][0]
                cz = sum(p['position'][2] for p in pins) / len(pins) - tee['position'][2]
                dot = (fwd[0] * cx + fwd[2] * cz) / ((math.hypot(fwd[0], fwd[2]) * math.hypot(cx, cz)) or 1)
                err = math.degrees(math.acos(max(-1, min(1, dot))))
                entry['teeForwardToPinsDeg'] = round(err)
                votes['aligned' if err < 90 else 'opposite'] += 1
        calib[rel.as_posix()] = entry
        out = {
            'format': 'nw4r-web-scene', 'version': 1, 'assetId': s['assetId'], 'source': s['source'],
            'sport': s.get('sport'), 'coordinateSystem': 'wii = three.js (destro, Y para cima, 10 u = 1 m)',
            'models': models, 'collision': collision, 'objects': objects,
            'data': [{'role': d.get('role'), 'name': d.get('name'), 'assetId': d.get('ref'),
                      'raw': by_id[d['ref']]['main'] if d.get('ref') in by_id else None} for d in s.get('data', [])],
        }
        dst = ASSETS / 'Scenes' / rel
        write_json(dst, out, compact=True)
        index.append({'assetId': s['assetId'], 'sport': s.get('sport'), 'file': dst.relative_to(ASSETS).as_posix(),
                      'name': rel.name.removesuffix('.scene.json'), 'objects': len(objects)})
    write_json(ASSETS / 'Collision' / 'collision_index.json',
               {'format': 'nw4r-collision-index', 'version': 1,
                'entries': [{'glb': k, 'assetId': v} for k, v in sorted(collision_index.items())]})
    write_json(ASSETS / 'Scenes' / 'scenes_index.json', {'format': 'nw4r-scenes-index', 'version': 1, 'scenes': index})
    missing_sidecars = sorted({m['assetId'] for sc in index for m in json.loads((ASSETS / sc['file']).read_text())['models'] if not m['sidecar']})
    summary = {
        'scenes': len(index), 'objects': sum(e['objects'] for e in calib.values()),
        'onTerrain': sum(e.get('onTerrain', 0) for e in calib.values()),
        'within5Units': sum(e.get('within5Units', 0) for e in calib.values()),
        'maxAbsMedianHeightOffset': max((abs(e['medianHeightOffset']) for e in calib.values() if e.get('medianHeightOffset') is not None), default=None),
        'teeVotes': dict(votes), 'collisionMeshes': len(collision_index), 'modelsWithoutSidecar': missing_sidecars,
        'convention': 'Wii = three.js; registro .pmp Z,Y,X = colunas Z,Y,X da rotação; quaternion [x,y,z,w]',
    }
    write_json(INDEX / 'pmp-three-calibration.json', {'summary': summary, 'scenes': calib})
    return summary


def keep_translations():
    """stage_text() regrava o índice só com 'us'; recoloca as traduções já geradas por translate_texts.py."""
    path = ASSETS / 'Text' / 'text_index.json'
    index = json.loads(path.read_text(encoding='utf-8'))
    for lang in ('pt', 'ja'):
        for f in sorted((ASSETS / 'Text' / lang).glob('*.text.json')):
            doc = json.loads(f.read_text(encoding='utf-8'))
            index['bmg'].append({'language': lang, 'file': doc['file'], 'path': f.relative_to(ASSETS).as_posix(),
                                 'messages': len(doc['messages']), 'nonEmpty': len(doc['messages']),
                                 'duplicateIds': 0, 'translated': True})
    write_json(path, index)
    return sorted({e['language'] for e in index['bmg']})


def main():
    by_id = manifest()
    summary = {'target': TARGET, 'scenes': stage_scenes(by_id), 'ui': stage_ui(by_id), 'text': stage_text()}
    summary['text']['languages'] = keep_translations()
    write_json(INDEX / 'stage-web-summary.json', summary)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
