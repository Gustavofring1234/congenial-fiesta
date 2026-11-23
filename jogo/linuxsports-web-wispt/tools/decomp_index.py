#!/usr/bin/env python3
"""Índice do código descompilado (raw/src/core/decompiled/).

decompiled.c tem 14,7 MB; nunca é lido inteiro na memória de quem consulta. Este script
varre o arquivo uma vez, em streaming, e grava index/decompiled-index.json com o intervalo
de bytes de cada função (os blocos começam com `// ===== nome @ endereço =====`), unido aos
metadados de functions.tsv (tamanho, nº de chamadores e chamados).

Uso:
  python3 tools/decomp_index.py build                 # (re)gera o índice
  python3 tools/decomp_index.py find PADRAO           # funções cujo nome casa com a regex
  python3 tools/decomp_index.py show NOME|ENDERECO    # imprime só o corpo dessa função
  python3 tools/decomp_index.py strings PADRAO        # strings.tsv filtrado (endereço, texto)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DECOMP = ROOT / 'raw/src/core/decompiled'
INDEX = ROOT / 'index/decompiled-index.json'
HEADER = re.compile(rb'^// ===== (.+?) @ ([0-9a-fA-F]{8}) =====\s*$')


def build():
    meta = {}
    with open(DECOMP / 'functions.tsv', encoding='utf-8') as f:
        next(f)
        for line in f:
            entry, name, size, callers, callees = line.rstrip('\n').split('\t')
            meta[entry.lower()] = {'size': int(size), 'callers': int(callers), 'callees': int(callees)}
    funcs, cur, pos = [], None, 0
    with open(DECOMP / 'decompiled.c', 'rb') as f:
        for line in f:
            m = HEADER.match(line)
            if m:
                if cur:
                    cur['end'] = pos
                    funcs.append(cur)
                addr = m.group(2).decode().lower()
                cur = {'name': m.group(1).decode('utf-8', 'replace'), 'addr': addr, 'start': pos, **meta.get(addr, {})}
            pos += len(line)
    if cur:
        cur['end'] = pos
        funcs.append(cur)
    INDEX.write_text(json.dumps({'source': 'raw/src/core/decompiled/decompiled.c', 'functions': funcs}, separators=(',', ':')))
    return funcs


def load():
    if not INDEX.exists():
        build()
    return json.loads(INDEX.read_text())['functions']


def find(pattern):
    rx = re.compile(pattern, re.I)
    return [f for f in load() if rx.search(f['name']) or rx.fullmatch(f['addr'])]


def lookup(key):
    key = key.lower().removeprefix('0x')
    for f in load():
        if f['addr'] == key or f['name'].lower() == key:
            return f
    return None


def source(func):
    """Corpo de uma função (lê só o intervalo de bytes dela)."""
    with open(DECOMP / 'decompiled.c', 'rb') as f:
        f.seek(func['start'])
        return f.read(func['end'] - func['start']).decode('utf-8', 'replace')


def strings(pattern):
    rx = re.compile(pattern, re.I)
    out = []
    with open(DECOMP / 'strings.tsv', encoding='utf-8', errors='replace') as f:
        for line in f:
            addr, _, text = line.rstrip('\n').partition('\t')
            if rx.search(text):
                out.append((addr, text))
    return out


def main(argv):
    if not argv or argv[0] not in ('build', 'find', 'show', 'strings'):
        print(__doc__)
        return 2
    cmd, arg = argv[0], (argv[1] if len(argv) > 1 else '')
    if cmd == 'build':
        print(f'{len(build())} funções indexadas em {INDEX.relative_to(ROOT)}')
    elif cmd == 'find':
        for f in find(arg):
            print(f"{f['addr']}\t{f['name']}\t{f.get('size', '?')}B\tcallers={f.get('callers', '?')}")
    elif cmd == 'show':
        f = lookup(arg)
        if not f:
            print(f'função não encontrada: {arg}', file=sys.stderr)
            return 1
        print(source(f))
    else:
        for addr, text in strings(arg):
            print(f'{addr}\t{text}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
