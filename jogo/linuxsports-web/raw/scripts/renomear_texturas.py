#!/usr/bin/env python3
"""Renomeia texturas PNG de textures/ para assets/textures/<categoria>/<nome_snake>.png.

Os nomes vêm da TRADUÇÃO do nome original do arquivo (abreviações em inglês + romaji
japonês) feita pela API Gemini em modo texto, sem enviar as imagens.
Uso: GEMINI_API_KEY=... python3 scripts/renomear_texturas.py [--dry-run] [--cache ARQ] [--map ARQ]
"""
import argparse, hashlib, json, os, re, shutil, sys, time, urllib.request, urllib.error

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIGEM, DESTINO = "textures", os.path.join("assets", "textures")
MODELO = "gemini-flash-lite-latest"
CATEGORIA = {"RPBowScene": "bowling", "RPBoxScene": "boxing", "RPBsbScene": "baseball",
             "RPGolScene": "golf", "RPTnsScene": "tennis", "RPSportsPhysical": "fitness",
             "RPSportsTrainingMenu": "training", "Kokeshi": "avatars", "SportsStatic": "ui_common",
             "RPCommon": "ui_common", "RPSportsCommon": "ui_common", "RPSportsTitle": "ui_common"}
INSTRUCAO = """You translate texture file names from a Wii sports game into descriptive English snake_case.
Names mix English abbreviations and Japanese romaji. Hints: glf=golf, bbl=baseball, tns=tennis,
bwg/bow=bowling, box=boxing, ava=avatar, kiwa=edge, gara=pattern, jimen=ground, hayasi=forest,
iwa=rock, nami=wave, namiichi=wave_position, hukidasi=speech_bubble, tokosen=boundary_line, shiba=grass,
nuime=seam, dammy/dummy=placeholder, env=environment_map, lm=lightmap, ind=indirect_map, tex=texture,
"model__material" means material of that model; ist/te/tm/sm/ht/pic are UI layout prefixes (picture/text panes).
Rules: 2-6 words, lowercase [a-z0-9_] only, KEEP trailing variant/number suffixes (e.g. _00, .3 -> _3, _a, _r)
so names stay distinct; ALSO keep model/variant codes such as A0, B1, C2, fc1, fc9, E3 (e.g. glf_course_fc9 -> golf_course_9_..., ava_bodyA0 -> avatar_body_a0_...); include the sport when it is evident. Return ONLY a JSON object {"original": "translation"}
with every input name as a key."""

def snake(s):
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s)
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s).strip("_").lower()
    return re.sub(r"_+", "_", s)[:60] or "textura"

def gemini(chave, nomes):
    corpo = {"contents": [{"parts": [{"text": INSTRUCAO + "\n\nNames:\n" + "\n".join(nomes)}]}],
             "generationConfig": {"temperature": 0, "responseMimeType": "application/json"}}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODELO}:generateContent"
    for tentativa in range(6):
        try:
            req = urllib.request.Request(url, json.dumps(corpo).encode(),
                                         {"Content-Type": "application/json", "x-goog-api-key": chave})
            d = json.load(urllib.request.urlopen(req, timeout=180))
            return json.loads(d["candidates"][0]["content"]["parts"][0]["text"])
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(min(60, 5 * 2 ** tentativa)); continue
            raise
        except (json.JSONDecodeError, KeyError, urllib.error.URLError, TimeoutError):
            time.sleep(5)
    return {}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--cache", default="nome_cache.json")
    ap.add_argument("--map", default="map_texturas.json")
    ap.add_argument("--lote", type=int, default=150)
    a = ap.parse_args()
    os.chdir(RAIZ)
    chave = os.environ.get("GEMINI_API_KEY")
    if not chave:
        sys.exit("defina GEMINI_API_KEY")

    grupos = {}  # sha256 -> [caminhos]
    for raiz, _, arqs in os.walk(ORIGEM):
        for n in sorted(arqs):
            if n.lower().endswith(".png"):
                p = os.path.join(raiz, n)
                grupos.setdefault(hashlib.sha256(open(p, "rb").read()).hexdigest(), []).append(p)
    for v in grupos.values():
        v.sort()
    stems = sorted({os.path.splitext(os.path.basename(v[0]))[0] for v in grupos.values()})
    cache = json.load(open(a.cache)) if os.path.exists(a.cache) else {}
    faltam = [s for s in stems if s not in cache]
    if a.dry_run:
        faltam = faltam[:40]
    print(f"{sum(map(len, grupos.values()))} PNGs, {len(grupos)} únicos, {len(stems)} nomes, {len(faltam)} a traduzir")
    for i in range(0, len(faltam), a.lote):
        lote = faltam[i:i + a.lote]
        res = gemini(chave, lote)
        for s in lote:
            t = res.get(s)
            if isinstance(t, str) and snake(t):
                cache[s] = snake(t)
        json.dump(cache, open(a.cache, "w"), indent=1, ensure_ascii=False)
        print(f"  lote {i // a.lote + 1}: {sum(s in cache for s in lote)}/{len(lote)}")
        time.sleep(2)
    if a.dry_run:
        for s in faltam:
            print(f"  {s} -> {cache.get(s, '(fallback) ' + snake(s))}")
        return

    usados, mapa = set(), []
    for sha, caminhos in sorted(grupos.items(), key=lambda kv: kv[1][0]):
        rep = caminhos[0]
        partes = rep.split(os.sep)
        cat = CATEGORIA.get(partes[2] if len(partes) > 2 else "", "misc")
        stem = os.path.splitext(os.path.basename(rep))[0]
        nome, fonte = (cache[stem], "gemini_texto") if stem in cache else (snake(stem), "fallback")
        novo, k = os.path.join(DESTINO, cat, nome + ".png"), 2
        while novo in usados:
            novo, k = os.path.join(DESTINO, cat, f"{nome}_{k}.png"), k + 1
        usados.add(novo)
        os.makedirs(os.path.dirname(novo), exist_ok=True)
        shutil.move(rep, novo)
        for p in caminhos:
            if p != rep:
                os.remove(p)  # cópia idêntica (mesmo sha256)
            mapa.append({"antigo": p, "novo": novo, "sha256": sha, "nome_material_original": stem,
                         "duplicata": p != rep, "fonte_nome": fonte})
    for raiz, dirs, arqs in os.walk(ORIGEM, topdown=False):
        if not os.listdir(raiz):
            os.rmdir(raiz)
    json.dump(mapa, open(a.map, "w"), indent=1, ensure_ascii=False)
    print(f"movidos {len(grupos)} arquivos únicos; {len(mapa)} entradas no mapa; "
          f"fallback {sum(e['fonte_nome'] == 'fallback' and not e['duplicata'] for e in mapa)}")

if __name__ == "__main__":
    main()
