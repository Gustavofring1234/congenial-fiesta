#!/usr/bin/env python3
"""Decodifica os efeitos de partícula para o Unity.

  .breft (texturas, de linuxsports-web-wispt/raw/assets/shaders/effects/)  -> Assets/Resources/Effects/<pacote>/<textura>.png
  .breff (emissores, de linuxsports-web/raw/assets/shaders/effects/)       -> Assets/Resources/Effects/<pacote>/<pacote>.effect.json
  índice geral                                                             -> Assets/Resources/Effects/effects_index.json

O .effect.json é lido por Assets/Scripts/Engine/Nw4rParticleFactory.cs (em tempo de execução, via
Resources.Load<TextAsset>) e por Assets/Editor/Nw4rEffectImporter.cs (gera prefabs de ParticleSystem).
Cada emissor ganha `category` (dust, spark, trail, glow, smoke, splash, other) pelo nome e pelas curvas,
usada para escolher o material (alfa x aditivo) quando a configuração de mistura não é decodificável.

Uso: python3 tools/export_effects.py
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r import effects, gx  # noqa: E402
from nw4r.paths import INDEX, LEGACY, RESOURCES, SRC, write_bytes, write_json  # noqa: E402

CATEGORIES = [
    ('trail', re.compile(r'line|trail|locus|orbit|after|kiseki|wave|ripple|stripe', re.I)),
    ('spark', re.compile(r'spark|hibana|kira|star|hit|crash|punch|justmeet|impact|flash|fire|bat', re.I)),
    ('glow', re.compile(r'glow|light|shine|halo|lens|aura|platinum|ring|blink|choice', re.I)),
    ('smoke', re.compile(r'smoke|steam|fog|kemuri|breath', re.I)),
    ('dust', re.compile(r'dust|sand|grass|dirt|soil|bound|turf|chip|base_', re.I)),
    ('splash', re.compile(r'water|splash|sweat|drop|rain|pond', re.I)),
]


def category(name):
    for cat, rx in CATEGORIES:
        if rx.search(name):
            return cat
    return 'other'


def pack_name(path):
    return path.stem


def main():
    tex_by_pack, index = {}, {'format': 'nw4r-effects-index', 'version': 1, 'packs': []}
    for f in sorted((SRC / 'raw/assets/shaders/effects').rglob('*.breft')):
        r = effects.read_breft(f.read_bytes())
        pack = pack_name(f)
        names = {}
        for t in r['textures']:
            out = RESOURCES / 'Effects' / pack / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', t['name'])}.png"
            write_bytes(out, gx.png_bytes(t['width'], t['height'], t['rgba']))
            names[t['name']] = {'resource': f"Effects/{pack}/{out.stem}", 'width': t['width'], 'height': t['height'],
                                'format': t['format'], 'alpha': t['alpha']}
        tex_by_pack[pack] = names
    stats = Counter()
    for f in sorted((LEGACY / 'raw/assets/shaders/effects').rglob('*.breff')):
        pack = pack_name(f)
        known = tex_by_pack.get(pack, {})
        all_known = {n for p in tex_by_pack.values() for n in p}
        r = effects.read_breff(f.read_bytes(), all_known)
        missing = set()
        for em in r['emitters']:
            em['category'] = category(em['name'])
            refs = []
            for tn in em['particle']['textures']:
                if not tn:
                    refs.append(None)
                    continue
                hit = known.get(tn) or next((p[tn] for p in tex_by_pack.values() if tn in p), None)
                if hit is None:
                    missing.add(tn)
                refs.append(hit['resource'] if hit else None)
            em['particle']['textureResources'] = refs
            stats['emitters'] += 1
            stats['curves'] += len(em['curves'])
            stats['curvesDecoded'] += sum(1 for c in em['curves'] if c['keys'])
            stats[f"cat:{em['category']}"] += 1
        doc = {'format': 'nw4r-effect', 'version': 1, 'source': f.relative_to(LEGACY).as_posix(),
               'project': r['project'], 'breffVersion': r['version'], 'pack': pack,
               'timeUnit': 'quadros a 60 Hz', 'coordinateSystem': 'wii-right-handed-y-up (o C# espelha X)',
               'textures': known, 'missingTextures': sorted(missing), 'emitters': r['emitters']}
        out = RESOURCES / 'Effects' / pack / f'{pack}.effect.json'
        write_json(out, doc, compact=True)
        index['packs'].append({'pack': pack, 'resource': f'Effects/{pack}/{pack}', 'emitters': [e['name'] for e in r['emitters']],
                               'textures': len(known), 'missingTextures': sorted(missing)})
    write_json(RESOURCES / 'Effects' / 'effects_index.json', index)
    summary = {'packs': len(index['packs']), 'texturePacks': len(tex_by_pack),
               'textures': sum(len(v) for v in tex_by_pack.values()), **dict(sorted(stats.items())),
               'missingTextures': {p['pack']: p['missingTextures'] for p in index['packs'] if p['missingTextures']}}
    write_json(INDEX / 'effects-export.json', summary)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
