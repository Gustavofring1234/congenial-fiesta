// Etapa 2 no three.js: 301 animações (CHR0/SRT0/PAT0/CLR0/VIS0/SHP0/SCN0), órfãs, .vrma nos avatares VRM e partículas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, mod, syntheticVrm1 } from './helpers.mjs';

const { THREE, VRM, store } = await setup();
const { loadModel } = await mod('engine/assets/ModelLoader.js');
const { AnimationLibrary } = await mod('engine/animation/AnimationLibrary.js');
const { chr0Clip, clipFor } = await mod('engine/animation/Nw4rClipFactory.js');
const { Nw4rMaterialAnimator } = await mod('engine/animation/Nw4rMaterialAnimator.js');
const { sampleCurve } = await mod('engine/animation/Nw4rCurves.js');
const { VrmaLibrary, loadVrma, vrmaClip } = await mod('engine/animation/VrmaPlayer.js');
const { emitterParams, ParticleEmitter, EffectLibrary } = await mod('engine/particles/Nw4rParticles.js');

const lib = await new AnimationLibrary(store).load();
const models = new Map();
async function model(sidecar) {
  if (!models.has(sidecar)) models.set(sidecar, await loadModel(store, sidecar, { textures: false }));
  return models.get(sidecar);
}

test('manifesto: 301 animações por tipo e as 119 órfãs associadas (113 estrutura + 6 cena)', () => {
  const by = {};
  for (const a of lib.entries) by[a.type] = (by[a.type] || 0) + 1;
  assert.equal(lib.entries.length, 301);
  assert.deepEqual(by, { CHR0: 158, SRT0: 56, CLR0: 39, SCN0: 32, PAT0: 11, SHP0: 4, VIS0: 1 });
  const orphans = lib.entries.filter((a) => a.method !== 'same-brres');
  assert.equal(orphans.length, 119);
  assert.equal(orphans.filter((a) => a.method === 'structural').length, 113);
  assert.ok(orphans.every((a) => a.models.length || a.scenes.length));
});

test('CHR0: os 158 clipes montam no modelo associado e todas as trilhas acham o osso', async () => {
  let clips = 0, tracks = 0;
  for (const e of lib.entries.filter((a) => a.type === 'CHR0')) {
    const m = await model(e.models[0].sidecar);
    const clip = chr0Clip(await lib.json(e), m);
    assert.ok(clip.duration > 0);
    for (const t of clip.tracks) {
      const node = THREE.PropertyBinding.findNode(m, THREE.PropertyBinding.parseTrackName(t.name).nodeName);
      assert.ok(node && node.isBone, `${e.name}: ${t.name}`);
      tracks++;
    }
    clips++;
  }
  assert.equal(clips, 158);
  assert.ok(tracks > 1000);
});

test('CHR0: o mixer reproduz a curva NW4R (Hermite, Euler ZYX) no quadro', async () => {
  const e = lib.find('bbl_A0_runR', 'CHR0');
  const anim = await lib.json(e);
  const m = await model(e.models[0].sidecar);
  const mixer = new THREE.AnimationMixer(m);
  mixer.clipAction(chr0Clip(anim, m)).play();
  const f = 7;
  mixer.setTime(f / 60);
  const bt = anim.bones.find((b) => b.bone === 'skl_root');
  const r = bt.rotate.map((c) => sampleCurve(c, f) * Math.PI / 180);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], 'ZYX'));
  const got = m.userData.nw4r.boneByName.get('skl_root').quaternion;
  assert.ok(Math.abs(Math.abs(got.dot(q)) - 1) < 1e-5);
  const ty = sampleCurve(bt.translate[1], f);
  assert.ok(Math.abs(m.userData.nw4r.boneByName.get('skl_root').position.y - ty) < 1e-4);
});

test('SRT0/CLR0/PAT0/VIS0/SHP0/SCN0: cada animação liga no modelo (ou cena) associado', async () => {
  const report = {};
  for (const e of lib.entries.filter((a) => a.type !== 'CHR0')) {
    const anim = await lib.json(e);
    const r = (report[e.type] = report[e.type] || { total: 0, bound: 0 });
    r.total++;
    if (e.type === 'SCN0') {
      const cam = new THREE.PerspectiveCamera();
      const an = new Nw4rMaterialAnimator(anim, { camera: cam });
      an.setFrame(0);
      const real = (anim.cameras || []).some((c) => !c.placeholder);
      if (!real || Number.isFinite(cam.position.x)) r.bound++;
      continue;
    }
    if (!e.models.length) continue;
    const m = await model(e.models[0].sidecar);
    if (['VIS0', 'SHP0'].includes(e.type)) { if (clipFor(anim, m)) r.bound++; continue; }
    const an = new Nw4rMaterialAnimator(anim, { model: m, store });
    await an.ready;
    an.update(0.5);
    if (an.bindings.length) r.bound++;
    else if (an.unsupported.size) r.onlyIndirect = (r.onlyIndirect || 0) + 1; // só camadas indiretas/ambiente
  }
  assert.equal(report.SCN0.bound, 32);
  for (const t of ['CLR0', 'PAT0', 'VIS0', 'SHP0']) assert.equal(report[t].bound, report[t].total, `${t}: ${JSON.stringify(report[t])}`);
  // SRT0: 44 movem a camada desenhada; 12 só movem camadas de textura indireta/ambiente (*_ind, *_env, ondas),
  // que o TEV aproximado não desenha (limitação documentada no LEIAME)
  assert.equal(report.SRT0.bound, 44);
  assert.equal(report.SRT0.bound + report.SRT0.onlyIndirect, report.SRT0.total);
});

async function vrm1() {
  const loader = new VRM.GLTFLoader();
  loader.register((p) => new VRM.VRMLoaderPlugin(p));
  const g = await loader.parseAsync(syntheticVrm1(), '');
  return g.userData.vrm;
}

test('.vrma: 106 arquivos lidos pelo VRMAnimationLoaderPlugin do WEBC e convertidos em clipe para VRM 1.0', async () => {
  const vl = await new VrmaLibrary(store).load();
  assert.equal(vl.entries.length, 106);
  const vrm = await vrm1();
  for (const e of vl.entries) {
    const anim = await loadVrma(store, e.file);
    const clip = vrmaClip(anim, vrm);
    assert.ok(clip.tracks.length >= 10, `${e.name}: ${clip.tracks.length} trilhas`);
    assert.ok(Math.abs(clip.duration - e.frames / e.fps) < 1e-3);
  }
});

test('retargeting: direção dos ossos do VRM segue a do Mii quadro a quadro (famílias A1 e C0)', async () => {
  const vl = await new VrmaLibrary(store).load();
  const vrm = await vrm1();
  const pairs = [['arm_l1', 'arm_l2', 'leftUpperArm', 'leftLowerArm'], ['arm_l2', 'wrist_l', 'leftLowerArm', 'leftHand'],
    ['arm_r1', 'arm_r2', 'rightUpperArm', 'rightLowerArm'], ['arm_r2', 'wrist_r', 'rightLowerArm', 'rightHand'],
    ['leg_l1', 'leg_l2', 'leftUpperLeg', 'leftLowerLeg'], ['leg_r2', 'ankle_r', 'rightLowerLeg', 'rightFoot']];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
  let n = 0, sum = 0, worst = 0;
  const names = ['bbl_b_swing1R', 'tns_serveR', 'box_punch_hook_l_R', 'bwg_throw1R', 'tns_walk_tR'];
  for (const name of names) {
    const e = vl.find(name);
    assert.ok(e, name);
    const src = lib.find(name, 'CHR0');
    const body = await loadModel(store, (src.models.find((m) => m.model === e.skeleton) || src.models[0]).sidecar, { textures: false });
    const mm = new THREE.AnimationMixer(body); mm.clipAction(chr0Clip(await lib.json(src), body)).play();
    const vm = new THREE.AnimationMixer(vrm.scene); const act = vm.clipAction(vrmaClip(await loadVrma(store, e.file), vrm)); act.play();
    for (const f of [0, Math.floor(e.frames / 3), Math.floor((2 * e.frames) / 3)]) {
      mm.setTime(f / 60); body.updateMatrixWorld(true);
      vm.setTime(f / 60); vrm.humanoid.update(); vrm.scene.updateMatrixWorld(true);
      for (const [s0, s1, v0, v1] of pairs) {
        const B = body.userData.nw4r.boneByName;
        if (!B.get(s0) || !B.get(s1)) continue;
        B.get(s0).getWorldPosition(a); B.get(s1).getWorldPosition(b);
        vrm.humanoid.getRawBoneNode(v0).getWorldPosition(c); vrm.humanoid.getRawBoneNode(v1).getWorldPosition(d);
        const ang = b.sub(a).normalize().angleTo(d.sub(c).normalize()) * 180 / Math.PI;
        sum += ang; n++; worst = Math.max(worst, ang);
      }
    }
    act.stop(); vm.uncacheRoot(vrm.scene);
  }
  assert.ok(n >= 60, `pares medidos: ${n}`);
  assert.ok(sum / n < 2, `erro médio ${(sum / n).toFixed(2)}°`);
  assert.ok(worst < 6, `pior ${worst.toFixed(2)}°`);
});

test('partículas: 10 pacotes / 380 emissores viram parâmetros; emissores simulam sem NaN', async () => {
  const fx = await new EffectLibrary(store).load();
  assert.equal(fx.packs.size, 10);
  let all = 0;
  for (const doc of fx.packs.values()) all += doc.emitters.length;
  assert.equal(all, 380);
  let simulated = 0;
  for (const { em } of fx.byName.values()) {
    const P = emitterParams(em);
    assert.ok(P.life > 0 && Number.isFinite(P.radialSpeed) && P.size.every(Number.isFinite), em.name);
    if (simulated < 60) {
      let seed = 7;
      const e = new ParticleEmitter(P, null, { random: () => ((seed = (seed * 16807) % 2147483647) / 2147483647) });
      for (let i = 0; i < 30; i++) e.update(1 / 60);
      for (let i = 0; i < e.max * 3; i++) assert.ok(Number.isFinite(e.pos[i]), em.name);
      simulated++;
    }
  }
  const tail = await fx.spawn('Bsb_ball_tail01', { at: new THREE.Vector3(0, 10, 0) });
  assert.ok(tail);
  for (let i = 0; i < 20; i++) fx.update(1 / 60);
  assert.ok(tail.live > 0 || tail.finished);
});
