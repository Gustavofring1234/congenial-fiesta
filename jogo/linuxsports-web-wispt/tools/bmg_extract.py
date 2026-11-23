#!/usr/bin/env python3
"""Extrai as mensagens .bmg (MESGbmg1, NW4R) para JSON usado pelo TextManager do viewer.

Formato (big-endian): cabeçalho de 0x20 bytes ("MESGbmg1", tamanho, nº de seções, codificação
em 0x10: 1 = CP1252, 2 = UTF-16BE, 3 = Shift-JIS, 4 = UTF-8) e seções:
  INF1: u16 n | u16 tamanho da entrada | u32 | n × (u32 offset em DAT1 + atributos)
  DAT1: textos terminados em 0; escape 0x1A: [0x1A][u8 tam. total em bytes][u8 grupo][u16 tipo][parâmetros]
  MID1: u16 n | u8 formato | u8 info | u32 | n × u32 id
Tags de escape vistas neste jogo:
  grupo 0  inserção de valor: tipo 0 = número/texto, tipo 1 = nome do Mii  -> viram {0}, {1}, ... no texto
  grupo 2  controle da janela (ex.: 2:0 fecha após N quadros)              -> `controls`
  grupo 255 formatação (cor/escala)                                         -> `controls`

Saída: assets/text/<idioma>/<arquivo>.text.json e entrada 'text' em index/text-index.json.
Uso: python3 tools/bmg_extract.py [arquivos .bmg ...]   (padrão: raw/src/core/shared/Message/*/*.bmg)
"""
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENCODINGS = {1: 'cp1252', 2: 'utf-16-be', 3: 'shift_jis', 4: 'utf-8'}
ARG_KIND = {0: 'value', 1: 'name'}


def sections(d):
    out, o = {}, 0x20
    while o + 8 <= len(d):
        magic = d[o:o + 4].decode('latin1')
        size, = struct.unpack_from('>I', d, o + 4)
        if size == 0:
            break
        out[magic] = o
        o += size
    return out


def read_message(d, p, enc):
    """Lê um texto a partir de p -> (texto com {n}, args, controls)."""
    unit = 2 if enc == 'utf-16-be' else 1
    text, args, controls, buf = [], [], [], bytearray()

    def flush():
        if buf:
            s = buf.decode(enc, 'replace')
            if '{' in s or '}' in s:
                raise ValueError(f'chave literal no texto ({s!r}); o formato {{n}} seria ambíguo')
            text.append(s)
            buf.clear()

    while p + unit <= len(d):
        c = int.from_bytes(d[p:p + unit], 'big')
        if c == 0:
            break
        if c == 0x1A:
            flush()
            size, group = d[p + unit], d[p + unit + 1]
            kind, = struct.unpack_from('>H', d, p + unit + 2)
            params = d[p + unit + 4:p + size].hex()
            if group == 0:
                text.append('{%d}' % len(args))
                args.append(ARG_KIND.get(kind, f'type{kind}'))
            else:
                controls.append({'group': group, 'type': kind, 'params': params, 'at': len(''.join(text))})
            p += size
            continue
        buf += d[p:p + unit]
        p += unit
    flush()
    return ''.join(text), args, controls


def extract(path):
    d = path.read_bytes()
    if d[:8] != b'MESGbmg1':
        raise ValueError(f'{path}: não é MESGbmg1')
    enc = ENCODINGS.get(d[0x10])
    if not enc:
        raise ValueError(f'{path}: codificação {d[0x10]} desconhecida')
    secs = sections(d)
    inf, dat = secs['INF1'], secs['DAT1'] + 8
    n, entry_size = struct.unpack_from('>HH', d, inf + 8)
    mids = []
    if 'MID1' in secs:
        mn, = struct.unpack_from('>H', d, secs['MID1'] + 8)
        mids = list(struct.unpack_from('>%dI' % mn, d, secs['MID1'] + 16))
    messages = []
    for i in range(n):
        e = inf + 16 + i * entry_size
        off, = struct.unpack_from('>I', d, e)
        text, args, controls = read_message(d, dat + off, enc)
        mid = mids[i] if i < len(mids) else None
        # o id é o valor u32 da MID1 inteiro (único e crescente nos dois arquivos)
        msg = {'index': i, 'id': mid if mid is not None else i, 'text': text}
        if args:
            msg['args'] = args
        if controls:
            msg['controls'] = controls
        attrs = d[e + 4:e + entry_size].hex()
        if attrs.strip('0'):
            msg['attrs'] = attrs
        messages.append(msg)
    return {'encoding': enc, 'messages': messages}


def main(argv):
    files = [Path(a) for a in argv] or sorted((ROOT / 'raw/src/core/shared/Message').glob('*/*.bmg'))
    index = []
    for f in files:
        f = f.resolve()
        lang, name = f.parent.name, f.stem
        data = extract(f)
        ids = [m['id'] for m in data['messages']]
        dup = len(ids) - len(set(ids))
        out = {
            'format': 'nw4r-text', 'version': 1, 'source': f.relative_to(ROOT).as_posix(),
            'language': lang, 'file': name, **data,
        }
        dest = ROOT / 'assets/text' / lang / f'{name}.text.json'
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        nonempty = sum(1 for m in data['messages'] if m['text'])
        index.append({'language': lang, 'file': name, 'path': dest.relative_to(ROOT).as_posix(),
                      'messages': len(ids), 'nonEmpty': nonempty, 'duplicateIds': dup})
        print(f'{dest.relative_to(ROOT)}: {len(ids)} mensagens ({nonempty} com texto, {dup} ids repetidos)')
    (ROOT / 'index/text-index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
