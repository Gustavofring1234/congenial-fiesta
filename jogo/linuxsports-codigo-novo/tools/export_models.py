#!/usr/bin/env python3
"""Prepara os 259 modelos para o Unity: .glb + texturas por material + rig (ossos/skin/blendshapes).

Para cada models/**.model.json do wispt grava em linuxsports-codigo-novo/Assets/Nw4r/:
  Models/<caminho>.glb             cópia do .glb (importado pelo glTFast no Editor)
  Models/<caminho>.nw4r.json       sidecar lido por Assets/Editor/Nw4rModelPostprocessor.cs
  Textures/<brres>/<textura>.png   TODAS as camadas de textura de cada material, decodificadas do
                                   TEX0 do .brres original (o .glb só embute a camada 0)

Sidecar (coordenadas e ângulos no referencial do Wii; o C# converte para o Unity):
  materials[]: name, translucent, doubleSided, layers[{texture, png (relativo a Assets/), wrapS, wrapT, alpha}]
               objects[] (polígonos que usam o material). O vínculo vem do MDL0 (DrawOpa/DrawXlu),
               e não da lista global de texturas do .model.json.
  bones[]:     name, parent, mtxId, flags (MDL0: 0x20 = segment scale compensate), scale, rotate (graus, ordem XYZ),
               translate, world (3x4)
  meshes[]:    name (= nó do .glb), vertexCount, binding: static | rigid | skinned,
               bone (rigid), skin (skinned: base64 LE de vertexCount × [4×u16 osso, 4×f32 peso]),
               morphs[] (SHP0: {name, deltas: base64 LE de vertexCount × 3×f32})
A ordem de vértices é a do .glb (conferida: contagem e posição do 1º vértice de cada malha).

Uso: python3 tools/export_models.py [--only PADRAO] [--no-textures]
Relatório: index/models-export.json
"""
import argparse
import base64
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from nw4r import gx  # noqa: E402
from nw4r.anim import parse_pat0, parse_shp0  # noqa: E402
from nw4r.brres import Brres  # noqa: E402
from nw4r.mdl0 import Mdl0Geometry, mat_apply  # noqa: E402
from nw4r.paths import ASSETS, INDEX, LEGACY, NW4R, SRC, legacy_file, write_bytes, write_json  # noqa: E402


def glb_parts(path):
    b = path.read_bytes()
    n, = struct.unpack_from('<I', b, 12)
    return json.loads(b[20:20 + n]), b[20 + n + 8:]


def safe(name):
    return re.sub(r'[^A-Za-z0-9_.\-]', '_', name)


class TextureBank:
    """Decodifica texturas TEX0 sob demanda: primeiro no próprio .brres, depois nos vizinhos do mesmo
    contêiner (.carc), depois em qualquer .brres do jogo (texturas carregadas em tempo de execução)."""

    def __init__(self, write=True):
        self.write = write
        self.cache = {}      # caminho do brres -> Brres
        self.global_index = None
        self.out = {}        # (brres, nome) -> info

    def brres(self, path):
        if path not in self.cache:
            self.cache[path] = Brres(path.read_bytes())
        return self.cache[path]

    def _global(self):
        if self.global_index is None:
            self.global_index = {}
            for p in sorted(LEGACY.rglob('*.brres')):
                for n in self.brres(p).textures():
                    self.global_index.setdefault(n, p)
        return self.global_index

    def find(self, brres_path, name):
        b = self.brres(brres_path)
        if name in b.textures():
            return brres_path
        for p in sorted(brres_path.parent.glob('*.brres')):
            if name in self.brres(p).textures():
                return p
        return self._global().get(name)

    def get(self, brres_path, name):
        src = self.find(brres_path, name)
        if src is None:
            return None
        key = (src, name)
        if key in self.out:
            return self.out[key]
        b = self.brres(src)
        w, h, rgba, fmt = b.decode_texture(name)
        rel_dir = src.relative_to(LEGACY / 'raw').with_suffix('').as_posix()
        png = NW4R / 'Textures' / rel_dir / f'{safe(name)}.png'
        if self.write:
            write_bytes(png, gx.png_bytes(w, h, rgba))
        info = {'png': png.relative_to(ASSETS).as_posix(), 'width': w, 'height': h,
                'format': gx.FORMAT_NAMES.get(fmt, fmt), 'alpha': gx.has_alpha(rgba),
                'from': src.relative_to(LEGACY).as_posix()}
        self.out[key] = info
        return info


def skin_blob(geom, verts):
    out_idx, out_w = [], []
    for ip, mid, pos, m in verts:
        inf = sorted(geom.influences(mid), key=lambda t: -t[1])[:4]
        tot = sum(w for _, w in inf) or 1.0
        inf = [(b, w / tot) for b, w in inf] + [(0, 0.0)] * (4 - len(inf))
        out_idx.append([b for b, _ in inf])
        out_w.append([w for _, w in inf])
    raw = b''.join(struct.pack('<4H4f', *i, *w) for i, w in zip(out_idx, out_w))
    return base64.b64encode(raw).decode()


def mesh_binding(geom, mesh):
    mids = {v[1] for v in mesh['vertices']}
    bone_sets = set()
    for mid in mids:
        inf = geom.influences(mid)
        bone_sets.add(tuple(sorted(b for b, _ in inf)))
    if not geom.bones or bone_sets == {()}:
        return {'binding': 'static'}
    if len(bone_sets) == 1:
        only = next(iter(bone_sets))
        if len(only) == 1:
            return {'binding': 'rigid', 'bone': only[0]}
    return {'binding': 'skinned', 'skin': skin_blob(geom, mesh['vertices'])}


def morphs_for(geom, mesh, shp0s):
    """Blendshapes SHP0 cuja base é o array de posições desta malha."""
    base_name = geom.vert_arrays.get(mesh['posId'], (None,))[0]
    by_name = {n: arr for n, arr in geom.vert_arrays.values()}
    out = []
    for a in shp0s:
        for sh in a['shapes']:
            if sh['base'] != base_name:
                continue
            for t in sh['targets']:
                arr = by_name.get(t['vertexSet'])
                if arr is None:
                    continue
                deltas = []
                for ip, mid, pos, m in mesh['vertices']:
                    tp = arr[ip] if ip < len(arr) else geom.verts[mesh['posId']][ip]
                    tp = mat_apply(m, tp) if m else tp
                    deltas += [tp[0] - pos[0], tp[1] - pos[1], tp[2] - pos[2]]
                if any(abs(x) > 1e-6 for x in deltas):
                    out.append({'name': t['vertexSet'], 'animation': a['name'],
                                'deltas': base64.b64encode(struct.pack('<%df' % len(deltas), *deltas)).decode()})
    return out


def export_model(mj, bank, args):
    brres_path = legacy_file(mj['brres'])
    br = bank.brres(brres_path)
    off = next(o for n, o in br.entries('MDL0') if n == mj['model'])
    geom = Mdl0Geometry(br, mj['model'], off)
    meshes = geom.meshes()
    gj, gbin = glb_parts(SRC / mj['glb'])
    if [m['name'] for m in gj['meshes']] != [m['name'] for m in meshes]:
        raise ValueError('ordem de malhas difere do .glb')
    for m, g in zip(meshes, gj['meshes']):
        acc = gj['accessors'][g['primitives'][0]['attributes']['POSITION']]
        if acc['count'] != len(m['vertices']):
            raise ValueError(f"{m['name']}: {acc['count']} vértices no .glb, {len(m['vertices'])} reproduzidos")
    shp0s = [parse_shp0(br, n, o) for n, o in br.entries('SHP0')]
    # texturas trocadas pelo PAT0 do mesmo .brres (o Editor as liga ao Nw4rModelInfo para o player)
    pattern = []
    if not args.no_textures:
        names = set()
        for pn, po in br.entries('PAT0'):
            if ('PAT0', pn) not in {(a['type'], a['name']) for a in mj.get('animations', [])}:
                continue
            pa = parse_pat0(br, pn, po)
            names |= {t for t in pa['textures'] if t}
        for tn in sorted(names):
            info = bank.get(brres_path, tn)
            pattern.append({'name': tn, 'png': info['png'] if info else None})
    materials = []
    for mat in mj.get('materials', []):
        layers = []
        for layer in mat['layers']:
            info = bank.get(brres_path, layer['texture']) if layer['texture'] and not args.no_textures else None
            layers.append({'texture': layer['texture'], 'png': info['png'] if info else None,
                           'wrapS': layer['wrapS'], 'wrapT': layer['wrapT'],
                           'alpha': info['alpha'] if info else False})
        materials.append({'name': mat['name'], 'translucent': mat['translucent'], 'doubleSided': mat['doubleSided'],
                          'inGlb': mat['inGlb'], 'objects': mat['objects'], 'layers': layers})
    out_meshes = []
    for m in meshes:
        entry = {'name': m['name'], 'vertexCount': len(m['vertices']), 'translucent': m['translucent']}
        entry.update(mesh_binding(geom, m))
        mo = morphs_for(geom, m, shp0s)
        if mo:
            entry['morphs'] = mo
        out_meshes.append(entry)
    bones = [{k: b[k] for k in ('name', 'parent', 'mtxId', 'flags', 'scale', 'rotate', 'translate', 'world', 'billboard')}
             for b in geom.bones]
    rel = Path(mj['glb']).relative_to('models')
    glb_dst = NW4R / 'Models' / rel
    sidecar = {
        'format': 'nw4r-unity-model', 'version': 1, 'assetId': mj['assetId'], 'model': mj['model'],
        'brres': mj['brres'], 'glb': glb_dst.relative_to(ASSETS).as_posix(),
        'coordinateSystem': 'wii-right-handed-y-up (o importador espelha X, igual ao glTFast)',
        'materials': materials, 'bones': bones, 'meshes': out_meshes,
        'animations': mj.get('animations', []),
        'patternTextures': pattern,
    }
    if not args.dry_run:
        data = (SRC / mj['glb']).read_bytes()
        if not glb_dst.exists() or hashlib.sha1(glb_dst.read_bytes()).digest() != hashlib.sha1(data).digest():
            write_bytes(glb_dst, data)
        write_json(glb_dst.parent / (glb_dst.stem + '.nw4r.json'), sidecar, compact=True)
    counts = {'static': 0, 'rigid': 0, 'skinned': 0}
    for m in out_meshes:
        counts[m['binding']] += 1
    return {'model': mj['model'], 'bones': len(bones), 'meshes': counts,
            'morphs': sum(len(m.get('morphs', [])) for m in out_meshes),
            'layers': sum(len(m['layers']) for m in materials),
            'missingTextures': sorted({l['texture'] for m in materials for l in m['layers'] if l['texture'] and not l['png']})}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='regex no caminho do .model.json')
    ap.add_argument('--no-textures', action='store_true')
    ap.add_argument('--dry-run', action='store_true', help='só valida, não grava')
    args = ap.parse_args()
    bank = TextureBank(write=not args.dry_run)
    rx = re.compile(args.only) if args.only else None
    report, errors = {}, {}
    files = sorted((SRC / 'models').rglob('*.model.json'))
    for f in files:
        if rx and not rx.search(f.as_posix()):
            continue
        mj = json.loads(f.read_text(encoding='utf-8'))
        try:
            report[mj['assetId']] = export_model(mj, bank, args)
        except (OSError, KeyError, ValueError, StopIteration, struct.error) as e:
            errors[mj['assetId']] = f'{type(e).__name__}: {e}'
    summary = {
        'models': len(report), 'errors': errors,
        'bones': sum(r['bones'] for r in report.values()),
        'meshes': {k: sum(r['meshes'][k] for r in report.values()) for k in ('static', 'rigid', 'skinned')},
        'morphTargets': sum(r['morphs'] for r in report.values()),
        'textureLayers': sum(r['layers'] for r in report.values()),
        'texturesWritten': len(bank.out),
        'missingTextures': {k: r['missingTextures'] for k, r in report.items() if r['missingTextures']},
    }
    if not args.dry_run:
        write_json(INDEX / 'models-export.json', {'summary': summary, 'models': report})
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
