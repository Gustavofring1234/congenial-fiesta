// Movimentos esportivos (tacadas, saques, arremessos, socos...) nos avatares .vrm do WEBC.
//
// Os .vrma vêm de tools/export_vrma.py (retargeting das 106 animações CHR0 dos corpos Mii para o humanoide VRM).
// Leitura pelo VRMAnimationLoaderPlugin do pacote vendor do WEBC (o mesmo que o estúdio de movimentos usa); o
// clipe é montado aqui para o avatar dado, como o createVRMAnimationClip do three-vrm (que o pacote não exporta):
//   - trilhas nos ossos NORMALIZADOS do humanoide (vrm.humanoid.getNormalizedBoneNode);
//   - VRM 0.x olha para -Z: quaternions com x e z negados e posição do quadril com x e z negados;
//   - posição do quadril reescalada pela altura do quadril do avatar / do .vrma (proporções preservadas).
// Os spring bones e expressões continuam com o WEBC (vrm.update(dt) no laço dele).
import { runtime } from '../../lib/runtime.js';
import { defaultStore } from '../assets/AssetStore.js';

/** Lê um .vrma e devolve o VRMAnimation (humanoidTracks, restHipsPosition, duration). */
export async function loadVrma(store, path) {
  const gltf = await store.gltf(path, [(parser) => new runtime.VRMAnimationLoaderPlugin(parser)]);
  const anim = gltf.userData.vrmAnimations?.[0];
  if (!anim) throw new Error(`${path}: sem VRMC_vrm_animation`);
  anim.name = anim.name || path.split('/').pop().replace(/\.vrma$/, '');
  return anim;
}

function metaVersion(vrm) { return String(vrm?.meta?.metaVersion ?? '1'); }

function restHipsHeight(vrm) {
  const rp = vrm.humanoid?.normalizedRestPose?.hips?.position;
  if (rp && rp[1] > 0) return rp[1];
  const T = runtime.THREE;
  const node = vrm.humanoid?.getNormalizedBoneNode('hips');
  return node ? node.getWorldPosition(new T.Vector3()).y - vrm.scene.getWorldPosition(new T.Vector3()).y : 1;
}

/** VRMAnimation -> AnimationClip para este avatar (VRM 0.x ou 1.0). */
export function vrmaClip(vrmAnimation, vrm, { name } = {}) {
  const T = runtime.THREE;
  const v0 = metaVersion(vrm) === '0';
  const tracks = [];
  const hum = vrm.humanoid;
  const scale = restHipsHeight(vrm) / Math.max(1e-4, vrmAnimation.restHipsPosition?.y || 1);
  for (const [bone, tr] of vrmAnimation.humanoidTracks.rotation) {
    const node = hum.getNormalizedBoneNode(bone);
    if (!node) continue;
    const values = v0 ? tr.values.map((v, i) => (i % 2 === 0 ? -v : v)) : tr.values.slice();
    tracks.push(new T.QuaternionKeyframeTrack(`${node.name}.quaternion`, tr.times, values));
  }
  for (const [bone, tr] of vrmAnimation.humanoidTracks.translation) {
    const node = hum.getNormalizedBoneNode(bone);
    if (!node) continue;
    const values = tr.values.map((v, i) => (v0 && i % 3 !== 1 ? -v : v) * scale);
    tracks.push(new T.VectorKeyframeTrack(`${node.name}.position`, tr.times, values));
  }
  return new T.AnimationClip(name || vrmAnimation.name || 'vrma', vrmAnimation.duration, tracks);
}

/** Catálogo dos .vrma (Vrma/vrma_manifest.json) com cache de leitura. */
export class VrmaLibrary {
  constructor(store = defaultStore()) {
    this.store = store;
    this.manifest = null;
    this.cache = new Map();
  }

  async load() {
    if (!this.manifest) this.manifest = await this.store.json('Vrma/vrma_manifest.json');
    return this;
  }

  get entries() { return this.manifest ? this.manifest.animations : []; }

  find(name) { return this.entries.find((a) => a.name === name) || null; }

  /** Movimentos de uma modalidade ('tennis', 'baseball', 'bowling', 'golf', 'boxing'). */
  forSport(sport) { return this.entries.filter((a) => a.sport === sport); }

  async animation(name) {
    const e = this.find(name);
    if (!e) return null;
    if (!this.cache.has(name)) this.cache.set(name, loadVrma(this.store, e.file));
    return this.cache.get(name);
  }
}

/** Toca .vrma num avatar VRM com fade entre movimentos. */
export class VrmaPlayer {
  /** @param {object} vrm  VRM do three-vrm (palco.vrm no WEBC) */
  constructor(vrm, library = new VrmaLibrary()) {
    const T = runtime.THREE;
    this.vrm = vrm;
    this.lib = library;
    this.mixer = new T.AnimationMixer(vrm.scene);
    this.current = null;
    this.clips = new Map();
  }

  async clip(name) {
    if (!this.clips.has(name)) {
      await this.lib.load();
      const anim = await this.lib.animation(name);
      this.clips.set(name, anim ? vrmaClip(anim, this.vrm, { name }) : null);
    }
    return this.clips.get(name);
  }

  /** Toca um movimento. { loop (padrão do manifesto), fade: 0.2, timeScale: 1, onEnd } */
  async play(name, { loop, fade = 0.2, timeScale = 1, onEnd = null } = {}) {
    const T = runtime.THREE;
    const clip = await this.clip(name);
    if (!clip) return null;
    const e = this.lib.find(name);
    const lp = loop ?? !!e?.loop;
    const action = this.mixer.clipAction(clip);
    action.setLoop(lp ? T.LoopRepeat : T.LoopOnce, Infinity);
    action.clampWhenFinished = !lp;
    action.timeScale = timeScale;
    action.reset();
    if (this.current && this.current !== action) action.crossFadeFrom(this.current, fade, false);
    action.play();
    this.current = action;
    if (onEnd && !lp) {
      const f = (ev) => { if (ev.action === action) { this.mixer.removeEventListener('finished', f); onEnd(); } };
      this.mixer.addEventListener('finished', f);
    }
    return action;
  }

  stop(fade = 0.2) { if (this.current) { this.current.fadeOut(fade); this.current = null; } }

  /** dt em segundos; chame antes do vrm.update(dt) do WEBC para os spring bones seguirem a pose. */
  update(dt) { this.mixer.update(dt); }

  dispose() { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.vrm.scene); this.clips.clear(); }
}
