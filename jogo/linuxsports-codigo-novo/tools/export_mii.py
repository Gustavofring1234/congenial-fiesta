#!/usr/bin/env python3
"""Etapa 3: RFL_Res.dat + 60 .rcd -> Assets/Resources/Mii/ (lido por MiiCharacterBuilder.cs).

Saída (todas as pastas sob Assets/Resources/Mii/):
  Shapes/<parte>.json      formas 3D por tipo (faceline traz as 3 âncoras nose/beard/hair)
  Textures/<parte>/NN.png  texturas decodificadas; I4/I8 com alfa = intensidade (semântica do GX)
  textures.json            formato, tamanho e wrap (GX: 0 clamp, 1 repeat, 2 mirror) de cada textura
  Profiles/cpu_mii_NNN.json  RFLCharData (base64) + campos decodificados do RFLiCharInfo
  profiles.json            índice dos perfis
  rfl_params.json          tabelas do main.dol (cores, rotações) com os endereços de origem
Relatório: index/mii-export.json.

Fontes (somente leitura): linuxsports-web-wispt/raw/src/core/shared/Kokeshi/common/RFL_Res.dat,
.../SportsStatic/common/CPUMii/*.rcd e raw/main.dol. Formato documentado em tools/nw4r/rfl.py.
"""
import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r import gx  # noqa: E402
from nw4r.dol import Dol  # noqa: E402
from nw4r.paths import INDEX, RESOURCES, SRC, write_bytes, write_json  # noqa: E402
from nw4r.rfl import SHAPE_ARC, SHPTEX_ARC, TEX_ARC, RflRes, parse_shape, parse_texture, raw_to_info  # noqa: E402

RES_PATH = SRC / 'raw/src/core/shared/Kokeshi/common/RFL_Res.dat'
RCD_DIR = SRC / 'raw/src/core/shared/SportsStatic/common/CPUMii'
OUT = RESOURCES / 'Mii'


def decode_rgba(meta, blob, off):
    fmt, w, h = meta['format'], meta['width'], meta['height']
    rgba = gx.decode(blob, off, w, h, fmt)
    if fmt in (0, 1):  # I4/I8: o GX replica a intensidade em RGBA
        for i in range(0, len(rgba), 4):
            rgba[i + 3] = rgba[i]
    return rgba


def export_textures(res, report):
    metas = {}
    groups = [(k, a, 'part') for k, a in TEX_ARC.items()] + [(k, a, 'shape') for k, a in SHPTEX_ARC.items()]
    for name, arc, group in groups:
        folder = name if group == 'part' else f'{name}_shape'
        items = []
        for i, blob in enumerate(res.parts(arc)):
            meta, off = parse_texture(blob)
            png = gx.png_bytes(meta['width'], meta['height'], decode_rgba(meta, blob, off))
            write_bytes(OUT / 'Textures' / folder / f'{i:02d}.png', png)
            items.append(dict(meta, formatName=gx.FORMAT_NAMES[meta['format']]))
        metas[folder] = items
        report['textures'][folder] = len(items)
    write_json(OUT / 'textures.json', {'wrapModes': {'0': 'clamp', '1': 'repeat', '2': 'mirror'}, 'textures': metas})


def export_shapes(res, report):
    for name, arc in SHAPE_ARC.items():
        parts, empty, worst = [], 0, 1.0
        for i, blob in enumerate(res.parts(arc)):
            s = parse_shape(name, blob)
            if s is None:
                empty += 1
                parts.append(None)
                continue
            worst = min(worst, s['stats']['windingAgreement'])
            parts.append(s)
        write_json(OUT / 'Shapes' / f'{name}.json', {
            'part': name, 'units': 'RFL (posição s16/256, Wii: Y para cima, Z para a frente, destro)',
            'winding': 'anti-horário visto de fora (normais de vértice)', 'parts': parts}, compact=True)
        report['shapes'][name] = {'parts': len(parts), 'empty': empty, 'minWindingAgreement': worst,
                                  'vertices': sum(p['stats']['vertices'] for p in parts if p),
                                  'triangles': sum(p['stats']['triangles'] for p in parts if p)}


def export_profiles(report):
    index = []
    for path in sorted(RCD_DIR.glob('*.rcd')):
        raw = path.read_bytes()
        info = raw_to_info(raw)
        write_json(OUT / 'Profiles' / f'{path.stem}.json',
                   {'id': path.stem, 'source': str(path.relative_to(SRC)), 'raw': base64.b64encode(raw).decode(),
                    'info': info})
        index.append({'id': path.stem, 'name': info['name'], 'sex': info['sex'],
                      'favoriteColor': info['favoriteColor'], 'height': info['height'], 'build': info['build']})
    write_json(OUT / 'profiles.json', {'profiles': index})
    report['profiles'] = len(index)


def export_params(dol):
    """Tabelas de dados do RFL lidas do main.dol (os endereços ficam registrados no JSON)."""
    tables = {
        'facelineColor': (0x80380F78, 6), 'hairColor': (0x80380F90, 8), 'beardColor': (0x80380FB0, 8),
        'glassColor': (0x80380FD0, 6), 'favoriteColor': (0x80380FE8, 12), 'eyeColor': (0x80381090, 6),
        'eyebrowColor2D': (0x803810A8, 8), 'mouthColorDark': (0x803810C8, 3), 'mouthColorLip': (0x803810D4, 3),
        'mustacheColor2D': (0x803810E0, 8),
    }
    out = {'source': 'raw/main.dol', 'colors': {}, 'addresses': {}}
    for k, (va, n) in tables.items():
        out['colors'][k] = dol.rgba(va, n)
        out['addresses'][k] = f'{va:#010x}'
    out['eyeRotateOffset'] = list(dol.read(0x80381040, 50))      # RFLiSetFaceParts / RFLiMakeTexture
    out['eyebrowRotateOffset'] = list(dol.read(0x80381078, 24))
    out['addresses'].update(eyeRotateOffset='0x80381040', eyebrowRotateOffset='0x80381078')
    # Cor do contorno do olho (RFLiSetTev4Eye): tipo 9 e tipo 20 têm cor própria.
    out['eyeOutline'] = {'default': list(dol.read(0x804C7A20 - 0x65B0, 4)), '9': list(dol.read(0x804C7A20 - 0x65B8, 4)),
                         '20': list(dol.read(0x804C7A20 - 0x65B4, 4))}
    out['moleColor'] = list(dol.read(0x804C7A20 - 0x65D8, 4))
    write_json(OUT / 'rfl_params.json', out)


def main():
    res = RflRes(RES_PATH.read_bytes())
    report = {'source': str(RES_PATH.relative_to(SRC)), 'archives': len(res.offsets), 'shapes': {}, 'textures': {}}
    export_shapes(res, report)
    export_textures(res, report)
    export_profiles(report)
    export_params(Dol())
    write_json(INDEX / 'mii-export.json', report)
    print(f"formas: {sum(v['parts'] - v['empty'] for v in report['shapes'].values())} · "
          f"texturas: {sum(report['textures'].values())} · perfis: {report['profiles']}")


if __name__ == '__main__':
    main()
