// Toca as 647 animações 2D sobre os 138 layouts, quadro a quadro, sem DOM.
// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyAnimationFrame, bindAnimation, createLayoutState } from '../viewer/src/ui/layout-renderer.js';

const ROOT = new URL('../', import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));
const manifest = json('manifest.json');
const byId = new Map(manifest.assets.map((a) => [a.assetId, a]));
const anims = manifest.assets.filter((a) => a.kind === 'animation');
const expectedMissing = new Map(json('index/anim-missing-targets.json').map((e) => [e.animation, e.missing]));

test('as 647 animações tocam do quadro 0 ao fim sem exceção; alvos ausentes são ignorados', () => {
  assert.equal(anims.length, 647);
  const withMissing = [];
  for (const a of anims) {
    const anim = json(a.main);
    const layout = byId.get(anim.layout.ref);
    assert.ok(layout, `${a.source}: layout ${anim.layout.name} não está no manifesto`);
    const state = createLayoutState(json(layout.main));
    const binding = bindAnimation(anim, state);
    const textures = anim.textures.map((t) => ({ ref: t.ref }));
    for (let f = 0; f <= anim.frameSize; f += 0.5) {
      const { moved, dirty } = applyAnimationFrame(binding, f, textures);
      for (const s of [...moved, ...dirty]) {
        for (const v of [...s.t, ...s.r, ...s.sc, ...s.size, s.alpha]) assert.ok(Number.isFinite(v), `${a.source} f=${f}: valor não finito`);
      }
    }
    if (binding.missing.length) {
      withMissing.push(a.assetId);
      assert.deepEqual([...new Set(binding.missing)].sort(), [...new Set(expectedMissing.get(a.assetId) ?? [])].sort(), a.source);
    }
  }
  assert.equal(withMissing.length, 47);
  assert.deepEqual(withMissing.sort(), [...expectedMissing.keys()].sort());
});
