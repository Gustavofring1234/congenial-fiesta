#!/usr/bin/env python3
"""Liga cada textura ao material que a usa, em todos os models/**/*.model.json.

Antes, o .model.json listava todas as texturas TEX0 do .brres de origem. Este script lê o
MDL0 do .brres original (em ../linuxsports-web/raw/, somente leitura) e calcula, para cada
.model.json do wispt (também somente leitura):
  materials: [{name, translucent, doubleSided, layers: [{texture, palette, wrapS, wrapT}],
               objects: [nomes dos polígonos que desenham com ele], inGlb}]
  textures[i].materials: materiais deste modelo que usam a textura ([] = não usada por ele)
  textures[i].layer0: true se for a camada 0 de algum material (a única embutida no .glb)
O nome de cada material é conferido com os materiais do .glb correspondente.
Saída (no projeto novo): index/model-materials.json (relatório) e index/model-materials/<assetId>.json
(materiais e texturas ligados). O Unity usa o sidecar de tools/export_models.py, que traz o mesmo vínculo.

Uso: python3 tools/link_model_materials.py [--legacy ../linuxsports-web] [--check]
  --check  só verifica (não grava nada)
"""
import argparse
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r.brres import Brres  # noqa: E402
from nw4r.paths import INDEX, LEGACY, SRC as ROOT, legacy_file, write_json  # noqa: E402


def glb_json(path):
    b = path.read_bytes()
    n, = struct.unpack_from('<I', b, 12)
    return json.loads(b[20:20 + n])


def link(mj, legacy, cache):
    brres_path = legacy_file(mj['brres'], legacy)
    if brres_path not in cache:
        cache[brres_path] = Brres(brres_path.read_bytes())
    mdl = cache[brres_path].model(mj['model'])
    mats = mdl.materials()
    by_index = {m['index']: m for m in mats}
    objs = mdl.objects()
    usage = {m['name']: {'objects': [], 'translucent': False} for m in mats}
    for obj, mat, xlu in mdl.draw_list():
        m = by_index.get(mat) or (mats[mat] if mat < len(mats) else None)
        if m is None or obj >= len(objs):
            continue
        usage[m['name']]['objects'].append(objs[obj])
        usage[m['name']]['translucent'] |= xlu
    g = glb_json(ROOT / mj['glb'])
    glb_names = {m.get('name') for m in g.get('materials', [])}
    materials = [{
        'name': m['name'],
        'translucent': usage[m['name']]['translucent'],
        'doubleSided': m['cull'] == 0,
        'layers': m['layers'],
        'objects': usage[m['name']]['objects'],
        'inGlb': m['name'] in glb_names,
    } for m in mats]
    used_by = {}
    layer0 = set()
    for m in materials:
        for i, layer in enumerate(m['layers']):
            if layer['texture']:
                used_by.setdefault(layer['texture'], []).append(m['name'])
                if i == 0:
                    layer0.add(layer['texture'])
    known = {t['name'] for t in mj['textures']}
    textures = [{**t, 'materials': sorted(set(used_by.get(t['name'], []))), 'layer0': t['name'] in layer0} for t in mj['textures']]
    # camadas que apontam para texturas de outro .brres (carregadas em tempo de execução pelo jogo)
    external = sorted(set(used_by) - known)
    for name in external:
        textures.append({'name': name, 'foundIn': None, 'materials': sorted(set(used_by[name])), 'layer0': name in layer0})
    issues = {
        'glbMaterialsMissingInMdl0': sorted(n for n in glb_names - {m['name'] for m in mats} if n != 'padrao'),
        'externalTextures': external,
        'unusedTextures': sorted(t['name'] for t in textures if not t['materials']),
    }
    return materials, textures, issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--legacy', default=str(LEGACY))
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()
    legacy = Path(args.legacy)
    cache, report, errors = {}, {}, {}
    files = sorted((ROOT / 'models').rglob('*.model.json'))
    for f in files:
        text = f.read_text(encoding='utf-8')
        mj = json.loads(text)
        try:
            materials, textures, issues = link(mj, legacy, cache)
        except (OSError, KeyError, ValueError, struct.error) as e:
            errors[mj['assetId']] = f'{type(e).__name__}: {e}'
            continue
        report[mj['assetId']] = {'model': mj['model'], 'materials': len(materials), **issues}
        if not args.check:
            write_json(INDEX / 'model-materials' / f"{mj['assetId']}.json",
                       {'assetId': mj['assetId'], 'model': mj['model'], 'materials': materials, 'textures': textures})
    summary = {
        'models': len(files), 'linked': len(report), 'errors': errors,
        'materials': sum(r['materials'] for r in report.values()),
        'modelsWithUnusedTextures': sum(1 for r in report.values() if r['unusedTextures']),
        'unusedTextureRefs': sum(len(r['unusedTextures']) for r in report.values()),
        'externalTextureRefs': sum(len(r['externalTextures']) for r in report.values()),
        'glbNameMismatches': {k: r['glbMaterialsMissingInMdl0'] for k, r in report.items() if r['glbMaterialsMissingInMdl0']},
    }
    if not args.check:
        write_json(INDEX / 'model-materials.json', {'summary': summary, 'models': report})
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 1 if errors or summary['glbNameMismatches'] else 0


if __name__ == '__main__':
    sys.exit(main())
