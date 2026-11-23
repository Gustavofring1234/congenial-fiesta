import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { findFiles, hasGameData, read } from './helpers.ts';
import { buildU8 } from '../src/parsers/u8.ts';
import { yaz0Compress } from '../src/parsers/yaz0.ts';
import { bundleToZip, convertContainer } from '../src/serializers/bundle.ts';
import { validateBundle, Manifest } from '../src/schemas/bundle.schema.ts';
import { WebAssetLoader } from '../src/web-runtime/WebAssetLoader.ts';
import { makeAssetId } from '../src/binary/ids.ts';

const real = describe.skipIf(!hasGameData);
const enc = new TextEncoder(), dec = new TextDecoder();

/** Monta um .carc de verdade (Yaz0 + U8 com .arc aninhados) a partir dos .arc extraídos do jogo. */
function makeCarc(): Uint8Array {
  const arcs = findFiles('.arc').filter((p) => p.includes('/RPSportsCommon/us/local.carc/'));
  return yaz0Compress(buildU8(arcs.map((p) => ({ path: p.split('/').slice(-1)[0], data: read(p) }))));
}

real('.carc -> .zip + manifest.json', () => {
  const carc = makeCarc();
  const bundle = convertContainer('local.carc', carc);
  const zip = bundleToZip(bundle);
  const files = unzipSync(zip);

  it('detecta Yaz0 + U8 e converte os arquivos internos', () => {
    expect(bundle.manifest.source).toEqual({ name: 'local.carc', container: 'u8', compression: 'yaz0' });
    const kinds = new Set(bundle.manifest.assets.map((a) => a.kind));
    expect(kinds).toEqual(new Set(['texture', 'animation', 'layout']));
    expect(bundle.manifest.assets.filter((a) => a.error)).toEqual([]);
    expect(Object.keys(files)).toContain('manifest.json');
  });

  it('manifest passa na validação cruzada (sem links quebrados)', () => {
    const r = validateBundle(JSON.parse(dec.decode(files['manifest.json'])), (p) => files[p]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('caminhos são POSIX relativos e IDs são determinísticos', () => {
    for (const p of Object.keys(files)) expect(p).not.toMatch(/\\|^\/|\.\.\//);
    const again = bundleToZip(convertContainer('local.carc', carc));
    expect(again).toEqual(zip); // saída byte a byte idêntica
    const a = bundle.manifest.assets.find((x) => x.kind === 'texture')!;
    expect(a.assetId).toBe(makeAssetId('texture', a.source));
  });

  it('animações apontam para texturas de outro .arc do mesmo .carc', () => {
    const cross = bundle.manifest.assets.filter((a) => a.kind === 'animation' && a.refs.some((r) => {
      const t = bundle.manifest.assets.find((x) => x.assetId === r)!;
      return t.kind === 'texture' && t.source.split('/')[0] !== a.source.split('/')[0];
    }));
    expect(cross.length).toBeGreaterThan(0);
  });

  it('WebAssetLoader resolve animação -> texturas/layout em memória', async () => {
    const lib = await WebAssetLoader.fromZip(zip);
    const anim = lib.list('animation').find((a) => a.refs.length > 1)!;
    const res = await lib.resolveAnimation(anim.assetId);
    expect(res.textures.some((t) => t.texture !== null)).toBe(true);
    const t = res.textures.find((x) => x.texture)!.texture!;
    expect(t.meta.images[0].file).toMatch(/\.png$/);
    expect(t.images[0]).toBeDefined();
    if (res.meta.layout?.ref) expect(res.layout?.asset.kind).toBe('layout');
  });

  it('detecta referência quebrada, arquivo ausente e tipo errado', () => {
    const m = Manifest.parse(JSON.parse(dec.decode(files['manifest.json'])));
    const anim = m.assets.find((a) => a.kind === 'animation' && a.refs.length)!;
    const broken = structuredClone(m);
    broken.assets.find((a) => a.assetId === anim.assetId)!.refs.push('tex_ffffffffffffffff');
    expect(validateBundle(broken, (p) => files[p]).errors.join('\n')).toMatch(/referência quebrada/);

    const missing = validateBundle(m, (p) => (p.endsWith('.png') ? undefined : files[p]));
    expect(missing.errors.join('\n')).toMatch(/arquivo ausente/);

    const wrongKind = structuredClone(m);
    const animJson = JSON.parse(dec.decode(files[anim.main]));
    const layoutId = m.assets.find((a) => a.kind === 'layout')!.assetId;
    animJson.textures[0].ref = layoutId;
    const patched = { ...files, [anim.main]: enc.encode(JSON.stringify(animJson)) };
    wrongKind.assets.find((a) => a.assetId === anim.assetId)!.refs.push(layoutId);
    expect(validateBundle(wrongKind, (p) => patched[p]).errors.join('\n')).toMatch(/esperado "texture"/);

    const badPath = structuredClone(m);
    badPath.assets[0].files.push('../fora.png');
    expect(validateBundle(badPath, (p) => files[p]).ok).toBe(false);
  });
});

describe('bundle com arquivo corrompido', () => {
  it('mantém o original como binário e registra o erro', () => {
    const u8 = buildU8([{ path: 'timg/ruim.tpl', data: Uint8Array.of(0x00, 0x20, 0xaf, 0x30, 0, 0, 0, 1, 0, 0, 0, 0x0c, 0xff) }]);
    const b = convertContainer('x.arc', u8);
    const a = b.manifest.assets[0];
    expect(a.kind).toBe('binary');
    expect(a.error).toMatch(/tpl/);
    expect(validateBundle(b.manifest, (p) => b.files.get(p)).ok).toBe(true);
  });
});
