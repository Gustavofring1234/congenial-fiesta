#!/usr/bin/env python3
"""Valida as saídas geradas contra os campos que os parsers C# esperam.

Só biblioteca padrão. Não altera as saídas: imprime um resumo por verificação
e grava um relatório JSON pequeno em index/validate-outputs.json.
Sai com 1 se houver violações, senão 0.
"""
import base64, binascii, glob, json, math, os, sys
from collections import Counter

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(R, "Assets")
SA = os.path.join(A, "StreamingAssets")
RES = os.path.join(A, "Resources")
RELATORIO = os.path.join(R, "index", "validate-outputs.json")
NOMES = ["1_manifesto", "2_animacoes", "3_modelos", "4_cenas", "5_ui", "6_efeitos", "7_texto", "8_mii",
         "9_ambiente", "10_audio", "11_jogabilidade"]
TIPOS_ANIM = {"CHR0", "SRT0", "PAT0", "CLR0", "VIS0", "SHP0", "SCN0"}
INFO = {"structural": 0}
violacoes = []  # pares (verificacao, "arquivo: mensagem")


def erro(v, arq, msg):
    """Registra violação no formato 'arquivo: mensagem' (caminho relativo a R)."""
    violacoes.append((v, f"{os.path.relpath(arq, R).replace(os.sep, '/')}: {msg}"))


def get(o, k):
    """Lê uma chave de um dict; None se o objeto não for dict."""
    return o.get(k) if isinstance(o, dict) else None


def carregar(v, caminho):
    """Lê um JSON; registra erro e devolve {} se não puder ser lido."""
    try:
        with open(caminho, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        erro(v, caminho, f"JSON inválido ou ilegível ({e})")
        return {}


def lista(v, pai, k, arq, ctx=""):
    """Devolve pai[k] se for lista; senão registra erro e devolve []."""
    x = get(pai, k)
    if not isinstance(x, list):
        erro(v, arq, f"{ctx}'{k}' ausente ou não é lista")
        return []
    return x


def existe(v, arq, base, caminho, ctx):
    """Registra erro se caminho (relativo a base) não for arquivo existente."""
    if not isinstance(caminho, str) or not os.path.isfile(os.path.join(base, caminho)):
        erro(v, arq, f"{ctx}: arquivo '{caminho}' não existe")


def e_num(x):
    """Número finito; bool não conta."""
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def e_int(x):
    """Inteiro; bool não conta."""
    return isinstance(x, int) and not isinstance(x, bool)


def nums(x, n):
    """Lista de exatamente n números finitos."""
    return isinstance(x, list) and len(x) == n and all(e_num(y) for y in x)


def ints(x, n):
    """Lista de exatamente n inteiros."""
    return isinstance(x, list) and len(x) == n and all(e_int(y) for y in x)


def nao_finito(o):
    """Verdadeiro se houver NaN ou infinito na estrutura."""
    if isinstance(o, float):
        return not math.isfinite(o)
    vals = o.values() if isinstance(o, dict) else o if isinstance(o, list) else []
    return any(nao_finito(x) for x in vals)


def tamanho_b64(s):
    """Tamanho em bytes de base64 válido, ou None."""
    try:
        return len(base64.b64decode(s, validate=True)) if isinstance(s, str) else None
    except (binascii.Error, ValueError):
        return None


def trilha_ok(t):
    """Trilha const (value), hermite (keys com frames não decrescentes) ou linear (values)."""
    tipo = get(t, "type")
    if tipo == "const":
        return e_num(get(t, "value"))
    if tipo == "hermite":
        ks = get(t, "keys")
        return isinstance(ks, list) and all(nums(k, 3) for k in ks) and all(
            ks[i][0] <= ks[i + 1][0] for i in range(len(ks) - 1))
    if tipo == "linear":
        return isinstance(get(t, "values"), list) and all(e_num(x) for x in t["values"])
    return False


def valida_anim(tipo, d, arq, nf):
    """Valida o conteúdo de uma animação conforme o tipo; nf é frames (int) ou None."""
    V = "2_animacoes"
    if tipo == "CHR0":
        for i, b in enumerate(lista(V, d, "bones", arq)):
            if not isinstance(get(b, "bone"), str):
                erro(V, arq, f"bones[{i}] sem 'bone' textual")
            for canal in ("scale", "rotate", "translate"):
                c = get(b, canal)
                if c is not None and (not isinstance(c, list) or len(c) != 3 or not all(map(trilha_ok, c))):
                    erro(V, arq, f"bones[{i}].{canal}: deve ser null ou 3 trilhas válidas")
    elif tipo == "SRT0":
        for i, m in enumerate(lista(V, d, "materials", arq)):
            for j, tx in enumerate(lista(V, m, "textures", arq, f"materials[{i}] ")):
                for k, val in (tx.items() if isinstance(tx, dict) else []):
                    if isinstance(val, dict) and "type" in val and not trilha_ok(val):
                        erro(V, arq, f"materials[{i}].textures[{j}].{k}: trilha inválida")
    elif tipo == "CLR0":
        for i, m in enumerate(lista(V, d, "materials", arq)):
            for j, t in enumerate(lista(V, m, "targets", arq, f"materials[{i}] ")):
                fr = get(t, "frames")
                ok = ints(get(t, "const"), 4) if get(t, "const") is not None else (
                    isinstance(fr, list) and all(ints(x, 4) for x in fr) and nf is not None and len(fr) == nf + 1)
                if not ok:
                    erro(V, arq, f"materials[{i}].targets[{j}]: 'const' (4 int) ou 'frames' (frames+1) inválido")
    elif tipo == "PAT0":
        for i, m in enumerate(lista(V, d, "materials", arq)):
            for j, s in enumerate(lista(V, m, "slots", arq, f"materials[{i}] ")):
                if get(s, "const") is None and not isinstance(get(s, "keys"), list):
                    erro(V, arq, f"materials[{i}].slots[{j}]: sem 'const' nem 'keys'")
    elif tipo == "VIS0":
        for i, b in enumerate(lista(V, d, "bones", arq)):
            fr = get(b, "frames")
            if not (isinstance(get(b, "const"), bool) or (isinstance(fr, list) and nf is not None
                    and len(fr) == nf + 1 and all(isinstance(x, bool) for x in fr))):
                erro(V, arq, f"bones[{i}]: 'const' booleano ou 'frames' booleanos (frames+1) exigido")
    elif tipo == "SHP0":
        for i, sh in enumerate(lista(V, d, "shapes", arq)):
            for j, tg in enumerate(lista(V, sh, "targets", arq, f"shapes[{i}] ")):
                if not trilha_ok(get(tg, "weight")):
                    erro(V, arq, f"shapes[{i}].targets[{j}].weight: trilha inválida")
    elif tipo == "SCN0":
        for k in ("cameras", "lights", "ambients"):
            lista(V, d, k, arq)


def verifica_manifesto():
    """Verifica animations_manifest.json e devolve as entradas de animação."""
    V = "1_manifesto"
    arq = os.path.join(SA, "animations_manifest.json")
    m = carregar(V, arq)
    if get(m, "format") != "nw4r-animations-manifest":
        erro(V, arq, f"format inesperado: {get(m, 'format')!r}")
    anims = lista(V, m, "animations", arq)
    if get(m, "count") != 301 or len(anims) != 301:
        erro(V, arq, f"count={get(m, 'count')} len={len(anims)}; esperado 301")
    for i, a in enumerate(anims):
        if not isinstance(a, dict):
            erro(V, arq, f"animations[{i}] não é objeto")
            continue
        ctx, tipo, meth = f"animations[{i}] ({a.get('id', '?')})", get(a, "type"), get(a, "method")
        for k in ("id", "name", "file", "method"):
            if not isinstance(get(a, k), str):
                erro(V, arq, f"{ctx}: '{k}' ausente ou não textual")
        if tipo not in TIPOS_ANIM:
            erro(V, arq, f"{ctx}: type inválido {tipo!r}")
        existe(V, arq, SA, get(a, "file"), ctx)
        if not (e_int(get(a, "frames")) and a["frames"] >= 0):
            erro(V, arq, f"{ctx}: 'frames' deve ser int >= 0")
        if not isinstance(get(a, "loop"), bool):
            erro(V, arq, f"{ctx}: 'loop' deve ser bool")
        mods = get(a, "models")
        if not isinstance(mods, list) or not all(isinstance(x, dict) and isinstance(get(x, "assetId"), str)
                                                 and e_num(get(x, "score")) for x in mods):
            erro(V, arq, f"{ctx}: 'models' deve ser lista de {{assetId, score}}")
            mods = []
        cenas = lista(V, a, "scenes", arq, ctx + " ")
        if tipo != "SCN0" and not mods:
            erro(V, arq, f"{ctx}: sem modelos")
        if tipo == "SCN0" and meth != "same-brres" and not cenas:
            erro(V, arq, f"{ctx}: SCN0 sem cenas")
        INFO["structural"] += meth in ("structural", "scene-container")
    if INFO["structural"] != 119:
        erro(V, arq, f"{INFO['structural']} entradas structural/scene-container; esperado 119")
    return [a for a in anims if isinstance(a, dict)]


def verifica_animacoes(anims):
    """Verifica cada JSON de animação referenciado pelo manifesto."""
    V = "2_animacoes"
    for a in anims:
        f = get(a, "file")
        caminho = os.path.join(SA, f) if isinstance(f, str) else ""
        if not os.path.isfile(caminho):
            continue  # ausência já reportada na verificação 1
        d = carregar(V, caminho)
        if get(d, "type") != get(a, "type"):
            erro(V, caminho, f"type {get(d, 'type')!r} difere do manifesto {get(a, 'type')!r}")
        nf = get(d, "frames")
        if not e_int(nf) or nf < 0:
            erro(V, caminho, "'frames' deve ser int >= 0")
            nf = None
        if nao_finito(d):
            erro(V, caminho, "contém número não finito")
        valida_anim(get(a, "type"), d, caminho, nf)


def verifica_modelos():
    """Verifica os 259 *.nw4r.json, incluindo skin e morphs em base64."""
    V = "3_modelos"
    pasta = os.path.join(A, "Nw4r", "Models")
    arqs = sorted(glob.glob(os.path.join(pasta, "**", "*.nw4r.json"), recursive=True))
    if len(arqs) != 259:
        erro(V, pasta, f"{len(arqs)} arquivos *.nw4r.json; esperado 259")
    for arq in arqs:
        d = carregar(V, arq)
        for k in ("assetId", "model", "glb", "materials", "bones", "meshes", "patternTextures"):
            if k not in d:
                erro(V, arq, f"chave '{k}' ausente")
        existe(V, arq, A, get(d, "glb"), "glb")
        for i, m in enumerate(lista(V, d, "materials", arq)):
            if not (isinstance(get(m, "name"), str) and isinstance(get(m, "translucent"), bool)
                    and isinstance(get(m, "doubleSided"), bool)):
                erro(V, arq, f"materials[{i}]: name/translucent/doubleSided inválidos")
            for j, cam in enumerate(lista(V, m, "layers", arq, f"materials[{i}] ")):
                if get(cam, "png") is not None:
                    existe(V, arq, A, get(cam, "png"), f"materials[{i}].layers[{j}]")
        ossos = lista(V, d, "bones", arq)
        for i, b in enumerate(ossos):
            p = get(b, "parent")
            if not isinstance(get(b, "name"), str) or not e_int(p) or p >= i:
                erro(V, arq, f"bones[{i}]: 'name' ou 'parent' (int < índice) inválido")
            for k in ("scale", "rotate", "translate"):
                if not nums(get(b, k), 3):
                    erro(V, arq, f"bones[{i}].{k} deve ter 3 números")
        for i, m in enumerate(lista(V, d, "meshes", arq)):
            ctx, vc, tipo = f"meshes[{i}]", get(m, "vertexCount"), get(m, "binding")
            if not isinstance(get(m, "name"), str) or not e_int(vc) or vc <= 0:
                erro(V, arq, f"{ctx}: 'name' ou 'vertexCount' (int > 0) inválido")
                continue
            if tipo not in ("static", "rigid", "skinned"):
                erro(V, arq, f"{ctx}: binding inválido {tipo!r}")
            elif tipo == "rigid" and not (e_int(get(m, "bone")) and 0 <= m["bone"] < len(ossos)):
                erro(V, arq, f"{ctx}: rigid exige 'bone' int dentro de bones")
            elif tipo == "skinned" and tamanho_b64(get(m, "skin")) != vc * 24:
                erro(V, arq, f"{ctx}: 'skin' deve decodificar para {vc * 24} bytes")
            for j, mo in enumerate(get(m, "morphs") or []):
                if tamanho_b64(get(mo, "deltas")) != vc * 12:
                    erro(V, arq, f"{ctx}.morphs[{j}]: 'deltas' deve decodificar para {vc * 12} bytes")
        for i, p in enumerate(lista(V, d, "patternTextures", arq)):
            existe(V, arq, A, get(p, "png"), f"patternTextures[{i}]")


def verifica_cenas():
    """Verifica scenes_index.json (32 cenas), os arquivos de cena e os 1361 objetos."""
    V = "4_cenas"
    arq = os.path.join(SA, "Scenes", "scenes_index.json")
    cenas = lista(V, carregar(V, arq), "scenes", arq)
    if len(cenas) != 32:
        erro(V, arq, f"{len(cenas)} cenas; esperado 32")
    total = 0
    for c in cenas:
        f = get(c, "file")
        caminho = os.path.join(SA, f) if isinstance(f, str) else ""
        if not os.path.isfile(caminho):
            erro(V, arq, f"cena {f!r} não existe")
            continue
        d = carregar(V, caminho)
        for k in ("models", "collision"):
            lista(V, d, k, caminho)
        objs = lista(V, d, "objects", caminho)
        total += len(objs)
        for i, o in enumerate(objs):
            r = get(o, "rotation")
            if (not nums(get(o, "position"), 3) or not nums(r, 4)
                    or abs(math.sqrt(sum(x * x for x in r)) - 1) > 1e-3 or not nums(get(o, "scale"), 3)):
                erro(V, caminho, f"objects[{i}]: position/rotation (norma 1)/scale inválidos")
    if total != 1361:
        erro(V, arq, f"{total} objetos no total; esperado 1361")


def verifica_ui():
    """Verifica ui_manifest.json: 138 layouts, texturas, fontes, 647 animações e 47 com missingTargets."""
    V = "5_ui"
    base = os.path.join(SA, "UI")
    arq = os.path.join(base, "ui_manifest.json")
    layouts = lista(V, carregar(V, arq), "layouts", arq)
    if len(layouts) != 138:
        erro(V, arq, f"{len(layouts)} layouts; esperado 138")
    anims_total = com_falta = 0
    for i, l in enumerate(layouts):
        ctx = f"layouts[{i}] ({get(l, 'name')})"
        existe(V, arq, base, get(l, "file"), ctx)
        for t in lista(V, l, "textures", arq, ctx + " "):
            if get(t, "png") is not None:
                existe(V, arq, base, get(t, "png"), ctx + " textures")
        for fo in lista(V, l, "fonts", arq, ctx + " "):
            existe(V, arq, base, get(fo, "font"), ctx + " fonts")
        for an in lista(V, l, "animations", arq, ctx + " "):
            anims_total += 1
            existe(V, arq, base, get(an, "file"), ctx + " animations")
            mt = get(an, "missingTargets")
            if not isinstance(mt, list):
                erro(V, arq, f"{ctx}: missingTargets deve ser lista")
            elif mt:
                com_falta += 1
    if anims_total != 647:
        erro(V, arq, f"{anims_total} animações; esperado 647")
    if com_falta != 47:
        erro(V, arq, f"{com_falta} animações com missingTargets; esperado 47")


def verifica_efeitos():
    """Verifica effects_index.json (10 packs), cada .effect.json e seus 380 emissores."""
    V = "6_efeitos"
    arq = os.path.join(RES, "Effects", "effects_index.json")
    packs = lista(V, carregar(V, arq), "packs", arq)
    if len(packs) != 10:
        erro(V, arq, f"{len(packs)} packs; esperado 10")
    total = 0
    for p in packs:
        res = get(p, "resource")
        caminho = os.path.join(RES, res + ".effect.json") if isinstance(res, str) else ""
        if not os.path.isfile(caminho):
            erro(V, arq, f"pack {res!r}: .effect.json não existe")
            continue
        for i, e in enumerate(lista(V, carregar(V, caminho), "emitters", caminho)):
            total += 1
            ctx, em, pa = f"emitters[{i}] ({get(e, 'name')})", get(e, "emitter"), get(e, "particle")
            if not (isinstance(get(e, "name"), str) and isinstance(get(e, "category"), str)):
                erro(V, caminho, f"{ctx}: name/category inválidos")
            if not (e_int(get(em, "particleLife")) and e_num(get(em, "emitCount"))
                    and isinstance(get(em, "form"), str) and isinstance(get(em, "velocity"), dict)):
                erro(V, caminho, f"{ctx}: emitter inválido (particleLife, emitCount, form, velocity)")
            if not (ints(get(pa, "color0Primary"), 4) and nums(get(pa, "size"), 2)):
                erro(V, caminho, f"{ctx}: particle inválido (color0Primary, size)")
            for tr in lista(V, pa, "textureResources", caminho, ctx + " "):
                if tr is not None and (not isinstance(tr, str) or not os.path.isfile(os.path.join(RES, tr + ".png"))):
                    erro(V, caminho, f"{ctx}: textureResource {tr!r} sem .png")
    if total != 380:
        erro(V, arq, f"{total} emissores no total; esperado 380")


def verifica_texto():
    """Verifica text_index.json, os arquivos BMG em JSON e suas mensagens."""
    V = "7_texto"
    arq = os.path.join(SA, "Text", "text_index.json")
    for b in lista(V, carregar(V, arq), "bmg", arq):
        p = get(b, "path")
        caminho = os.path.join(SA, p) if isinstance(p, str) else ""
        if not os.path.isfile(caminho):
            erro(V, arq, f"bmg {p!r} não existe")
            continue
        for i, msg in enumerate(lista(V, carregar(V, caminho), "messages", caminho)):
            if not (e_int(get(msg, "id")) and e_int(get(msg, "index")) and isinstance(get(msg, "text"), str)):
                erro(V, caminho, f"messages[{i}]: exige id e index inteiros e text textual")


def verifica_mii():
    """Resources/Mii (tools/export_mii.py): tabelas, formas, texturas e perfis lidos por MiiResources.cs."""
    V = "8_mii"
    base = os.path.join(RES, "Mii")
    arq = os.path.join(base, "rfl_params.json")
    par = carregar(V, arq)
    tamanhos = {"facelineColor": 6, "hairColor": 8, "beardColor": 8, "glassColor": 6, "favoriteColor": 12,
                "eyeColor": 6, "eyebrowColor2D": 8, "mustacheColor2D": 8, "mouthColorDark": 3, "mouthColorLip": 3}
    for k, n in tamanhos.items():
        cores = get(get(par, "colors"), k)
        if not (isinstance(cores, list) and len(cores) == n and all(ints(c, 4) for c in cores)):
            erro(V, arq, f"colors.{k}: exige {n} cores RGBA")
    for k, n in (("eyeRotateOffset", 50), ("eyebrowRotateOffset", 24)):
        if not ints(get(par, k), n):
            erro(V, arq, f"{k}: exige {n} inteiros")
    if not (all(ints(get(get(par, "eyeOutline"), k), 4) for k in ("default", "9", "20")) and ints(get(par, "moleColor"), 4)):
        erro(V, arq, "eyeOutline (default/9/20) e moleColor exigem RGBA")
    sem_uv = {"nose", "forehead", "hair", "beard"}
    formas = {}
    for parte in ("nose", "forehead", "faceline", "hair", "cap", "beard", "noseline", "mask", "glass"):
        arq = os.path.join(base, "Shapes", parte + ".json")
        partes = lista(V, carregar(V, arq), "parts", arq)
        formas[parte] = partes
        for i, s in enumerate(partes):
            if s is None:
                continue
            pos, nrm, tri = get(s, "positions"), get(s, "normals"), get(s, "triangles")
            if not (isinstance(pos, list) and pos and len(pos) % 3 == 0 and isinstance(nrm, list) and len(nrm) == len(pos)):
                erro(V, arq, f"parts[{i}]: positions/normals inválidos")
                continue
            nv = len(pos) // 3
            if not (isinstance(tri, list) and tri and len(tri) % 3 == 0 and all(e_int(t) and 0 <= t < nv for t in tri)):
                erro(V, arq, f"parts[{i}]: triangles fora de 0..{nv - 1}")
            uv = get(s, "uvs")
            if parte not in sem_uv and not (isinstance(uv, list) and len(uv) == 2 * nv):
                erro(V, arq, f"parts[{i}]: uvs exige {2 * nv} valores")
            if parte == "faceline" and not all(nums(get(get(s, "anchors"), k), 3) for k in ("nose", "beard", "hair")):
                erro(V, arq, f"parts[{i}]: anchors nose/beard/hair ausentes")
    arq = os.path.join(base, "textures.json")
    texs = get(carregar(V, arq), "textures") or {}
    for pasta, itens in texs.items():
        for i, t in enumerate(itens if isinstance(itens, list) else []):
            existe(V, arq, os.path.join(base, "Textures", pasta), f"{i:02d}.png", f"{pasta}[{i}]")
            if get(t, "wrapS") not in (0, 1, 2) or get(t, "wrapT") not in (0, 1, 2):
                erro(V, arq, f"{pasta}[{i}]: wrapS/wrapT fora de 0..2")
    n = lambda k: len(formas.get(k) or texs.get(k) or [])
    arq = os.path.join(base, "profiles.json")
    for p in lista(V, carregar(V, arq), "profiles", arq):
        pa = os.path.join(base, "Profiles", f"{get(p, 'id')}.json")
        d = carregar(V, pa)
        try:
            raw = base64.b64decode(get(d, "raw") or "", validate=True)
        except (binascii.Error, ValueError):
            raw = b""
        if len(raw) != 74:
            erro(V, pa, "raw: exige RFLCharData de 74 bytes em base64")
        info = get(d, "info") or {}
        g = lambda a, b: get(get(info, a), b)
        refs = [("faceline", g("faceline", "type")), ("mask", g("faceline", "type")), ("hair", g("hair", "type")),
                ("forehead", g("hair", "type")), ("cap", g("hair", "type")), ("cap_shape", g("hair", "type")),
                ("nose", g("nose", "type")), ("noseline", g("nose", "type")), ("noseline_shape", g("nose", "type")),
                ("beard", g("beard", "type")), ("faceline_shape", g("faceline", "texture")), ("eye", g("eye", "type")),
                ("eyebrow", g("eyebrow", "type")), ("mouth", g("mouth", "type")), ("mustache", g("beard", "mustache")),
                ("glass_shape", g("glass", "type"))]
        for k, idx in refs:
            if not (e_int(idx) and 0 <= idx < n(k)):
                erro(V, pa, f"{k} {idx!r} fora de 0..{n(k) - 1}")
    # tipos fixos usados pelas expressões (MiiCharInfo.WithExpression)
    if n("eye") <= 49 or n("mouth") <= 24:
        erro(V, os.path.join(base, "textures.json"), "expressões exigem olho 26/48/49 e boca 10/12/24")


def _json(v, caminho):
    try:
        with open(caminho, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        erro(v, caminho, f"não abre: {e}")
        return None


def _rgba(x):
    return isinstance(x, list) and len(x) == 4 and all(e_int(c) and 0 <= c <= 255 for c in x)


def verifica_ambiente():
    """Environment/*.env.json e environment_index.json (Nw4rEnvironmentData / Nw4rEnvironmentIndex)."""
    V = "9_ambiente"
    base = os.path.join(SA, "Environment")
    ip = os.path.join(base, "environment_index.json")
    ix = _json(V, ip)
    if ix is None:
        return
    ramps = ix.get("ramps") or []
    if len(ramps) != 10:
        erro(V, ip, f"{len(ramps)} rampas (esperado 10)")
    for r in ramps:
        vals = r.get("values")
        if not (isinstance(vals, list) and len(vals) == 64 and all(e_num(x) and 0 <= x <= 1 for x in vals)):
            erro(V, ip, f"rampa {r.get('mode')}: precisa de 64 valores 0..1")
        elif any(vals[k] > vals[k + 1] for k in range(63)):
            erro(V, ip, f"rampa {r.get('mode')} não é monótona")
    nomes = {p.get("name") for p in ix.get("presets", [])}
    for cena, preset in (ix.get("scenes") or {}).items():
        if preset not in nomes:
            erro(V, ip, f"cena {cena} -> preset inexistente {preset}")
        if not os.path.isfile(os.path.join(SA, cena)):
            erro(V, ip, f"cena {cena} não existe em StreamingAssets")
    for rel, res in (ix.get("textures") or {}).items():
        if not os.path.isfile(os.path.join(RES, res + ".png")):
            erro(V, ip, f"textura {res}.png ausente (de {rel})")
    for p in ix.get("presets", []):
        fp = os.path.join(SA, p.get("file", ""))
        d = _json(V, fp)
        if d is None:
            continue
        luz = d.get("light") or {}
        if len(luz.get("ambientColors", [])) != 8 or not all(_rgba(c) for c in luz.get("ambientColors", [])):
            erro(V, fp, "ambientColors precisa de 8 RGBA")
        if not _rgba(luz.get("globalColor")):
            erro(V, fp, "globalColor inválido")
        indices = set()
        for l in luz.get("lights", []):
            ctx = f"luz {l.get('index')}"
            indices.add(l.get("index"))
            if l.get("type") not in ("point", "directional", "spot"):
                erro(V, fp, f"{ctx}: type {l.get('type')!r}")
            if l.get("space") not in ("world", "worldSpecular", "view", "cameraFront", "cameraBack"):
                erro(V, fp, f"{ctx}: space {l.get('space')!r}")
            if not (nums(l.get("position"), 3) and nums(l.get("target"), 3)):
                erro(V, fp, f"{ctx}: position/target precisam de 3 números")
            if not (_rgba(l.get("color")) and _rgba(l.get("secondaryColor"))):
                erro(V, fp, f"{ctx}: cores RGBA inválidas")
            if not e_num(l.get("intensity")) or l.get("intensity") < 0:
                erro(V, fp, f"{ctx}: intensity inválida")
        for t in (d.get("lightmap") or {}).get("textures", []):
            ctx = f"lightmap {t.get('name')}"
            if not str(t.get("name", "")).startswith("lm_"):
                erro(V, fp, f"{ctx}: nome fora do padrão lm_N")
            ent = t.get("entries", [])
            for k in t.get("lights", []):
                if k >= len(ent):
                    erro(V, fp, f"{ctx}: luz {k} sem entrada de peso/modo")
                elif not (0 <= ent[k].get("mode", -1) < 10):
                    erro(V, fp, f"{ctx}: modo {ent[k].get('mode')} da luz {k}")
                if k not in indices:
                    erro(V, fp, f"{ctx}: máscara cita a luz {k}, que não existe no .plight")
        bl = d.get("bloom")
        if bl is not None:
            if not (e_num(bl.get("threshold")) and _rgba(bl.get("color")) and len(bl.get("stages", [])) == 3):
                erro(V, fp, "bloom: threshold/color/stages inválidos")
            if not (e_int(bl.get("stageCount")) and 0 <= bl["stageCount"] <= 3):
                erro(V, fp, f"bloom: stageCount {bl.get('stageCount')}")


def verifica_audio():
    """Audio/audio_index.json (AudioManager.LoadIndex) e os .wav citados (PCM 16 bits)."""
    import wave
    V = "10_audio"
    ip = os.path.join(SA, "Audio", "audio_index.json")
    ix = _json(V, ip)
    if ix is None:
        return
    n = 0
    for b in ix.get("banks", []):
        for c in b.get("clips", []):
            fp = os.path.join(SA, c.get("file", ""))
            try:
                with wave.open(fp) as w:
                    if w.getsampwidth() != 2 or w.getnframes() != c.get("frames") or w.getframerate() != c.get("sampleRate"):
                        erro(V, fp, "cabeçalho WAV difere do índice ou não é PCM 16 bits")
            except (OSError, EOFError, wave.Error) as e:
                erro(V, fp, f"WAV ilegível: {e}")
            n += 1
    if n == 0:
        erro(V, ip, "nenhum clipe")
    if not isinstance(ix.get("missingBanks"), list):
        erro(V, ip, "missingBanks ausente")


def verifica_jogabilidade():
    """gameplay_data.json (Etapa 5): o que GameplayData.Parse e as Activities esperam."""
    V = "11_jogabilidade"
    fp = os.path.join(SA, "Gameplay", "gameplay_data.json")
    d = carregar(V, fp)
    if not d:
        return
    if get(d, "unitsPerMeter") != 10.0:
        erro(V, fp, f"unitsPerMeter {get(d, 'unitsPerMeter')} (esperado 10)")
    manifest = carregar(V, os.path.join(SA, "animations_manifest.json"))
    chr0 = {a["name"] for a in get(manifest, "animations") or [] if a.get("type") == "CHR0"}
    efx = set()
    for p in get(carregar(V, os.path.join(RES, "Effects", "effects_index.json")), "packs") or []:
        efx.update(p.get("emitters", []))
    layouts = {l["assetId"] for l in get(carregar(V, os.path.join(SA, "UI", "ui_manifest.json")), "layouts") or []}
    sports = get(d, "sports") or {}
    for key in ("tennis", "baseball", "bowling", "golf", "boxing"):
        s = get(sports, key)
        if not isinstance(s, dict):
            erro(V, fp, f"modalidade ausente: {key}")
            continue
        for a in s.get("animations", []):
            if a not in chr0:
                erro(V, fp, f"{key}: animação {a} não está no animations_manifest (CHR0)")
        for e in s.get("effects", []):
            if e not in efx:
                erro(V, fp, f"{key}: efeito {e} não está no effects_index")
        for n, prefab in (s.get("models") or {}).items():
            if not isinstance(prefab, str) or not prefab.startswith("Prefabs/Models/mdl_"):
                erro(V, fp, f"{key}: modelo {n} com prefab inválido {prefab}")
        for n, lid in (s.get("hud") or {}).items():
            if lid not in layouts:
                erro(V, fp, f"{key}: layout de HUD {n} ({lid}) fora do ui_manifest")
        for sc in ([s.get("commonScene")] if s.get("commonScene") else []) + list(s.get("scenes", [])):
            existe(V, fp, os.path.join(SA, "Scenes"), sc, f"{key}: cena")
        if not s.get("animations") or not s.get("effects") or not s.get("models"):
            erro(V, fp, f"{key}: sem animações, efeitos ou modelos")
    for state, ids in (get(d, "stateLayouts") or {}).items():
        for lid in ids:
            if lid not in layouts:
                erro(V, fp, f"estado {state}: layout {lid} fora do ui_manifest")
    golf = get(sports, "golf") or {}
    courses = golf.get("courses", [])
    if len(courses) != 14:
        erro(V, fp, f"golfe: {len(courses)} cursos (esperado 14)")
    for c in courses:
        if not nums(c.get("tee"), 3) or not c.get("pins") or not all(nums(p, 3) for p in c["pins"]) or c.get("par") not in (3, 4, 5):
            erro(V, fp, f"golfe: curso {c.get('id')} com tee/pinos/par inválidos")
    surf = golf.get("surfaces") or {}
    if surf.get("1") != "tee" or surf.get("6") != "green":
        erro(V, fp, "golfe: superfícies do KCL sem tee(1)/green(6)")
    bow = (get(sports, "bowling") or {}).get("geometry") or {}
    if not (-184 < (bow.get("headPinZ") or 0) < -181.5) or len(bow.get("npcLaneX") or []) != 7:
        erro(V, fp, "boliche: pino 1 fora de 18,29 m ou pistas de fundo != 7")
    fence = ((get(sports, "baseball") or {}).get("geometry") or {}).get("fence") or []
    if len(fence) != 19 or not all(e_num(r) and 600 < r < 1200 for r in fence):
        erro(V, fp, "beisebol: perfil do muro inválido")
    fields = {r.get("field") for r in get(d, "records") or []}
    for f in ("BowStandardBest", "BowPerfectCount", "GolStandardBest", "GolAceCount", "BsbRenzokuBest", "TnsSuccess", "SkillLevel", "StandardPlayCount"):
        if f not in fields:
            erro(V, fp, f"recordes: campo {f} ausente (usado pelo C#)")
    bodies = get(d, "avatarBodies") or {}
    for b in ("ava_bodyA0", "ava_bodyA1", "ava_bodyA2", "ava_bodyA3", "ava_bodyB0", "ava_bodyB1", "ava_bodyB2", "ava_bodyB3"):
        if b not in bodies:
            erro(V, fp, f"corpo Mii {b} ausente (SportActor.BodyFor)")


def main():
    """Executa as verificações, imprime o resumo e grava o relatório JSON."""
    anims = verifica_manifesto()
    verifica_animacoes(anims)
    for verificacao in (verifica_modelos, verifica_cenas, verifica_ui, verifica_efeitos, verifica_texto, verifica_mii,
                        verifica_ambiente, verifica_audio, verifica_jogabilidade):
        verificacao()
    cont = Counter(v for v, _ in violacoes)
    print("Resumo da validação")
    for nome in NOMES:
        print(f"  {nome:<14} {cont.get(nome, 0)} violação(ões)")
    print(f"  Total: {len(violacoes)} violação(ões)")
    print(f"  Entradas structural/scene-container: {INFO['structural']} (esperado 119)")
    print("Primeiras violações:" if violacoes else "Sem violações.")
    for _, msg in violacoes[:10]:
        print(f"  - {msg}")
    relatorio = {"contagens": {n: cont.get(n, 0) for n in NOMES}, "total": len(violacoes),
                 "structural_ou_scene_container": INFO["structural"],
                 "violacoes": [msg for _, msg in violacoes[:200]]}
    os.makedirs(os.path.dirname(RELATORIO), exist_ok=True)
    with open(RELATORIO, "w", encoding="utf-8") as f:
        json.dump(relatorio, f, ensure_ascii=False, indent=2)
    return 1 if violacoes else 0


if __name__ == "__main__":
    sys.exit(main())
