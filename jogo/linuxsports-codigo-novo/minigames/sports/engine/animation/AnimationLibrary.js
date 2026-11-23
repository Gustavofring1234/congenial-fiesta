// Biblioteca das 301 animações 3D (animations_manifest.json, de tools/export_animations.py) e o player por modelo.
//
// Cada entrada do manifesto diz a que modelos a animação serve: 182 pelo próprio .brres, 113 das 119 órfãs pela
// estrutura de ossos/materiais (method 'structural', com score/coverage) e 6 SCN0 pela cena (method
// 'scene-container'). As animações de avatar (CHR0) casam com os corpos ava_body* (Mii) e, convertidas por
// tools/export_vrma.py, tocam nos avatares .vrm do WEBC (ver VrmaPlayer.js).
import { runtime } from '../../lib/runtime.js';
import { defaultStore } from '../assets/AssetStore.js';
import { clipFor } from './Nw4rClipFactory.js';
import { Nw4rMaterialAnimator } from './Nw4rMaterialAnimator.js';

const MIXER_TYPES = new Set(['CHR0', 'VIS0', 'SHP0']);

export class AnimationLibrary {
  constructor(store = defaultStore()) {
    this.store = store;
    this.manifest = null;
  }

  async load() {
    if (!this.manifest) this.manifest = await this.store.json('animations_manifest.json');
    return this;
  }

  get entries() { return this.manifest ? this.manifest.animations : []; }

  /** Entrada por id completo ou por nome (+ tipo opcional, ex.: ('bbl_b_swing1R', 'CHR0')). */
  find(nameOrId, type = null) {
    return this.entries.find((a) => (a.id === nameOrId || a.name === nameOrId) && (!type || a.type === type)) || null;
  }

  /** Animações que servem a um modelo (assetId ou modelo de loadModel), melhor score primeiro. */
  forModel(modelOrAssetId, type = null) {
    const id = typeof modelOrAssetId === 'string' ? modelOrAssetId : modelOrAssetId.userData.nw4r.assetId;
    return this.entries
      .map((a) => ({ a, m: a.models.find((m) => m.assetId === id) }))
      .filter((x) => x.m && (!type || x.a.type === type))
      .sort((x, y) => y.m.score - x.m.score)
      .map((x) => x.a);
  }

  /** SCN0 (câmera/luzes) de uma cena (assetId do .scene.json). */
  forScene(sceneAssetId) { return this.entries.filter((a) => a.scenes?.some((s) => s.assetId === sceneAssetId)); }

  json(entry) { return this.store.json(entry.file); }

  /** Player de animações para um modelo (um AnimationMixer + animadores de material). */
  player(model, o = {}) { return new Nw4rAnimationPlayer(this, model, o); }
}

export class Nw4rAnimationPlayer {
  /**
   * @param {AnimationLibrary} lib
   * @param {THREE.Object3D|null} model  modelo de loadModel (null só para SCN0)
   * @param {object} [o] { camera, lights, ambient } para SCN0
   */
  constructor(lib, model, { camera = null, lights = {}, ambient = null } = {}) {
    const T = runtime.THREE;
    this.lib = lib;
    this.model = model;
    this.mixer = model ? new T.AnimationMixer(model) : null;
    this.scnOpts = { camera, lights, ambient };
    this.clips = new Map();     // `${type}:${name}` -> clip (por modelo)
    this.actions = new Map();   // nome -> {action?, animator?, entry}
  }

  async clip(entry) {
    const key = `${entry.type}:${entry.name}`;
    if (!this.clips.has(key)) this.clips.set(key, clipFor(await this.lib.json(entry), this.model));
    return this.clips.get(key);
  }

  /**
   * Toca uma animação por nome/id. Opções: { loop (padrão do arquivo), fade: segundos de transição (CHR0),
   * timeScale: 1, type }. Devolve o controle {entry, action|animator} ou null se não existe/não serve ao modelo.
   */
  async play(nameOrId, { loop, fade = 0.15, timeScale = 1, type = null } = {}) {
    const T = runtime.THREE;
    const entry = this.lib.find(nameOrId, type);
    if (!entry) return null;
    const lp = loop ?? !!entry.loop;
    if (MIXER_TYPES.has(entry.type)) {
      if (!this.mixer) return null;
      const clip = await this.clip(entry);
      if (!clip) return null;
      const action = this.mixer.clipAction(clip);
      action.setLoop(lp ? T.LoopRepeat : T.LoopOnce, Infinity);
      action.clampWhenFinished = !lp;
      action.timeScale = timeScale;
      if (entry.type === 'CHR0') {
        // um CHR0 por vez no esqueleto: os outros saem com fade
        for (const [n, c] of this.actions) if (c.entry.type === 'CHR0' && c.action !== action) { c.action.fadeOut(fade); this.actions.delete(n); }
        action.reset().fadeIn(fade).play();
      } else action.reset().play();
      const ctl = { entry, action };
      this.actions.set(entry.name, ctl);
      return ctl;
    }
    const anim = await this.lib.json(entry);
    const animator = new Nw4rMaterialAnimator(anim, { model: this.model, store: this.lib.store, loop: lp, ...this.scnOpts });
    await animator.ready;
    const ctl = { entry, animator, timeScale };
    this.actions.set(entry.name, ctl);
    return ctl;
  }

  stop(name) {
    const c = this.actions.get(name);
    if (!c) return;
    if (c.action) c.action.stop();
    this.actions.delete(name);
  }

  stopAll() { this.mixer?.stopAllAction(); this.actions.clear(); }

  /** Chame a cada quadro com o dt em segundos. */
  update(dt) {
    this.mixer?.update(dt);
    for (const c of this.actions.values()) if (c.animator) c.animator.update(dt * (c.timeScale || 1));
  }

  dispose() { this.stopAll(); if (this.mixer && this.model) this.mixer.uncacheRoot(this.model); this.clips.clear(); }
}
