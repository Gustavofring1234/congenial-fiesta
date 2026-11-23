#!/usr/bin/env python3
"""Etapa 4 — ambiente das cenas: luzes (.plight), light textures (.plmap), bloom (.pblm),
.pmmisc e texturas .bti avulsas -> JSON/PNG para o Unity. Formatos em tools/nw4r/env.py.

Saída:
  Assets/StreamingAssets/Environment/<preset>.env.json   um conjunto (luz + lightmap + bloom + misc)
  Assets/StreamingAssets/Environment/environment_index.json  presets, cena -> preset, 10 rampas
  Assets/Resources/Environment/Textures/<nome>.png        .bti decodificados (lm_0/lm_1 padrão etc.)
  index/environment-export.json                           relatório

Presets: a mesma montagem que o jogo faz (strings do DOL): cada esporte carrega
`Environment/scene_{Light,Lm,Bloom,ModelMisc}` da sua pasta common; o golfe sobrepõe
`glf_scene_%s/glf_scene_%s.*` do curso quando existe (8038e342); o boxe usa EnvMain (luta) e
EnvMiniGame com 3 luzes (treinos); o tênis tem as variantes _b (quadra b) e _select (seleção).
Uso: python3 tools/export_environment.py
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r import env, gx  # noqa: E402
from nw4r.paths import INDEX, RESOURCES, SRC, STREAMING, write_bytes, write_json  # noqa: E402

RAW = SRC / 'raw'
OUT_DIR = STREAMING / 'Environment'
TEX_DIR = RESOURCES / 'Environment/Textures'


def _preset(name, sport, light, lmap=None, bloom=None, misc=None, base=None):
    return {'name': name, 'sport': sport, 'light': light, 'lightmap': lmap, 'bloom': bloom, 'misc': misc,
            'base': base}


def presets():
    sp = 'src/minigames/{0}/common/Environment/'
    out = [
        _preset('rpcommon', 'shared', 'src/core/shared/RPCommon/common/Environment/scene_Light.plight',
                'src/core/shared/RPCommon/common/Environment/scene_Lm.plmap'),
        _preset('baseball', 'baseball', sp.format('baseball') + 'scene_Light.plight', sp.format('baseball') + 'scene_Lm.plmap',
                sp.format('baseball') + 'scene_Bloom.pblm', sp.format('baseball') + 'scene_ModelMisc.pmmisc'),
        _preset('bowling', 'bowling', sp.format('bowling') + 'scene_Light.plight', sp.format('bowling') + 'scene_Lm.plmap',
                sp.format('bowling') + 'scene_Bloom.pblm', sp.format('bowling') + 'scene_ModelMisc.pmmisc'),
        _preset('golf', 'golf', sp.format('golf') + 'scene_Light.plight', sp.format('golf') + 'scene_Lm.plmap',
                sp.format('golf') + 'scene_Bloom.pblm', sp.format('golf') + 'scene_ModelMisc.pmmisc'),
        _preset('tennis', 'tennis', sp.format('tennis') + 'scene_Light.plight', sp.format('tennis') + 'scene_Lm.plmap',
                sp.format('tennis') + 'scene_Bloom.pblm'),
        _preset('tennis_b', 'tennis', sp.format('tennis') + 'scene_Light_b.plight', sp.format('tennis') + 'scene_Lm_b.plmap',
                sp.format('tennis') + 'scene_Bloom_b.pblm'),
        _preset('tennis_select', 'tennis', sp.format('tennis') + 'scene_Light_select.plight',
                sp.format('tennis') + 'scene_Lm_select.plmap', sp.format('tennis') + 'scene_Bloom.pblm'),
        _preset('boxing_main', 'boxing', 'assets/maps/boxing/EnvMain/scene_Light_MainGame.plight',
                'assets/maps/boxing/EnvMain/scene_Lm_MainGame.plmap', 'assets/maps/boxing/EnvMain/box_ring.pblm'),
    ]
    for k in (1, 2, 3):
        out.append(_preset(f'boxing_minigame{k:02d}', 'boxing',
                           f'assets/maps/boxing/EnvMiniGame/scene_Light_MiniGame{k:02d}.plight',
                           'assets/maps/boxing/EnvMiniGame/scene_Lm_MiniGame.plmap',
                           'assets/maps/boxing/EnvMiniGame/box_gym.pblm'))
    for d in sorted((RAW / 'assets/maps/golf').glob('glf_scene_*')):
        c = d.name[len('glf_scene_'):]
        rel = f'assets/maps/golf/{d.name}/{d.name}'
        out.append(_preset(f'golf_{c}', 'golf', rel + '.plight', rel + '.plmap', rel + '.pblm',
                           sp.format('golf') + 'scene_ModelMisc.pmmisc', base='golf'))
    return out


def scene_preset(file, names):
    """Arquivo de cena (scenes_index.json) -> preset de ambiente."""
    m = re.search(r'maps/golf/glf_course_([A-Za-z0-9]+)\.scene', file)
    if m:
        return f'golf_{m.group(1)}' if f'golf_{m.group(1)}' in names else 'golf'
    rules = [('maps/baseball/', 'baseball'), ('maps/boxing/MainGame', 'boxing_main'),
             ('maps/tennis/tns_Field_b', 'tennis_b'), ('maps/tennis/', 'tennis')]
    for key, p in rules:
        if key in file:
            return p
    m = re.search(r'src/minigames/(\w+)/', file)
    if m:
        sport = m.group(1)
        return {'boxing': 'boxing_main'}.get(sport, sport if sport in names else 'rpcommon')
    return 'rpcommon'


def main():
    report = {'presets': [], 'bti': [], 'errors': []}
    plist = presets()
    names = {p['name'] for p in plist}
    used_files = set()
    for p in plist:
        doc = {'format': 'linuxsports-environment', 'version': 1, 'name': p['name'], 'sport': p['sport'],
               'base': p['base'], 'sources': {}}
        for key, parser in (('light', env.parse_plight), ('lightmap', env.parse_plmap),
                            ('bloom', env.parse_pblm), ('misc', env.parse_pmmisc)):
            rel = p[key]
            if rel is None:
                doc[key] = None
                continue
            path = RAW / rel
            doc[key] = parser(path.read_bytes())
            doc['sources'][key] = 'raw/' + rel
            used_files.add(rel)
        write_json(OUT_DIR / f"{p['name']}.env.json", doc)
        lights = doc['light']['lights']
        report['presets'].append({
            'name': p['name'], 'lights': len(lights),
            'gxLights': sum(1 for l in lights if l['enabled'] and l['gx']),
            'lightTextureLights': sum(1 for l in lights if l['enabled'] and l['lightTexture']),
            'lightTextures': [t['name'] for t in (doc['lightmap'] or {'textures': []})['textures']],
            'bloom': None if doc['bloom'] is None else doc['bloom']['threshold'] < 1.0})

    all_env = {str(f.relative_to(RAW)) for e in ('plight', 'plmap', 'pblm', 'pmmisc') for f in RAW.glob(f'**/*.{e}')}
    report['unusedEnvironmentFiles'] = sorted(all_env - used_files)

    for f in sorted(RAW.glob('**/*.bti')):
        rel = f.relative_to(RAW)
        meta, rgba = env.parse_bti(f.read_bytes())
        name = str(rel.with_suffix('')).replace('/', '__')
        write_bytes(TEX_DIR / f'{name}.png', gx.png_bytes(meta['width'], meta['height'], rgba))
        report['bti'].append({'source': 'raw/' + str(rel), 'resource': f'Environment/Textures/{name}', **meta})

    scenes = json.loads((STREAMING / 'Scenes/scenes_index.json').read_text(encoding='utf-8'))['scenes']
    mapping = {s['file']: scene_preset(s['file'], names) for s in scenes}
    write_json(OUT_DIR / 'environment_index.json', {
        'format': 'linuxsports-environment-index', 'version': 1,
        'presets': [{'name': p['name'], 'sport': p['sport'], 'file': f"Environment/{p['name']}.env.json"} for p in plist],
        'scenes': mapping,
        'textures': {b['source']: b['resource'] for b in report['bti']},
        'ramps': env.ramps(),
        'lightTextureSize': 64,
    })
    report['scenes'] = len(mapping)
    write_json(INDEX / 'environment-export.json', report)
    print(f"presets: {len(plist)} · cenas mapeadas: {len(mapping)} · bti: {len(report['bti'])} · "
          f"arquivos de ambiente sem preset: {len(report['unusedEnvironmentFiles'])}")
    for r in report['presets']:
        print(f"  {r['name']:20s} luzes GX {r['gxLights']:2d} · lightmap {r['lightTextureLights']:2d} {r['lightTextures']} · bloom {r['bloom']}")


if __name__ == '__main__':
    main()
