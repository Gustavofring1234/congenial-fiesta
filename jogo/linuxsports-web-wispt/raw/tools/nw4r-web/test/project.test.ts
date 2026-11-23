/**
 * Partes novas: BRLYT completo, PMP, índice BRRES, build do projeto global e WebAssetLoader (model/scene).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenPanes, parseBrlyt, parseBrlytRefs } from '../src/parsers/brlyt.ts';
import { parsePmp } from '../src/parsers/pmp.ts';
import { parseBrresIndex } from '../src/parsers/brres-index.ts';
import { buildProject } from '../src/build-project.ts';
import { WebAssetLoader } from '../src/web-runtime/WebAssetLoader.ts';
import { GAME_ROOT, findFiles, hasGameData, read } from './helpers.ts';

/** Escritor big-endian mínimo com f32 e patch. */
class W {
  b: number[] = [];
  get length() { return this.b.length; }
  u8(v: number) { this.b.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v >> 8).u8(v); }
  u32(v: number) { return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff); }
  f32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v); return this.u32(d.getUint32(0)); }
  str(s: string, n: number) { for (let i = 0; i < n; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0); return this; }
  zeros(n: number) { for (let i = 0; i < n; i++) this.u8(0); return this; }
  patch32(o: number, v: number) { [24, 16, 8, 0].forEach((s, i) => { this.b[o + i] = (v >>> s) & 0xff; }); }
  done() { return Uint8Array.from(this.b); }
}

function section(magic: string, body: (w: W) => void): number[] {
  const w = new W().str(magic, 4).u32(0);
  body(w);
  while (w.length % 4) w.u8(0);
  w.patch32(4, w.length);
  return w.b;
}

function pane(w: W, name: string, flags = 1, size: [number, number] = [100, 50]) {
  w.u8(flags).u8(4).u8(255).u8(0).str(name, 16).zeros(8)
    .f32(10).f32(-20).f32(0).f32(0).f32(0).f32(45).f32(1).f32(2).f32(size[0]).f32(size[1]);
}

/** Layout sintético: raiz -> (imagem, texto), 2 materiais, 1 grupo. */
function buildBrlyt(): Uint8Array {
  const secs: number[][] = [];
  secs.push(section('lyt1', (w) => w.u8(1).zeros(3).f32(608).f32(456)));
  const nameList = (names: string[]) => (w: W) => {
    w.u16(names.length).u16(0);
    const base = w.length;
    const strings: number[] = [];
    let off = names.length * 8;
    for (const n of names) { w.u32(off).u32(0); off += n.length + 1; }
    for (const n of names) { strings.push(...[...n].map((c) => c.charCodeAt(0)), 0); }
    strings.forEach((c) => w.u8(c));
    void base;
  };
  secs.push(section('txl1', nameList(['a.tpl', 'b.tpl'])));
  secs.push(section('fnl1', nameList(['f.brfnt'])));
  secs.push(section('mat1', (w) => {
    w.u16(2).u16(0);
    const table = w.length;
    w.u32(0).u32(0);
    const mat = (name: string, tex: number) => {
      w.patch32(table + (name === 'M0' ? 0 : 4), w.length);
      w.str(name, 20);
      for (let i = 0; i < 12; i++) w.u16(i === 4 ? 0xff : 0); // tevColor[1].r = 255
      w.zeros(16); // konst
      w.u32((1 << 0) | (1 << 27)); // 1 TexMap + MatColor
      w.u16(tex).u8(1).u8(2); // texmap: textura, REPEAT, MIRROR
      w.u8(9).u8(8).u8(7).u8(6); // cor do material
    };
    mat('M0', 1);
    mat('M1', 0);
  }));
  secs.push(section('pan1', (w) => pane(w, 'RootPane')));
  secs.push(section('pas1', () => {}));
  secs.push(section('pic1', (w) => {
    pane(w, 'P_img');
    for (let i = 0; i < 4; i++) w.u32(0xffffffff);
    w.u16(0).u8(1).u8(0);
    [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([u, v]) => w.f32(u).f32(v));
  }));
  secs.push(section('txt1', (w) => {
    const start = w.length - 8;
    pane(w, 'T_label', 3);
    w.u16(8).u16(6).u16(1).u16(0).u8(4).u8(1).u16(0);
    const strOff = w.length;
    w.u32(0).u32(0xff0000ff).u32(0x00ff00ff).f32(24).f32(24).f32(1).f32(2);
    w.patch32(strOff, w.length - start);
    w.u16(0x30c6).u16(0x30cb).u16(0);
  }));
  secs.push(section('pae1', () => {}));
  secs.push(section('grp1', (w) => { w.str('G_all', 16).u16(2).u16(0).str('P_img', 16).str('T_label', 16); }));
  const body = secs.flat();
  const h = new W().str('RLYT', 4).u16(0xfeff).u16(8).u32(16 + body.length).u16(16).u16(secs.length);
  return Uint8Array.from([...h.b, ...body]);
}

describe('BRLYT completo', () => {
  const lyt = parseBrlyt(buildBrlyt());

  it('lê tela, listas, materiais e a árvore de painéis', () => {
    expect(lyt).toMatchObject({ width: 608, height: 456, centered: true, textures: ['a.tpl', 'b.tpl'], fonts: ['f.brfnt'] });
    expect(lyt.materials.map((m) => m.name)).toEqual(['M0', 'M1']);
    expect(lyt.materials[0]).toMatchObject({ textureMaps: [{ texture: 1, wrapS: 1, wrapT: 2 }], color: [9, 8, 7, 6] });
    expect(lyt.materials[0].tevColors[1][0]).toBe(255);
    expect(lyt.root?.name).toBe('RootPane');
    expect(lyt.root?.children.map((c) => [c.type, c.name])).toEqual([['picture', 'P_img'], ['text', 'T_label']]);
    const [img, txt] = lyt.root!.children;
    expect(img).toMatchObject({ translate: [10, -20, 0], rotate: [0, 0, 45], scale: [1, 2], size: [100, 50], origin: 4, alpha: 255 });
    expect(img.picture?.texCoords[0][3]).toEqual([1, 1]);
    expect(txt.text).toMatchObject({ text: 'テニ', material: 1, font: 0, fontSize: [24, 24], alignment: 1, colors: [[255, 0, 0, 255], [0, 255, 0, 255]] });
    expect(txt.influencedAlpha).toBe(true);
    expect(lyt.groups).toEqual([{ name: 'G_all', panes: ['P_img', 'T_label'], children: [] }]);
  });

  it('lê o nome do painel em +0x0C (corrige o offset +0x18 da versão anterior)', () => {
    expect(parseBrlytRefs(buildBrlyt()).panes).toEqual(['RootPane', 'P_img', 'T_label']);
  });

  it.skipIf(!hasGameData)('lê os 138 layouts reais sem índices fora do intervalo', () => {
    let panes = 0;
    for (const f of findFiles('.brlyt')) {
      const l = parseBrlyt(read(f));
      for (const p of flattenPanes(l.root)) {
        panes++;
        const mats = [p.picture?.material, p.text?.material, p.window?.content.material].filter((x) => x !== undefined) as number[];
        for (const m of mats) expect(m).toBeLessThan(l.materials.length);
        if (p.text) expect(p.text.font).toBeLessThan(l.fonts.length);
      }
      for (const m of l.materials) for (const t of m.textureMaps) expect(t.texture).toBeLessThan(l.textures.length);
    }
    expect(panes).toBeGreaterThan(3000);
  });
});

describe('PMP', () => {
  it('lê objetos e monta eixos na ordem Z, Y, X (det = +1)', () => {
    const w = new W().str('PMPF', 4).zeros(12).u16(1).zeros(0x2e).u32(0x80).zeros(0x80 - 0x44);
    w.u16(1).u16(7).u16(2).u16(0).f32(1).f32(2).f32(3).f32(2).f32(2).f32(2)
      .f32(0).f32(0).f32(1).f32(0).f32(1).f32(0).f32(1).f32(0).f32(0).u32(0xffffffff).zeros(0x58 - 0x48);
    const [o] = parsePmp(w.done());
    expect(o).toMatchObject({ typeId: 7, variant: 2, position: [1, 2, 3], scale: [2, 2, 2], parent: -1 });
    expect(o.axes).toEqual({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  });
});

describe('BRRES (índice)', () => {
  it.skipIf(!hasGameData)('lista modelos, texturas e animações', () => {
    const totals = { models: 0, textures: 0, animations: 0 };
    for (const f of findFiles('.brres')) {
      const i = parseBrresIndex(read(f));
      totals.models += i.models.length; totals.textures += i.textures.length; totals.animations += i.animations.length;
    }
    expect(totals).toEqual({ models: 259, textures: 1196, animations: 301 });
  });
});

describe.skipIf(!hasGameData)('projeto web global', () => {
  it('gera um bundle válido e o loader resolve cena -> modelos/colisão e layout -> fontes/animações', async () => {
    const out = mkdtempSync(join(tmpdir(), 'lsw-'));
    try {
      const { summary, manifest } = await buildProject(GAME_ROOT, out, () => {});
      expect(summary.validation).toMatchObject({ ok: true, errors: 0 });
      expect(summary.conversionErrors).toEqual([]);
      const fakeFetch = (async (u: string | URL) => {
        try { return new Response(readFileSync(join(out, new URL(String(u)).pathname.slice(1)))); } catch { return new Response(null, { status: 404 }); }
      }) as typeof fetch;
      const lib = await WebAssetLoader.fromUrl('http://x/manifest.json', fakeFetch);
      const golf = manifest.assets.find((a) => a.kind === 'scene' && a.source.endsWith('glf_course_fc1.carc'))!;
      const scene = await lib.resolveScene(golf.assetId);
      expect(scene.models.length).toBeGreaterThan(0);
      expect(new TextDecoder().decode(scene.models[0].glb.subarray(0, 4))).toBe('glTF');
      expect(scene.collision[0].glb?.length).toBeGreaterThan(0);
      expect(scene.meta.objects.length).toBe(119);
      const layout = lib.bySourcePath('src/core/shared/RPSportsCommon/us/local.carc/sportsTop.arc.d/blyt/sportsTop_00.brlyt')!;
      const lr = await lib.resolveLayout(layout.assetId);
      expect(lr.meta.root?.name).toBe('RootPane');
      expect(lr.fonts.every((f) => f.font)).toBe(true);
      expect(lib.animationsFor(layout.assetId).length).toBeGreaterThan(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
