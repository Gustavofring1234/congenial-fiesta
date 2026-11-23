#!/usr/bin/env python3
"""Cliente mínimo da Gemini API (generateContent), só biblioteca padrão.

A chave vem de GEMINI_API_KEY no ambiente ou no arquivo .env da raiz do projeto
(veja .env.example). Enquanto a chave for o marcador "INSIRA_SUA_CHAVE_AQUI", as chamadas
falham com GeminiNotConfigured, sem tocar a rede.

Uso:
  python3 tools/gemini_client.py ping
  python3 tools/gemini_client.py ask "pergunta livre"
  python3 tools/gemini_client.py rename NOME|ENDERECO   # sugere nome/assinatura para uma função de decompiled.c
Respostas de `rename` ficam em cache em tools/.cache/gemini/ (uma por função).
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLACEHOLDER = 'INSIRA_SUA_CHAVE_AQUI'
ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
CACHE = ROOT / 'tools/.cache/gemini'


class GeminiNotConfigured(RuntimeError):
    pass


class GeminiError(RuntimeError):
    pass


def _dotenv():
    env = {}
    p = ROOT / '.env'
    if p.exists():
        for line in p.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def config():
    file_env = _dotenv()
    get = lambda k, d=None: os.environ.get(k) or file_env.get(k) or d  # noqa: E731
    return {'key': get('GEMINI_API_KEY', PLACEHOLDER), 'model': get('GEMINI_MODEL', 'gemini-flash-latest')}


def is_configured():
    k = config()['key']
    return bool(k) and k != PLACEHOLDER


RETRYABLE = {429, 500, 503}


def generate(prompt, *, system=None, json_output=False, temperature=0.2, timeout=120, retries=4):
    """Envia um prompt e devolve o texto (ou o objeto JSON, com json_output=True).

    Repete com espera exponencial (2, 4, 8, 16 s) em 429/500/503 e em timeout."""
    for attempt in range(retries + 1):
        try:
            return _generate_once(prompt, system, json_output, temperature, timeout)
        except _Retryable as e:
            if attempt == retries:
                raise GeminiError(str(e)) from None
            time.sleep(2 ** (attempt + 1))


class _Retryable(Exception):
    pass


def _generate_once(prompt, system, json_output, temperature, timeout):
    cfg = config()
    if not is_configured():
        raise GeminiNotConfigured('GEMINI_API_KEY não definida (preencha .env ou a variável de ambiente)')
    body = {
        'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
        'generationConfig': {'temperature': temperature},
    }
    if system:
        body['systemInstruction'] = {'parts': [{'text': system}]}
    if json_output:
        body['generationConfig']['responseMimeType'] = 'application/json'
    req = urllib.request.Request(
        ENDPOINT.format(model=cfg['model']), data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'x-goog-api-key': cfg['key']}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:500]
        raise (_Retryable if e.code in RETRYABLE else GeminiError)(f'HTTP {e.code}: {detail}') from None
    except TimeoutError:
        raise _Retryable(f'sem resposta em {timeout} s') from None
    except urllib.error.URLError as e:
        raise GeminiError(f'falha de rede: {e.reason}') from None
    try:
        text = ''.join(p.get('text', '') for p in data['candidates'][0]['content']['parts'])
    except (KeyError, IndexError):
        raise GeminiError(f'resposta sem texto: {json.dumps(data)[:500]}') from None
    return json.loads(text) if json_output else text


RENAME_SYSTEM = (
    'Você analisa funções C descompiladas pelo Ghidra de um executável PowerPC de Wii (SDK NW4R/EGG/RVL). '
    'Responda só JSON com as chaves: name (identificador C sugerido), signature (protótipo C), '
    'summary (uma frase em português), params (objeto param_N -> nome), confidence (0..1).')


def suggest_rename(key, *, use_cache=True):
    """Sugere nome e assinatura para uma função de decompiled.c (lida só no intervalo dela)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import decomp_index as di
    func = di.lookup(key)
    if not func:
        raise KeyError(f'função não encontrada: {key}')
    src = di.source(func)
    digest = hashlib.sha1(src.encode()).hexdigest()[:12]
    cache = CACHE / f"{func['addr']}_{digest}.json"
    if use_cache and cache.exists():
        return json.loads(cache.read_text())
    strings = '\n'.join(f'{a}\t{t}' for a, t in di.strings(r'.') if a.lower() in src.lower())[:4000]
    prompt = f"Função {func['name']} @ {func['addr']}:\n```c\n{src[:60000]}\n```\n"
    if strings:
        prompt += f'Strings referenciadas:\n{strings}\n'
    out = generate(prompt, system=RENAME_SYSTEM, json_output=True)
    out.update({'addr': func['addr'], 'original': func['name']})
    CACHE.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    return out


def main(argv):
    if not argv or argv[0] not in ('ping', 'ask', 'rename'):
        print(__doc__)
        return 2
    try:
        if argv[0] == 'ping':
            print(f"modelo {config()['model']}: {generate('Responda apenas: ok').strip()}")
        elif argv[0] == 'ask':
            print(generate(' '.join(argv[1:])))
        else:
            print(json.dumps(suggest_rename(argv[1]), ensure_ascii=False, indent=1))
    except (GeminiNotConfigured, GeminiError, KeyError) as e:
        print(f'erro: {e}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
