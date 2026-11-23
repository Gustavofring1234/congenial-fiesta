"""Caminhos do pipeline offline.

Pastas de ORIGEM (somente leitura, nunca escritas por estes scripts):
  SRC    = ../linuxsports-web-wispt  (cenas, .glb, layouts, texturas, textos, código descompilado, .breft, RFL/.rcd)
  LEGACY = ../linuxsports-web        (única fonte dos .brres e .breff)
Pasta de SAÍDA, escolhida por NW4R_TARGET (padrão: web):
  web   -> minigames/sports/assets/  (WEBC, Three.js 0.180: referencial do Wii = referencial do glTF/three,
           tudo relativo a uma raiz só: Models/, Textures/, Collision/, Animations/, Scenes/, UI/, Text/, Effects/...)
  unity -> Assets/ (projeto Unity legado: StreamingAssets/, Resources/, Nw4r/)
Relatórios em index/ nos dois casos.

A cópia wispt renomeou segmentos de caminho (ALTERACOES.json, campo `renames`):
RPSportsTitle -> RPST e WiiSports -> WiSpt/wispt. legacy_file() desfaz essas trocas.
"""
import json
import os
from pathlib import Path

OUT = Path(__file__).resolve().parents[2]
SRC = OUT.parent / 'linuxsports-web-wispt'
LEGACY = OUT.parent / 'linuxsports-web'

TARGET = os.getenv('NW4R_TARGET', 'web').strip().lower()
if TARGET not in ('web', 'unity'):
    raise SystemExit(f'NW4R_TARGET inválido: {TARGET!r} (use web ou unity)')
WEB = OUT / 'minigames' / 'sports' / 'assets'
if TARGET == 'web':
    ASSETS = STREAMING = RESOURCES = NW4R = WEB   # uma raiz só; os caminhos nos JSON são relativos a ela
else:
    ASSETS = OUT / 'Assets'
    STREAMING = ASSETS / 'StreamingAssets'
    RESOURCES = ASSETS / 'Resources'
    NW4R = ASSETS / 'Nw4r'       # assets importados pelo Editor (.glb, texturas de material)
INDEX = OUT / 'index'            # relatórios do pipeline

REVERSE_RENAMES = [('RPST', 'RPSportsTitle'), ('rpst', 'rpsportstitle'),
                   ('WISPT', 'WIISPORTS'), ('WiSpt', 'WiiSports'), ('wiSpt', 'wiiSports'), ('wispt', 'wiisports')]


def legacy_file(rel, legacy=LEGACY):
    """Arquivo da pasta legada para um caminho (relativo a raw/) citado nos JSON do wispt."""
    candidates = [rel]
    for new, old in REVERSE_RENAMES:
        candidates += [c.replace(new, old) for c in candidates if new in c]
    for c in candidates:
        p = Path(legacy) / 'raw' / c
        if p.exists():
            return p
    raise FileNotFoundError(f'{rel} não existe em {legacy}/raw (tentados: {len(candidates)} nomes)')


def write_json(path, obj, compact=False):
    """Grava JSON UTF-8 criando as pastas. Nunca aceita destino fora de OUT."""
    path = Path(path).resolve()
    if OUT not in path.parents:
        raise PermissionError(f'saída fora de linuxsports-codigo-novo: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, separators=(',', ':')) if compact else json.dumps(obj, ensure_ascii=False, indent=1)
    path.write_text(text + '\n', encoding='utf-8')
    return path


def write_bytes(path, data):
    path = Path(path).resolve()
    if OUT not in path.parents:
        raise PermissionError(f'saída fora de linuxsports-codigo-novo: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def manifest():
    """manifest.json do wispt indexado por assetId."""
    m = json.loads((SRC / 'manifest.json').read_text(encoding='utf-8'))
    return {a['assetId']: a for a in m['assets']}
