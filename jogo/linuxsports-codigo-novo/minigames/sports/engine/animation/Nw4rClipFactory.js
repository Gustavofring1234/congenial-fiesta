// CHR0 / VIS0 / SHP0 -> THREE.AnimationClip (tocados por um AnimationMixer no modelo de loadModel()).
//
// CHR0: cada osso recebe position/quaternion/scale amostrados em todos os quadros inteiros (60 Hz). Componente sem
// trilha usa a pose de repouso do sidecar, a menos que as flags digam identidade (scaleOne, rotTransZero) ou o osso
// seja 'identity'. Rotação NW4R = Rz·Ry·Rx (Euler 'ZYX'); os quaternions são mantidos no mesmo hemisfério para a
// interpolação não dar a volta longa. Trilhas usam o NOME do osso: o clipe serve para qualquer modelo com o mesmo
// esqueleto (as animações de avatar casam com todos os corpos ava_body* da mesma família).
// VIS0: liga/desliga as malhas presas ao osso (BooleanKeyframeTrack em .visible, por uuid).
// SHP0: pesos dos morphs (morphTargetInfluences) das malhas que têm o vertexSet, por uuid.
import { runtime, NW4R_FPS } from '../../lib/runtime.js';
import { sampleCurve, isConst, frameTimes, sampleVis } from './Nw4rCurves.js';

const DEG = Math.PI / 180;

function boneTrackValues(T, bt, rest, n) {
  const flags = bt.flags || {};
  const pos = new Float32Array((n + 1) * 3), quat = new Float32Array((n + 1) * 4), scl = new Float32Array((n + 1) * 3);
  const e = new T.Euler(0, 0, 0, 'ZYX'), q = new T.Quaternion(), prev = new T.Quaternion();
  const pick = (curves, i, f, fallback) => (curves && curves[i] ? sampleCurve(curves[i], f) : fallback);
  for (let f = 0; f <= n; f++) {
    let s = rest.s, r = rest.r, t = rest.t;
    if (bt.identity) { s = [1, 1, 1]; r = [0, 0, 0]; t = [0, 0, 0]; }
    else {
      if (bt.scale) s = [0, 1, 2].map((i) => pick(bt.scale, i, f, rest.s[i]));
      else if (flags.scaleOne) s = [1, 1, 1];
      if (bt.rotate) r = [0, 1, 2].map((i) => pick(bt.rotate, i, f, rest.r[i]));
      else if (flags.rotTransZero) r = [0, 0, 0];
      if (bt.translate) t = [0, 1, 2].map((i) => pick(bt.translate, i, f, rest.t[i]));
      else if (flags.rotTransZero) t = [0, 0, 0];
    }
    e.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'ZYX');
    q.setFromEuler(e);
    if (f > 0 && q.dot(prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    prev.copy(q);
    pos.set(t, f * 3); quat.set([q.x, q.y, q.z, q.w], f * 4); scl.set(s, f * 3);
  }
  return { pos, quat, scl };
}

const allConst = (curves) => !curves || curves.every(isConst);

/**
 * CHR0 -> AnimationClip. `model` (de loadModel) dá a pose de repouso; ossos ausentes no modelo são ignorados.
 * @returns {THREE.AnimationClip}
 */
export function chr0Clip(anim, model, { fps = NW4R_FPS } = {}) {
  const T = runtime.THREE;
  const info = model.userData.nw4r;
  const n = Math.max(1, Math.round(anim.frames));
  const times = frameTimes(n, fps);
  const tracks = [];
  for (const bt of anim.bones || []) {
    const bone = info.boneByName.get(bt.bone);
    if (!bone) continue;
    const rest = bone.userData.nw4r.rest;
    const v = boneTrackValues(T, bt, rest, n);
    const still = !bt.identity && allConst(bt.scale) && allConst(bt.rotate) && allConst(bt.translate);
    const tt = still ? new Float32Array([0, times[n]]) : times;
    const cut = (arr, k) => (still ? new Float32Array([...arr.slice(0, k), ...arr.slice(0, k)]) : arr);
    tracks.push(new T.VectorKeyframeTrack(`${bt.bone}.position`, tt, cut(v.pos, 3)));
    tracks.push(new T.QuaternionKeyframeTrack(`${bt.bone}.quaternion`, tt, cut(v.quat, 4)));
    tracks.push(new T.VectorKeyframeTrack(`${bt.bone}.scale`, tt, cut(v.scl, 3)));
  }
  const clip = new T.AnimationClip(anim.name, n / fps, tracks);
  clip.userData = { type: 'CHR0', loop: !!anim.loop, frames: n, source: anim.source };
  return clip;
}

/** VIS0 -> AnimationClip (ou null se nenhuma malha do modelo é afetada). */
export function vis0Clip(anim, model, { fps = NW4R_FPS } = {}) {
  const T = runtime.THREE;
  const info = model.userData.nw4r;
  const n = Math.max(1, Math.round(anim.frames));
  const tracks = [];
  for (const b of anim.bones || []) {
    const meshes = [...(info.meshesByBone.get(b.bone) || []), ...info.meshes.filter((m) => m.name === b.bone)];
    if (!meshes.length) continue;
    const times = [], values = [];
    let last;
    for (let f = 0; f <= n; f++) {
      const v = sampleVis(b, f);
      if (v !== last || f === n) { times.push(f / fps); values.push(v); last = v; }
    }
    for (const m of meshes) tracks.push(new T.BooleanKeyframeTrack(`${m.uuid}.visible`, times, values));
  }
  if (!tracks.length) return null;
  const clip = new T.AnimationClip(anim.name, n / fps, tracks);
  clip.userData = { type: 'VIS0', loop: !!anim.loop, frames: n };
  return clip;
}

/** SHP0 -> AnimationClip com os pesos (0..1) dos morphs. */
export function shp0Clip(anim, model, { fps = NW4R_FPS } = {}) {
  const T = runtime.THREE;
  const info = model.userData.nw4r;
  const n = Math.max(1, Math.round(anim.frames));
  const times = frameTimes(n, fps);
  const tracks = [];
  for (const sh of anim.shapes || []) {
    for (const tg of sh.targets || []) {
      for (const m of info.meshes) {
        const idx = m.morphTargetDictionary?.[tg.vertexSet];
        if (idx === undefined) continue;
        const values = new Float32Array(n + 1);
        for (let f = 0; f <= n; f++) values[f] = Math.min(1, Math.max(0, sampleCurve(tg.weight, f) ?? 0));
        tracks.push(new T.NumberKeyframeTrack(`${m.uuid}.morphTargetInfluences[${idx}]`, times, values));
      }
    }
  }
  if (!tracks.length) return null;
  const clip = new T.AnimationClip(anim.name, n / fps, tracks);
  clip.userData = { type: 'SHP0', loop: !!anim.loop, frames: n };
  return clip;
}

export function clipFor(anim, model, o) {
  if (anim.type === 'CHR0') return chr0Clip(anim, model, o);
  if (anim.type === 'VIS0') return vis0Clip(anim, model, o);
  if (anim.type === 'SHP0') return shp0Clip(anim, model, o);
  return null;
}
