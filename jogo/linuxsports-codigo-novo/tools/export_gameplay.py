#!/usr/bin/env python3
"""Etapa 5: dados de jogabilidade para o runtime (GameStateMachine + Activities/).

Lê (somente leitura) o código descompilado, o main.dol, as cenas e as malhas de colisão já
preparadas pelas etapas anteriores e grava:
  NW4R_TARGET=web (padrão):  minigames/sports/assets/Gameplay/gameplay_data.json  (referencial do Wii = three.js)
  NW4R_TARGET=unity:         Assets/StreamingAssets/Gameplay/gameplay_data.json   (X espelhado, legado)
  index/gameplay-export.json  (relatório: de onde veio cada número)

O que sai, por modalidade (tennis, baseball, bowling, golf, boxing):
  * scenes / commonScene: cenas .scene.json usadas pela partida.
  * animations / effects / models / layouts: nomes citados em strings.tsv pelo código da modalidade
    que EXISTEM nos dados convertidos (animations_manifest.json, effects_index.json, cenas, ui_manifest.json).
    Assim o C# só pede o que foi de fato exportado.
  * geometria de jogo, em unidades da cena (10 unidades = 1 m; ver `scale` abaixo):
      bowling: linha de falta, pino 1, espaçamento dos pinos, raio da bola, largura da pista e das
               canaletas, e o X das 7 pistas de fundo (tabela DAT_803ca6c8.. lida do DOL, usada por
               Bowling::CheckBallLaneIntersection).
      golf:    tee, direção do tee e pinos de cada curso (objetos .pmp tipo 0 e 1), distância e par.
      baseball: home, perfil do muro (distância por ângulo, tirado da malha de colisão bbl_Field_a).
      tennis:  quadra oficial (ITF) em unidades da cena; a rede do modelo tns_net_a confere a escala.
      boxing:  meia largura do ringue (modelo box_ring).
  * records: campos de recorde de RPSportsPlayerData (getters/setters do DOL, tamanho do campo).

Escala: o pino de boliche (bwg_pin, 3,81 u), a distância linha de falta -> pino 1 (182,9 u; regra: 18,29 m),
a rede de tênis (≈ 128 u; regra: 12,8 m) e a bola de boliche (2,2 u; regra: 21,8 cm) dão 10 u/m.
"""
import collections
import json
import math
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r.dol import Dol  # noqa: E402
from nw4r.paths import ASSETS, INDEX, NW4R, RESOURCES, SRC, STREAMING, TARGET, write_json  # noqa: E402

WEB = TARGET == 'web'

DECOMP = SRC / 'raw/src/core/decompiled'
UNITS_PER_METER = 10.0

SPORTS = {
    # chave: (prefixos das strings, pasta do minigame, cenas de mapa)
    'tennis': (('tns_', 'Tns_'), 'tennis', ['assets/maps/tennis/tns_Field_a.scene.json', 'assets/maps/tennis/tns_Field_b.scene.json']),
    'baseball': (('bbl_', 'Bsb_'), 'baseball', ['assets/maps/baseball/ballpark00.scene.json']),
    'bowling': (('bwg_', 'Bow_', 'pin_'), 'bowling', []),
    'golf': (('glf_', 'Gol_', 'golf_'), 'golf', []),
    'boxing': (('box_', 'Box_'), 'boxing', ['assets/maps/boxing/MainGame.scene.json']),
}

# Estados da máquina de estados -> layouts (nomes exatos do ui_manifest; pasta de origem desambigua nomes repetidos).
STATE_LAYOUTS = {
    'Boot': [('SpTitle_00', 'RPST'), ('SpTitle_01', 'RPST')],
    'MainMenu': [('menuBg_00', 'RPSportsCommon'), ('sportsTop_00', 'RPSportsCommon'), ('menuFrame_00', 'RPSportsCommon')],
    'SportSelect': [('menuBg_00', 'RPCommon'), ('menuFrame_00', 'RPCommon')],
    'CharacterSelect': [('menuBg_00', 'RPCommon'), ('playerSelect_00', 'RPCommon'), ('playerSelect_01', 'RPCommon')],
    'Intro': [('spVsPlayer_00', 'SportsStatic'), ('playerIntroduction_00', 'SportsStatic')],
    'Playing': [('spGameStart_00', 'SportsStatic')],
    'Paused': [('pause_00', 'SportsStatic')],
    'Results': [('trainingResult_00', 'SportsStatic'), ('pIRecord_00', 'SportsStatic')],
    'Records': [('menuBg_00', 'RPCommon'), ('pIRecord_00', 'SportsStatic'), ('backCommon_00', 'RPCommon')],
}

# Layouts de HUD por modalidade (nomes do ui_manifest dentro da pasta do minigame).
SPORT_HUD = {
    'tennis': ['vsScoreServer_00', 'serverIcon_00', 'ballScore_00', 'miss_00', 'tennisText_00', 'posSelect_00'],
    'baseball': ['bblVsGame_00', 'bblGameText_00', 'bblCommon_00', 'bblGameResult_00', 'baseballCommon_00'],
    'bowling': ['score_00', 'pin_00', 'bwgStrike_00', 'bwgText_00', 'bwgCount_00', 'BwgGlfScorecard_00'],
    'golf': ['golf_00', 'glfShotNumber_00', 'glfScorecard_00', 'glfHoleOutText_00', 'glfSelectCourse_00', 'glfHoleDemo_00'],
    'boxing': ['boxGauge_00', 'boxJudge_00', 'boxEx_00'],
}


def load_strings():
    out = []
    for line in (DECOMP / 'strings.tsv').read_text(encoding='utf-8', errors='replace').splitlines():
        parts = line.split('\t', 1)
        if len(parts) == 2:
            out.append((parts[0], parts[1]))
    return out


def load_functions():
    out = {}
    lines = (DECOMP / 'functions.tsv').read_text(encoding='utf-8', errors='replace').splitlines()
    for line in lines[1:]:
        p = line.split('\t')
        if len(p) >= 3:
            out[p[1]] = (p[0], int(p[2]) if p[2].isdigit() else 0)
    return out


def glb_json_and_bin(path):
    b = Path(path).read_bytes()
    jlen = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + jlen])
    off = 20 + jlen
    blen = struct.unpack_from('<I', b, off)[0]
    return j, b[off + 8: off + 8 + blen]


def glb_bounds(path):
    j, _ = glb_json_and_bin(path)
    mn, mx = [1e9] * 3, [-1e9] * 3
    for m in j['meshes']:
        for p in m['primitives']:
            a = j['accessors'][p['attributes']['POSITION']]
            if 'min' in a:
                mn = [min(x, y) for x, y in zip(mn, a['min'])]
                mx = [max(x, y) for x, y in zip(mx, a['max'])]
    return mn, mx


def glb_triangles(path):
    """Triângulos em coordenadas Wii (o .glb guarda a posição do Wii; o glTFast espelha X ao importar)."""
    j, binb = glb_json_and_bin(path)

    def acc(i):
        a = j['accessors'][i]
        v = j['bufferViews'][a['bufferView']]
        base = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        comps = {'SCALAR': 1, 'VEC3': 3}[a['type']]
        fmt = {5126: 'f', 5125: 'I', 5123: 'H', 5121: 'B'}[a['componentType']]
        size = struct.calcsize(fmt)
        stride = v.get('byteStride', size * comps)
        return [struct.unpack_from('<' + fmt * comps, binb, base + k * stride) for k in range(a['count'])]

    tris = []
    for m in j['meshes']:
        for p in m['primitives']:
            pos = acc(p['attributes']['POSITION'])
            idx = [i[0] for i in acc(p['indices'])] if 'indices' in p else list(range(len(pos)))
            for k in range(0, len(idx) - 2, 3):
                tris.append((pos[idx[k]], pos[idx[k + 1]], pos[idx[k + 2]]))
    return tris


def find_glb(root, pattern):
    hits = sorted(Path(root).rglob(pattern))
    return hits[0] if hits else None


def wii_x(x):
    """X no referencial do Wii a partir do X gravado nas cenas (o alvo unity espelhou X ao exportar)."""
    return x if WEB else -x


def mirror_x(x):
    """X do referencial do Wii para o alvo (web mantém; unity espelha)."""
    return x if WEB else -x


# ---------------------------------------------------------------------- índices dos dados convertidos
def converted_indices():
    anims = json.loads((STREAMING / 'animations_manifest.json').read_text(encoding='utf-8'))['animations']
    anim_names = collections.defaultdict(list)
    for a in anims:
        anim_names[a['name']].append(a['type'])
    effects = {}
    for pack in json.loads((RESOURCES / 'Effects/effects_index.json').read_text(encoding='utf-8'))['packs']:
        for e in pack['emitters']:
            effects.setdefault(e, pack['pack'])
    models = {}
    scenes = {}
    for f in sorted((STREAMING / 'Scenes').rglob('*.scene.json')):
        rel = f.relative_to(STREAMING).as_posix()
        d = json.loads(f.read_text(encoding='utf-8'))
        scenes[rel] = d
        for m in d.get('models', []):
            short = m['name'].rsplit('/', 1)[-1]
            models.setdefault(short, {'prefab': m.get('prefab') or m.get('sidecar'), 'assetId': m['assetId'], 'scene': rel})
    ui = json.loads((STREAMING / 'UI/ui_manifest.json').read_text(encoding='utf-8'))['layouts']
    return anim_names, effects, models, scenes, ui


def layout_id(ui, name, folder):
    for l in ui:
        if l['name'] == name and ('/' + folder + '/') in l['file']:
            return l['assetId']
    return None


# ---------------------------------------------------------------------- por modalidade
def sport_names(strings, prefixes, anim_names, effects, models):
    anims, fx, mdl = [], [], {}
    seen = set()
    for _, s in strings:
        s = s.strip()
        if s in seen or not s.startswith(prefixes):
            continue
        seen.add(s)
        if s in anim_names and 'CHR0' in anim_names[s]:
            anims.append(s)
        if s in effects:
            fx.append(s)
        if s in models:
            mdl[s] = models[s]['prefab']
    return sorted(anims), sorted(fx), mdl


def bowling_geometry(dol, report):
    lane = find_glb(NW4R / 'Collision', 'bwg_lane_col.glb')
    pins = find_glb(NW4R / 'Models', 'bwg_field__bwg_field_pin.glb')
    ball = find_glb(NW4R / 'Models', 'bwg_ball__bwg_ball_blue.glb')
    pin = find_glb(NW4R / 'Models', 'bwg_Pin__bwg_pin_166_10.glb')
    lmn, lmx = glb_bounds(lane)
    pmn, pmx = glb_bounds(pins)
    bmn, bmx = glb_bounds(ball)
    qmn, qmx = glb_bounds(pin)
    head_pin_z = pmx[2] - (qmx[2] - qmn[2]) * 0.5   # frente da fileira de pinos de fundo = pino 1
    # tabela do DOL no referencial do Wii; o alvo unity guarda como sempre guardou (o C# espelha ao usar)
    npc_lanes = [round(dol.f32(0x803CA6C8 + 4 * i), 3) for i in range(7)]
    report['bowling'] = {
        'laneCollision': str(lane.relative_to(ASSETS)), 'laneBounds': [lmn, lmx],
        'backgroundPins': str(pins.relative_to(ASSETS)), 'backgroundPinsBounds': [pmn, pmx],
        'npcLaneX': 'DOL 0x803CA6C8..0x803CA6E0 (7 floats, Bowling::CheckBallLaneIntersection)',
    }
    return {
        'foulLineZ': 0.0,
        'headPinZ': round(head_pin_z, 3),            # Wii/three/Unity: a pista corre para -Z
        'laneEndZ': round(lmn[2], 3),
        'laneHalfWidth': round(10.54, 3),            # 41,5 pol = 1,054 m (regra), pista central sem as canaletas
        'gutterHalfWidth': round(lmx[0], 3),         # largura da colisão da pista (inclui canaletas)
        'pinSpacing': 3.048,                          # 12 pol entre centros (regra)
        'pinHeight': round(qmx[1] - qmn[1], 3),
        'pinRadius': round(max(qmx[0] - qmn[0], qmx[2] - qmn[2]) * 0.5, 3),
        'ballRadius': round((bmx[0] - bmn[0]) * 0.5, 3),
        'npcLaneX': npc_lanes,
    }


def glb_triangles_by_flag(path):
    """Triângulos (Wii) por flag do KCL: o estágio 1 gravou cada flag como um nó collision_0xNNNN."""
    j, binb = glb_json_and_bin(path)

    def acc(i):
        a = j['accessors'][i]
        v = j['bufferViews'][a['bufferView']]
        base = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        comps = {'SCALAR': 1, 'VEC3': 3}[a['type']]
        fmt = {5126: 'f', 5125: 'I', 5123: 'H', 5121: 'B'}[a['componentType']]
        size = struct.calcsize(fmt)
        stride = v.get('byteStride', size * comps)
        return [struct.unpack_from('<' + fmt * comps, binb, base + k * stride) for k in range(a['count'])]

    out = {}
    for node in j['nodes']:
        if 'mesh' not in node or 'collisionFlag' not in node.get('extras', {}):
            continue
        tris = []
        for p in j['meshes'][node['mesh']]['primitives']:
            pos = acc(p['attributes']['POSITION'])
            idx = [i[0] for i in acc(p['indices'])]
            for k in range(0, len(idx) - 2, 3):
                tris.append((pos[idx[k]], pos[idx[k + 1]], pos[idx[k + 2]]))
        out[node['extras']['collisionFlag']] = tris
    return out


def flags_under(by_flag, x, z):
    hits = []
    for fl, tris in by_flag.items():
        for a, b, c in tris:
            d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
            if abs(d) < 1e-9:
                continue
            l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
            l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
            if l1 >= 0 and l2 >= 0 and l1 + l2 <= 1:
                hits.append(fl)
                break
    return sorted(hits)


# Superfície por flag do KCL dos cursos (INFERIDA, evidência em index/gameplay-export.json -> golfSurfaceEvidence):
#   1 = tee (os 14 tees estão sobre 1), 6/11 = green (pinos), 3 = manchas de 0,5-1,6 mil m² = banca de areia,
#   2 = fairway, 4 = rough, 5 = rough alto/mata, 7/13 = camada de base sob o curso inteiro (está sob tee e pinos
#   em 5 cursos, cota mais baixa) = fora dos limites quando é a superfície de contato, 12 = água (lagos).
GOLF_SURFACES = {1: 'tee', 2: 'fairway', 3: 'bunker', 4: 'rough', 5: 'deepRough', 6: 'green', 7: 'outOfBounds',
                 8: 'rough', 9: 'green', 10: 'rough', 11: 'green', 12: 'water', 13: 'outOfBounds'}


def golf_courses(scenes, report):
    courses = []
    for rel, d in sorted(scenes.items()):
        if not rel.startswith('Scenes/assets/maps/golf/'):
            continue
        objs = d.get('objects', [])
        tees = [o for o in objs if o['typeId'] == 0]
        pins = [o for o in objs if o['typeId'] == 1]
        if not tees or not pins:
            continue
        tee = tees[0]
        tp = tee['position']
        q = tee.get('rotation') or tee.get('quaternion')
        x, y, z, w = q
        fwd = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]   # +Z local do tee
        pin_list = [o['position'] for o in pins]
        dist = min(math.dist(tp, p) for p in pin_list) / UNITS_PER_METER
        par = 3 if dist <= 229 else 4 if dist <= 430 else 5       # faixas de distância da USGA (250/470 jardas)
        name = Path(rel).name.replace('.scene.json', '').replace('glf_course_', '')
        col = find_glb(NW4R / 'Collision', 'glf_course_%s.glb' % name)
        evidence = {}
        if col is not None:
            by_flag = glb_triangles_by_flag(col)
            evidence = {'teeFlags': flags_under(by_flag, wii_x(tp[0]), tp[2]),
                        'pinFlags': [flags_under(by_flag, wii_x(p[0]), p[2]) for p in pin_list],
                        'areaM2': {str(fl): round(sum(0.5 * abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) for a, b, c in t) / UNITS_PER_METER ** 2)
                                   for fl, t in by_flag.items()}}
        report.setdefault('golfSurfaceEvidence', {})[name] = evidence
        courses.append({
            'id': name, 'scene': rel.replace('Scenes/', '', 1),
            'tee': [round(v, 3) for v in tp], 'teeForward': [round(v, 4) for v in fwd],
            'pins': [[round(v, 3) for v in p] for p in pin_list],
            'distanceMeters': round(dist, 1), 'par': par,
        })
    report['golf'] = {'courses': len(courses), 'source': 'objetos .pmp tipo 0 (tee) e 1 (pino), no referencial do alvo (%s)' % TARGET,
                      'surfaces': {str(k): v for k, v in GOLF_SURFACES.items()}}
    return courses


def baseball_geometry(report):
    col = find_glb(NW4R / 'Collision', 'bbl_Field_a.glb')
    tris = glb_triangles(col)
    buckets = 19                       # 0..90 graus de 5 em 5, entre as linhas de falta (+X e +Z do Wii)
    fence = [None] * buckets
    for a, b, c in tris:
        ux = [b[i] - a[i] for i in range(3)]
        vx = [c[i] - a[i] for i in range(3)]
        n = [ux[1] * vx[2] - ux[2] * vx[1], ux[2] * vx[0] - ux[0] * vx[2], ux[0] * vx[1] - ux[1] * vx[0]]
        ln = math.sqrt(sum(t * t for t in n)) or 1.0
        if abs(n[1] / ln) > 0.35:
            continue                   # só paredes
        top = max(a[1], b[1], c[1])
        if top < 15.0:
            continue                   # muro com mais de 1,5 m
        for p in (a, b, c, [(a[i] + b[i] + c[i]) / 3 for i in range(3)]):
            if p[0] < -1 or p[2] < -1:
                continue
            r = math.hypot(p[0], p[2])
            if r < 500:                # ignora o alambrado atrás do home (< 50 m)
                continue
            ang = math.degrees(math.atan2(p[2], p[0]))
            k = int(round(ang / 5.0))
            if 0 <= k < buckets and (fence[k] is None or r < fence[k]):
                fence[k] = r
    known = [(k, r) for k, r in enumerate(fence) if r is not None]
    for k in range(buckets):           # preenche buracos interpolando
        if fence[k] is None and known:
            lo = max((t for t in known if t[0] < k), default=None)
            hi = min((t for t in known if t[0] > k), default=None)
            if lo and hi:
                fence[k] = lo[1] + (hi[1] - lo[1]) * (k - lo[0]) / (hi[0] - lo[0])
            else:
                fence[k] = (lo or hi)[1]
    report['baseball'] = {'collision': str(col.relative_to(ASSETS)), 'triangles': len(tris), 'fenceBuckets': len(known)}
    # Linhas de falta: 1ª base em +X do Wii e 3ª em +Z (no alvo unity o X é espelhado: 1ª base em -X).
    return {
        'home': [0.0, 0.0, 0.0],
        'firstBaseLine': [mirror_x(1.0), 0.0, 0.0], 'thirdBaseLine': [0.0, 0.0, 1.0],
        'pitcherDistance': 184.4,      # 60 pés 6 pol (regra)
        'baseDistance': 274.3,         # 90 pés (regra)
        'fenceAngleStepDeg': 5.0,
        'fence': [round(r, 1) for r in fence],
    }


def tennis_geometry(report):
    net = find_glb(NW4R / 'Models', 'tns_net_a__tns_net_a.glb')
    mn, mx = glb_bounds(net)
    width = mx[0] - mn[0]
    report['tennis'] = {'net': str(net.relative_to(ASSETS)), 'netWidthUnits': round(width, 2), 'impliedUnitsPerMeter': round(width / 12.8, 2)}
    return {
        'halfLength': 118.85, 'singlesHalfWidth': 41.15, 'doublesHalfWidth': 54.85,
        'serviceLine': 64.0, 'netHeightCenter': 9.14, 'netHeightPost': 10.7,
        'netHalfWidth': round(width * 0.5, 2),
    }


def boxing_geometry(report):
    ring = find_glb(NW4R / 'Models', 'box_ring__box_ring.glb')
    mn, mx = glb_bounds(ring)
    report['boxing'] = {'ring': str(ring.relative_to(ASSETS)), 'bounds': [mn, mx]}
    return {'ringHalfSize': round(max(mx[0], -mn[0]), 2), 'floorY': 0.0}


def records(functions):
    out = []
    for name, (addr, size) in sorted(functions.items(), key=lambda kv: kv[1][0]):
        if name.startswith('RPSportsPlayerData::get') and 'Physical' not in name and 'Debut' not in name and 'CreateID' not in name:
            field = name.split('::get', 1)[1]
            setter = 'RPSportsPlayerData::set' + field
            out.append({'field': field, 'getter': name, 'getterAddr': addr, 'getterSize': size,
                        'setter': setter if setter in functions else None})
    return out


def main():
    strings = load_strings()
    functions = load_functions()
    dol = Dol()
    anim_names, effects, models, scenes, ui = converted_indices()
    report = {'unitsPerMeter': UNITS_PER_METER}
    data = {
        'format': 'linuxsports-gameplay', 'version': 1, 'target': TARGET,
        'coordinateSystem': 'wii-gltf-right-handed-y-up' if WEB else 'unity-left-handed-mirrored-x',
        'unitsPerMeter': UNITS_PER_METER,
        'stateLayouts': {},
        'records': records(functions),
        'sports': {},
        # corpos Mii (RPSysKokeshi): a cabeça montada pelo MiiCharacterBuilder vai no osso head_set
        'avatarBodies': {k: v['prefab'] for k, v in sorted(models.items()) if k.startswith('ava_body')},
    }
    for state, items in STATE_LAYOUTS.items():
        data['stateLayouts'][state] = [lid for lid in (layout_id(ui, n, f) for n, f in items) if lid]
    for key, (prefixes, folder, maps) in SPORTS.items():
        anims, fx, mdl = sport_names(strings, prefixes, anim_names, effects, models)
        common = 'Scenes/src/minigames/%s/common/common.scene.json' % folder
        hud = {}
        for n in SPORT_HUD[key]:
            lid = layout_id(ui, n, folder)
            if lid:
                hud[n] = lid
        entry = {
            'commonScene': common.replace('Scenes/', '', 1) if common in scenes else None,
            'scenes': [m for m in maps if ('Scenes/' + m) in scenes],
            'animations': anims, 'effects': fx, 'models': mdl, 'hud': hud,
        }
        data['sports'][key] = entry
    data['sports']['bowling']['geometry'] = bowling_geometry(dol, report)
    data['sports']['golf']['courses'] = golf_courses(scenes, report)
    data['sports']['golf']['scenes'] = [c['scene'] for c in data['sports']['golf']['courses']]
    data['sports']['golf']['surfaces'] = {str(k): v for k, v in GOLF_SURFACES.items()}
    data['sports']['baseball']['geometry'] = baseball_geometry(report)
    data['sports']['tennis']['geometry'] = tennis_geometry(report)
    data['sports']['boxing']['geometry'] = boxing_geometry(report)
    report['counts'] = {k: {'animations': len(v['animations']), 'effects': len(v['effects']), 'models': len(v['models']), 'hud': len(v['hud'])}
                        for k, v in data['sports'].items()}
    report['records'] = len(data['records'])
    report['avatarBodies'] = sorted(data['avatarBodies'])
    report['stateLayouts'] = {k: len(v) for k, v in data['stateLayouts'].items()}
    write_json(STREAMING / 'Gameplay/gameplay_data.json', data)
    write_json(INDEX / 'gameplay-export.json', report)
    print(json.dumps(report['counts'], ensure_ascii=False))
    print('bowling', json.dumps(data['sports']['bowling']['geometry']))
    print('golf', [(c['id'], c['distanceMeters'], c['par']) for c in data['sports']['golf']['courses']])
    print('baseball fence (m)', [round(r / UNITS_PER_METER) for r in data['sports']['baseball']['geometry']['fence']])
    print('tennis', report['tennis'])
    print('records', [r['field'] for r in data['records']])
    print('stateLayouts', report['stateLayouts'])


if __name__ == '__main__':
    main()
