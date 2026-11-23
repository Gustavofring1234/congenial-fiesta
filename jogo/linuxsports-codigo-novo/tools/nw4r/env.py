"""Arquivos de ambiente do EGG / RPGraphics (somente leitura): .plight, .plmap, .pblm, .pmmisc, .bti.

Layouts tirados dos leitores do próprio main.dol (endereços de functions.tsv; rotinas que o
descompilador truncou foram desmontadas do DOL):

.plight  "LGHT"  EGG::LightManager::SetBinaryInner @ 80090a7c (versão 1)
  0x10 u16 número de LOBJ · 0x14 8 × RGBA cores ambiente (destino com passo 8)
  0x34 RGBA cor global (LightManager+0x14; LightTexture a usa como cor de fundo: FUN_80092280)
  0x48 LOBJ[n], 0x50 bytes cada (EGG::LightObject::SetBinaryInner @ 8009e74c):
    0x10 u8 spotFn (GXInitLightSpot) · 0x11 u8 distAttnFn (GXInitLightDistAttn)
    0x12 u8 espaço (CalcView @ 8009da24: 0 mundo, 1 mundo + meio-vetor especular, 2 coordenadas já de
         câmera, 3 na câmera apontando para a frente, 4 atrás da câmera apontando para ela)
    0x13 u8 tipo GX (InitGX @ 8009ddfc: 0 ponto, 1 direcional, 2 spot)
    0x14 u16 índice da luz · 0x16 u16 flags (bit 0 ligada; 0x20 entra na LightTexture
         (correctLightObject); 0x40 entra no GX/G3D; 0x80 AttnA manual em vez de spot; 0x100 AttnK
         manual em vez de DistAttn; 0x200/0x400 cor/alfa habilitados (CopyToG3D_World); 0x800 especular)
    0x18 vec3 posição · 0x24 vec3 alvo (direção = alvo - posição)
    0x30 f32 intensidade (cor final = min(255, cor × intensidade): LightObject::Calc)
    0x34 RGBA cor · 0x38 RGBA segunda cor (vai para a TEV kcolor em LightTexture::addLight)
    0x3c f32 corte do spot (graus) · 0x40 f32 distância de referência · 0x44 f32 brilho de referência
.plmap   "LMAP"  EGG::LightTextureManager::SetBinaryInner @ 80093940 (versão 0)
  0x10 u16 número de LTEX; LTEX a partir de 0x20, cada um com tamanho no próprio cabeçalho.
  LTEX (EGG::LightTexture::SetBinaryInner @ 80092b40, desmontado): 0x10 u16 nº de luzes, 0x14 nome
  da textura (char[32], ex. "lm_0"), 0x34 u8 tipo de desenho, 0x38 u32 máscara de luzes (bit = índice),
  0x3c (f32 peso, u8 modo, 3 pad) por luz. Peso < 1 escala a cor (CalcFinalDirColor @ 8009dc58);
  modo = uma das 10 rampas de LightTexture::initialize @ 80091920.
.pblm    "PBLM"  EGG::DrawPathBloom::SetBinaryInner @ 8008b1f0 (versão 1)
  0x10 f32 limiar · 0x14 RGBA cor do limiar (PostEffectMask: textura - limiar × cor, saturado)
  0x18 RGBA cor do bloom (alfa = força) · 0x1c u16 flags · 0x20/0x40/0x60 três estágios de blur
  (f32 raio, f32 intensidade, mais campos que o construtor não inicializa) · 0x80 u8 nº de estágios
  · 0x81 u8 modo · 0x9c f32, 0xa0 f32 (pares iniciados com o mesmo valor no construtor @ 80089f68).
.pmmisc  "MMSC"  RPGrpModelMisc: 0x10 u16 n, registros de 0x28 (nome[0x20], u8 flag, f32 valor).
  RPGrpModelMisc::SetBinaryInner @ 801ae344 tem 4 bytes (só blr): esta versão do jogo ignora o arquivo.
.bti     textura GX avulsa (cabeçalho de 32 bytes), decodificada por nw4r.gx.

Os arquivos foram gravados a partir de buffers não zerados: bytes fora dos campos acima são lixo
(nomes de material repetidos, "LOBJ" no meio de um LTEX). Só os campos lidos pelo jogo são exportados.
"""
import struct

from nw4r import gx

LIGHT_TYPES = {0: 'point', 1: 'directional', 2: 'spot'}
LIGHT_SPACES = {0: 'world', 1: 'worldSpecular', 2: 'view', 3: 'cameraFront', 4: 'cameraBack'}
FLAG_BITS = {'enabled': 0x1, 'lightTexture': 0x20, 'gx': 0x40, 'manualAttnA': 0x80, 'manualAttnK': 0x100,
             'colorEnable': 0x200, 'alphaEnable': 0x400, 'specular': 0x800}

# LightTexture::initialize @ 80091920: 10 rampas de 64 texels, preto -> branco, com
# CpuTexture::fillGradationTable(tipo, 's', início, fim, ..., deslocada de meia tabela).
# Texel j corresponde a N·L = (j - 32) / 32. Tipos (makeGradationTable @ 80085fe0, tabela de saltos
# em 803975a0): 0 linear, 1 t², 2 t⁴, 3 t⁸, 4 t¹⁶, 5 1-(1-t)², 6 1-(1-t)⁴.
GRADATION_KINDS = [0, 0, 0, 1, 2, 3, 4, 0, 5, 5]   # tabela em 803796c8
RAMP_RANGES = [(0x21, 0x3f), (0x01, 0x3f), (0x11, 0x3f), (0x21, 0x3f), (0x21, 0x3f), (0x21, 0x3f),
               (0x21, 0x3f), (0x05, 0x23), (0x0b, 0x29), (0x0e, 0x2c)]
RAMP_SIZE = 64


def _f(b, o): return struct.unpack('>f', b[o:o + 4])[0]
def _h(b, o): return struct.unpack('>H', b[o:o + 2])[0]
def _i(b, o): return struct.unpack('>I', b[o:o + 4])[0]
def _rgba(b, o): return list(b[o:o + 4])
def _vec(b, o): return [round(_f(b, o + 4 * k), 6) for k in range(3)]
def _r(x): return round(x, 6)


def _check(b, magic, version=None):
    if b[:4] != magic:
        raise ValueError(f'esperado {magic!r}, achado {b[:4]!r}')
    if _i(b, 4) != len(b):
        raise ValueError(f'{magic!r}: tamanho no cabeçalho {_i(b, 4)} != arquivo {len(b)}')
    if version is not None and b[8] != version:
        raise ValueError(f'{magic!r}: versão {b[8]} (o leitor suporta {version})')


def gradation(kind, t):
    if kind == 1: return t ** 2
    if kind == 2: return t ** 4
    if kind == 3: return t ** 8
    if kind == 4: return t ** 16
    if kind == 5: return 1 - (1 - t) ** 2
    if kind == 6: return 1 - (1 - t) ** 4
    return t


def ramps():
    """As 10 rampas como listas de 64 valores 0..1 indexadas por j = 32 + 32·(N·L)."""
    out = []
    for mode, (start, end) in enumerate(RAMP_RANGES):
        kind = GRADATION_KINDS[mode]
        row = []
        for j in range(RAMP_SIZE):
            t = (j - start) / (end - start)
            row.append(0.0 if t <= 0 else 1.0 if t >= 1 else _r(gradation(kind, t)))
        out.append({'mode': mode, 'kind': kind, 'start': start, 'end': end, 'values': row})
    return out


def parse_light_object(b):
    """Um LOBJ de 0x50 bytes (cabeçalho já conferido por parse_plight)."""
    flags = _h(b, 0x16)
    gtype, space = b[0x13], b[0x12]
    return {
        'index': _h(b, 0x14), 'flags': flags,
        **{k: bool(flags & v) for k, v in FLAG_BITS.items()},
        'type': LIGHT_TYPES.get(gtype, f'unknown{gtype}'), 'space': LIGHT_SPACES.get(space, f'unknown{space}'),
        'spotFn': b[0x10], 'distAttnFn': b[0x11],
        'position': _vec(b, 0x18), 'target': _vec(b, 0x24),
        'intensity': _r(_f(b, 0x30)), 'color': _rgba(b, 0x34), 'secondaryColor': _rgba(b, 0x38),
        'spotCutoff': _r(_f(b, 0x3c)), 'refDistance': _r(_f(b, 0x40)), 'refBrightness': _r(_f(b, 0x44)),
    }


def parse_plight(b):
    _check(b, b'LGHT', 1)
    n = _h(b, 0x10)
    lights = []
    for k in range(n):
        o = 0x48 + 0x50 * k
        rec = b[o:o + 0x50]
        if rec[:4] != b'LOBJ' or _i(rec, 4) != 0x50 or rec[8] != 1:
            raise ValueError(f'LOBJ {k} inválido em {o:#x}')
        lights.append(parse_light_object(rec))
    return {'ambientColors': [_rgba(b, 0x14 + 4 * k) for k in range(8)], 'globalColor': _rgba(b, 0x34),
            'lights': lights}


def parse_plmap(b):
    _check(b, b'LMAP', 0)
    n = _h(b, 0x10)
    textures, o = [], 0x20
    for _ in range(n):
        if b[o:o + 4] != b'LTEX' or b[o + 8] != 0:
            raise ValueError(f'LTEX inválido em {o:#x}')
        size, count = _i(b, o + 4), _h(b, o + 0x10)
        if size != 0x3c + 8 * count:
            raise ValueError(f'LTEX em {o:#x}: tamanho {size} != 0x3c + 8×{count}')
        name = b[o + 0x14:o + 0x34].split(b'\0')[0].decode('ascii')
        mask = _i(b, o + 0x38)
        entries = [{'weight': _r(_f(b, o + 0x3c + 8 * k)), 'mode': b[o + 0x40 + 8 * k]} for k in range(count)]
        bad = [e['mode'] for e in entries if e['mode'] >= len(RAMP_RANGES)]
        if bad:
            raise ValueError(f'{name}: modo de rampa fora de 0..9: {bad}')
        textures.append({'name': name, 'drawType': b[o + 0x34], 'lightMask': mask,
                         'lights': [k for k in range(32) if mask >> k & 1], 'entries': entries})
        o += size
    if o != len(b):
        raise ValueError(f'LMAP: sobram {len(b) - o} bytes')
    return {'textures': textures}


def parse_pblm(b):
    """Versões 1 e 0 têm o mesmo layout; na 0 o jogo ignora 0x9c/0xa0 e grava a constante
    SDA2-0x73ac (= 0.0) nos dois campos (desmontagem @ 8008b540)."""
    _check(b, b'PBLM')
    if b[8] not in (0, 1):
        raise ValueError(f'PBLM: versão {b[8]} não suportada')
    stages = [{'radius': _r(_f(b, o)), 'intensity': _r(_f(b, o + 4))} for o in (0x20, 0x40, 0x60)]
    composite = [_r(_f(b, 0x9c)), _r(_f(b, 0xa0))] if b[8] == 1 else [0.0, 0.0]
    return {'version': b[8], 'threshold': _r(_f(b, 0x10)), 'thresholdColor': _rgba(b, 0x14),
            'color': _rgba(b, 0x18), 'flags': _h(b, 0x1c), 'stageCount': b[0x80], 'mode': b[0x81],
            'stages': stages, 'composite': composite}


def parse_pmmisc(b):
    _check(b, b'MMSC')
    n = _h(b, 0x10)
    if 0x14 + 0x28 * n != len(b):
        raise ValueError(f'MMSC: {n} registros não fecham {len(b)} bytes')
    recs = []
    for k in range(n):
        o = 0x14 + 0x28 * k
        recs.append({'material': b[o:o + 0x20].split(b'\0')[0].decode('ascii'), 'flag': b[o + 0x20],
                     'value': _r(_f(b, o + 0x24))})
    return {'usedByGame': False, 'reason': 'RPGrpModelMisc::SetBinaryInner @ 801ae344 é vazio (blr)',
            'materials': recs}


def parse_bti(b):
    """-> (meta, rgba bytes)."""
    fmt, _alpha, w, h, ws, wt = struct.unpack('>BBHHBB', b[:8])
    pal_fmt, pal_n, pal_off = b[0x09], _h(b, 0x0a), _i(b, 0x0c)
    mips, data_off = b[0x18], _i(b, 0x1c)
    pal = gx.palette(b, pal_off, pal_n, pal_fmt) if fmt in (8, 9, 10) else None
    rgba = gx.decode(b, data_off, w, h, fmt, pal)
    return {'format': fmt, 'width': w, 'height': h, 'wrapS': ws, 'wrapT': wt, 'mipmaps': mips,
            'paletteFormat': pal_fmt if pal else None}, rgba
