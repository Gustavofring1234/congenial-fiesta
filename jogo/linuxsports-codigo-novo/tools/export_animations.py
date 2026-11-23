#!/usr/bin/env python3
"""Converte as 301 animações 3D dos .brres (CHR0, SRT0, PAT0, CLR0, VIS0, SHP0, SCN0) para JSON
e associa cada uma a modelos (ou cenas), inclusive as 119 sem modelo no mesmo .brres.

Saída (linuxsports-codigo-novo/):
  Assets/StreamingAssets/Animations/<caminho do brres>/<nome>.<tipo>.json
      formato intermediário 'nw4r-anim3d' (ver tools/nw4r/anim.py). É lido em tempo de execução por
      Nw4rAnimationPlayer.cs (UnityWebRequest) e no Editor por Nw4rAnimationImporter.cs (AnimationClip).
  Assets/StreamingAssets/animations_manifest.json
      lista de animações com arquivo, duração, laço, alvos e `models` (candidatos ordenados):
        method 'same-brres'  -> o .model.json do wispt já ligava a animação ao modelo
        method 'structural'  -> correspondência de nomes de ossos (CHR0/VIS0), materiais
                                (SRT0/CLR0/PAT0) ou conjuntos de vértices (SHP0) + hierarquia
      SCN0 (câmeras/luzes) é ligada à cena (`scenes`) cujo contêiner contém o .brres.
  index/animations-matching.json  relatório da associação

Pontuação estrutural (0..1) para cada modelo candidato M e animação A com alvos T(A):
  cobertura = |T(A) ∩ T(M)| / |T(A)|           (quanto da animação o modelo consegue tocar)
  precisão  = |T(A) ∩ T(M)| / |T(M)|           (desempate: modelos mais "do mesmo tipo")
  hierarquia (CHR0) = fração dos pares (osso, pai) da animação que existem igual no modelo,
                      considerando a ordem da animação (a ordem do CHR0 segue a do esqueleto)
  pontuação = 0.6·cobertura + 0.25·hierarquia + 0.15·precisão;  aceita se cobertura >= 0.5
Mesmo esporte (prefixo bbl/box/bwg/glf/tns) soma 0.05 como desempate.

Uso: python3 tools/export_animations.py
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r import anim  # noqa: E402
from nw4r.brres import Brres  # noqa: E402
from nw4r.paths import ASSETS, INDEX, LEGACY, NW4R, SRC, STREAMING, legacy_file, write_json  # noqa: E402

SPORT = re.compile(r'^(bbl|box|bwg|glf|tns|fit|trn)_', re.I)


def sport_of(name):
    m = SPORT.match(name)
    return m.group(1).lower() if m else None


def targets_of(a):
    t = a['type']
    if t in ('CHR0', 'VIS0'):
        return [b['bone'] for b in a['bones']]
    if t in ('SRT0', 'CLR0', 'PAT0'):
        return [m['material'] for m in a['materials']]
    if t == 'SHP0':
        return sorted({x['vertexSet'] for s in a['shapes'] for x in s['targets'] if x['vertexSet']} |
                      {s['base'] for s in a['shapes'] if s['base']})
    return []


def load_models():
    models = []
    for f in sorted((NW4R / 'Models').rglob('*.nw4r.json')):
        s = json.loads(f.read_text(encoding='utf-8'))
        bones = [b['name'] for b in s['bones']]
        parent = {b['name']: (s['bones'][b['parent']]['name'] if b['parent'] >= 0 else None) for b in s['bones']}
        models.append({
            'assetId': s['assetId'], 'model': s['model'], 'brres': s['brres'], 'sidecar': f.relative_to(ASSETS).as_posix(),
            'bones': set(bones), 'boneOrder': bones, 'parent': parent,
            'materials': {m['name'] for m in s['materials']},
            'morphs': {mo['name'] for me in s['meshes'] for mo in me.get('morphs', [])},
            'declared': {(x['type'], x['name']) for x in s.get('animations', [])},
        })
    return models


def score(a, targets, m):
    kind = a['type']
    pool = m['bones'] if kind in ('CHR0', 'VIS0') else m['materials'] if kind in ('SRT0', 'CLR0', 'PAT0') else m['morphs']
    if not targets or not pool:
        return None
    common = set(targets) & pool
    cov = len(common) / len(set(targets))
    prec = len(common) / len(pool)
    hier = 1.0
    if kind == 'CHR0' and len(targets) > 1:
        # pai estimado na animação = osso anterior mais próximo que também é ancestral no modelo
        pairs = ok = 0
        for b in targets[1:]:
            if b not in m['parent']:
                continue
            pairs += 1
            p = m['parent'][b]
            ok += 1 if (p is None or p in targets) else 0
        hier = ok / pairs if pairs else 0.0
    s = 0.6 * cov + 0.25 * hier + 0.15 * prec
    sa, sm = sport_of(a['name']), sport_of(m['model'])
    if sa and sa == sm:
        s += 0.05
    return {'score': round(s, 4), 'coverage': round(cov, 4), 'hierarchy': round(hier, 4), 'precision': round(prec, 4)}


def scenes_index():
    out = []
    for f in sorted((SRC / 'scenes').rglob('*.scene.json')):
        s = json.loads(f.read_text(encoding='utf-8'))
        out.append({'assetId': s['assetId'], 'source': s['source'], 'sport': s.get('sport'),
                    'path': f.relative_to(SRC / 'scenes').as_posix()})
    return out


def main():
    models = load_models()
    scenes = scenes_index()
    by_brres = defaultdict(list)
    for m in models:
        by_brres[legacy_file(m['brres']).resolve()].append(m)
    entries, report = [], Counter()
    orphans = []
    for p in sorted(LEGACY.rglob('*.brres')):
        br = Brres(p.read_bytes())
        rel = p.relative_to(LEGACY / 'raw')
        for kind in anim.PARSERS:
            for name, off in br.entries(kind):
                a = anim.parse(br, kind, name, off)
                a['format'] = 'nw4r-anim3d'
                a['version'] = 1
                a['source'] = f'{rel.as_posix()}/{name}'
                out = STREAMING / 'Animations' / rel.with_suffix('') / f'{re.sub(r"[^A-Za-z0-9_.-]", "_", name)}.{kind.lower()}.json'
                write_json(out, a, compact=True)
                targets = targets_of(a)
                e = {'id': f'{rel.with_suffix("").as_posix()}/{name}.{kind}', 'type': kind, 'name': name,
                     'brres': rel.as_posix(), 'file': out.relative_to(STREAMING).as_posix(),
                     'frames': a['frames'], 'loop': a['loop'], 'targets': targets, 'models': [], 'scenes': []}
                same = [m for m in by_brres.get(p.resolve(), []) if (kind, name) in m['declared']]
                if same:
                    e['method'] = 'same-brres'
                    e['models'] = [{'assetId': m['assetId'], 'model': m['model'], 'sidecar': m['sidecar'],
                                    **(score(a, targets, m) or {'score': 1.0})} for m in same]
                elif kind == 'SCN0':
                    rel_l = rel.as_posix().lower()
                    hits = [s for s in scenes if rel_l.startswith(legacy_file(s['source']).relative_to(LEGACY / 'raw').as_posix().lower())
                            ]
                    if not hits:
                        top = rel.parts[2] if len(rel.parts) > 2 else ''
                        hits = [s for s in scenes if top and f'/{top}/' in f"/{s['path']}"]
                    e['method'] = 'scene-container' if hits else 'unassigned'
                    e['scenes'] = [{'assetId': s['assetId'], 'scene': s['path']} for s in hits]
                    e['cameras'] = [c['name'] for c in a['cameras'] if not c.get('placeholder')]
                    e['lights'] = [l['name'] for l in a['lights']]
                else:
                    cands = []
                    for m in models:
                        sc = score(a, targets, m)
                        if sc and sc['coverage'] >= 0.5:
                            cands.append({'assetId': m['assetId'], 'model': m['model'], 'sidecar': m['sidecar'], **sc})
                    cands.sort(key=lambda c: (-c['score'], c['model']))
                    best = cands[0]['score'] if cands else 0
                    e['models'] = [c for c in cands if c['score'] >= best - 0.02][:12]
                    e['method'] = 'structural' if e['models'] else 'unassigned'
                    orphans.append(e)
                report[(kind, e['method'])] += 1
                entries.append(e)
    manifest = {'format': 'nw4r-animations-manifest', 'version': 1, 'count': len(entries),
                'coordinateSystem': 'wii-right-handed-y-up; graus; o C# espelha X para o Unity',
                'animations': entries}
    write_json(STREAMING / 'animations_manifest.json', manifest, compact=False)
    summary = {
        'animations': len(entries),
        'byType': dict(Counter(e['type'] for e in entries)),
        'byMethod': {f'{k}/{m}': v for (k, m), v in sorted(report.items())},
        'orphansWithoutModelInBrres': len(orphans) + sum(1 for e in entries if e['type'] == 'SCN0' and e['method'] != 'same-brres'),
        'orphansMatched': sum(1 for e in orphans if e['models']),
        'orphansUnassigned': [e['id'] for e in orphans if not e['models']],
    }
    write_json(INDEX / 'animations-matching.json', {
        'summary': summary,
        'orphans': [{'id': e['id'], 'method': e['method'], 'best': e['models'][:3]} for e in orphans],
    })
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
