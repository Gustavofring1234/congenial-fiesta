"""Caminhos entre linuxsports-web-wispt/ e a pasta legada linuxsports-web/ (somente leitura).

A cópia wispt renomeou segmentos de caminho (ALTERACOES.json, campo `renames`):
RPSportsTitle -> RPST e WiiSports -> WiSpt/wispt. Os .brres/.breff só existem na pasta legada,
com os nomes originais; legacy_file() desfaz essas trocas até achar o arquivo.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEGACY = ROOT.parent / 'linuxsports-web'
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
