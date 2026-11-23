#!/usr/bin/env python3
"""Traduz os textos do jogo (.bmg 'us') para os outros idiomas do WEBC (pt, ja), OFFLINE, pela Gemini API.

A chave vem só de os.getenv("GEMINI_API_KEY") (tools/gemini_client.py); nada é gravado com a chave e o
navegador nunca a vê: o resultado são JSON estáticos lidos pelo minigames/sports/ui/TextManager.js.

Entrada : minigames/sports/assets/Text/us/<arquivo>.text.json (tools/stage_web_assets.py)
Saída   : minigames/sports/assets/Text/<idioma>/<arquivo>.text.json (mesmo formato; só mensagens traduzidas)
          + entradas novas em Text/text_index.json
Regras  : {0}, {1}... e quebras de linha são preservados; uma tradução que perde ou inventa marcador é
          descartada (o TextManager cai no inglês). Respostas ficam em cache (tools/.cache/translate/), então
          rodar de novo só pede o que falta.

Uso: python3 tools/translate_texts.py pt ja [--batch 60] [--dry-run]
"""
import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

os.environ.setdefault('NW4R_TARGET', 'web')
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gemini_client  # noqa: E402
from nw4r.paths import ASSETS, OUT, write_json  # noqa: E402

TEXT = ASSETS / 'Text'
CACHE = OUT / 'tools/.cache/translate'
NAMES = {'pt': 'português do Brasil', 'ja': 'japonês'}
MARK = re.compile(r'\{\d+\}')

SYSTEM = ('Você traduz textos de interface de um jogo de esportes (tênis, boliche, golfe, beisebol, boxe) do inglês. '
          'Responda só JSON: um objeto {"<índice>": "<tradução>"}. Preserve exatamente os marcadores {0}, {1}... e as '
          'quebras de linha (\\n). Textos curtos de botão continuam curtos. Termos esportivos na forma usual do idioma.')


def batches(items, n):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def translate_batch(lang, file, chunk, dry):
    payload = {str(m['index']): m['text'] for m in chunk}
    key = hashlib.sha256(json.dumps([lang, file, payload], ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]
    cache = CACHE / f'{key}.json'
    if cache.exists():
        return json.loads(cache.read_text(encoding='utf-8'))
    if dry:
        return {}
    prompt = f'Traduza para {NAMES[lang]}:\n' + json.dumps(payload, ensure_ascii=False, indent=0)
    out = json.loads(gemini_client.generate(prompt, system=SYSTEM, json_output=True, temperature=0.2))
    CACHE.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    return out


def valid(src, dst):
    return isinstance(dst, str) and dst.strip() and sorted(MARK.findall(src)) == sorted(MARK.findall(dst))


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('languages', nargs='+', choices=sorted(NAMES))
    ap.add_argument('--batch', type=int, default=60)
    ap.add_argument('--dry-run', action='store_true', help='usa só o cache, sem rede')
    args = ap.parse_args(argv)
    if not args.dry_run and not gemini_client.is_configured():
        print('GEMINI_API_KEY não está no ambiente (veja .env.example). Nada foi pedido.', file=sys.stderr)
        return 2
    index_path = TEXT / 'text_index.json'
    index = json.loads(index_path.read_text(encoding='utf-8'))
    sources = [e for e in index['bmg'] if e['language'] == 'us']
    report = {}
    for lang in args.languages:
        for e in sources:
            doc = json.loads((ASSETS / e['path']).read_text(encoding='utf-8'))
            todo = [m for m in doc['messages'] if m.get('text')]
            done, rejected = {}, 0
            for chunk in batches(todo, args.batch):
                got = translate_batch(lang, e['file'], chunk, args.dry_run)
                for m in chunk:
                    t = got.get(str(m['index']))
                    if valid(m['text'], t):
                        done[m['index']] = t
                    elif t is not None:
                        rejected += 1
            msgs = [{**m, 'text': done[m['index']]} for m in doc['messages'] if m['index'] in done]
            dst = TEXT / lang / f"{e['file']}.text.json"
            write_json(dst, {**{k: v for k, v in doc.items() if k != 'messages'}, 'language': lang,
                             'translatedFrom': 'us', 'messages': msgs})
            index['bmg'] = [x for x in index['bmg'] if not (x['language'] == lang and x['file'] == e['file'])]
            index['bmg'].append({'language': lang, 'file': e['file'], 'path': dst.relative_to(ASSETS).as_posix(),
                                 'messages': len(msgs), 'nonEmpty': len(msgs), 'duplicateIds': 0, 'translated': True})
            report[f"{lang}/{e['file']}"] = {'source': len(todo), 'translated': len(msgs), 'rejected': rejected}
    write_json(index_path, index)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
