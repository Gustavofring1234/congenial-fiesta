// A tela 3D de uma partida (three.js 0.180 do WEBC): carrega a cena da modalidade (modelos + colisão + luz/sombra/
// bloom das Etapas 1 e 4), monta um modelo por ator (Mii com cabeça .rcd, ou o avatar .vrm do jogador local pelo
// WebcAvatarAdapter), as bolas, os pinos do boliche, os tacos/raquetes/luvas nos ossos, a linha de mira, e traduz os
// eventos da partida em partículas (EffectLibrary), sons (SportsAudioManager) e animações (AnimationLibrary).
// Lê o estado de duas formas: de uma SportActivity local (anfitrião ou jogo sozinho) ou de um instantâneo da sala
// (RoomSync.view(), convidado). Nunca altera a simulação: só desenha.
import { runtime } from '../../lib/runtime.js';
import { defaultStore } from '../../engine/assets/AssetStore.js';
import { loadModel } from '../../engine/assets/ModelLoader.js';
import { SceneLoader } from '../../engine/scene/SceneLoader.js';
import { SceneEnvironment, loadEnvironment } from '../../engine/scene/SceneEnvironment.js';
import { meshWorld, planeWorld } from './BallBody.js';

// modelos da cena comum que ficam na partida (o resto da cena é cenário de menu), como os filtros do C#
const KEEP = {
  bowling: (n) => ['bwg_field', 'bwg_field_front', 'bwg_lane', 'bwg_throwline', 'bwg_gate', 'bwg_gate_frame_L', 'bwg_gate_frame_R', 'bwg_wall_L', 'bwg_wall_R', 'lane_alpha'].includes(n),
  boxing: (n) => /^box_(ring|rope|corner|avatar)/.test(n) || n === 'box_hall' || n === 'box_light',
};
const BALL_MODEL = { tennis: ['tns_ball_a', 0.35], baseball: ['bbl_Ball', 0.37], golf: ['glf_ball1', 0.5] };
const IMPACT_KIND = { tennis: 'ball', baseball: 'bat', bowling: 'pin', golf: 'club', boxing: 'punch' };

export class ActivityStage {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {THREE.WebGLRenderer} [o.renderer]  com ele a luz/sombra/bloom do preset da cena é aplicada
   * @param {GameplayData} o.data
   * @param {object} [o.libs] {anims: AnimationLibrary, fx: EffectLibrary, audio: SportsAudioManager, mii: MiiOpponentBuilder, avatar: WebcAvatarAdapter}
   * @param {SportsHud} [o.hud]
   */
  constructor({ scene, camera, renderer = null, data, store = defaultStore(), libs = {}, hud = null, quality = 'medium' }) {
    const T = runtime.THREE;
    this.T = T;
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.data = data;
    this.store = store;
    this.libs = libs;
    this.hud = hud;
    this.loader = new SceneLoader(store);
    this.root = new T.Group();
    this.root.name = 'sports-stage';
    scene.add(this.root);
    this.env = renderer ? new SceneEnvironment(renderer, scene, camera, { quality }) : null;
    this.sceneRoot = null;
    this.visuals = new Map();     // actor id -> {group, body, player, anim, expression, attachments, pending}
    this.ballMeshes = [];
    this.pins = null;
    this.aimLine = null;
    this.sport = null;
    this.models = new Map();      // cache de modelos de itens por nome
    this.activity = null;
    this.off = null;
    this.localActorSlot = 0;
  }

  // ── cenas ─────────────────────────────────────────────────────
  async loadScene(path, { collision = true, keep = null } = {}) {
    if (this.sceneRoot) { this.root.remove(this.sceneRoot.root); this.sceneRoot = null; }
    const sc = await this.loader.load('Scenes/' + path, { collision });
    if (keep) for (const m of sc.models) if (!keep(String(m.userData.sceneName || '').split('/').pop())) m.visible = false;
    sc.root.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
    this.root.add(sc.root);
    this.sceneRoot = sc;
    if (this.env) {
      try { this.env.apply(await loadEnvironment(this.store, sc.scene.assetId), { focus: [0, 0, 0], radius: 80 }); } catch (e) { /* cena sem preset de luz: fica a luz padrão */ }
    }
    return sc;
  }

  /** Prepara a modalidade: cena principal (golfe carrega por buraco em loadWorld). Devolve o mundo de colisão. */
  async prepare(sport) {
    this.sport = sport;
    await Promise.all([this.libs.anims && this.libs.anims.load(), this.libs.fx && this.libs.fx.load(), this.libs.mii && this.libs.mii.load()]);
    if (sport === 'golf') return null;
    const sc = await this.loadScene(this.data.mainScene(sport), { collision: sport !== 'bowling' && sport !== 'boxing', keep: KEEP[sport] || null });
    if (sport === 'bowling') await this._buildPins();
    return sc.collision ? meshWorld(sc.collision, { fallbackY: 0 }) : planeWorld(0);
  }

  /** Para o golfe: carrega o curso do buraco e devolve o mundo de colisão (GolfActivity options.loadWorld). */
  loadWorld = async (course) => {
    const sc = await this.loadScene(course.scene, { collision: true });
    return meshWorld(sc.collision);
  };

  async _item(name) {
    if (!name) return null;
    if (!this.models.has(name)) {
      const sidecar = this.data.model(this.sport, name);
      this.models.set(name, sidecar ? loadModel(this.store, sidecar).catch(() => null) : Promise.resolve(null));
    }
    const m = await this.models.get(name);
    return m ? m.clone(true) : null;
  }

  async _buildPins() {
    const T = this.T;
    const m = await this._item('bwg_pin_166_10');
    const g = new T.Group();
    g.name = 'pins';
    this.pins = { group: g, model: m, bones: [] };
    if (m) {
      g.add(m);
      // o modelo é um clone (Object3D.clone copia o userData por JSON e o Map boneByName se perde): busca pelo nome
      for (let i = 0; i < 10; i++) this.pins.bones.push(m.getObjectByName('pin_166_mdl' + i) || null);
    }
    if (!this.pins.bones.some(Boolean)) {
      // sem os ossos do modelo NW4R: cilindros brancos no lugar
      const geo = new T.CylinderGeometry(0.4, 0.64, 3.8, 12);
      geo.translate(0, 1.9, 0);
      const mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
      this.pins.bones = Array.from({ length: 10 }, () => { const c = new T.Mesh(geo, mat); c.castShadow = true; g.add(c); return c; });
    }
    this.root.add(g);
  }

  // ── ligação com a partida ─────────────────────────────────────
  bind(activity) {
    this.unbind();
    this.activity = activity;
    this.off = activity.on((e) => this.onEvent(e));
  }

  unbind() { if (this.off) this.off(); this.off = null; this.activity = null; }

  onEvent(e) {
    const T = this.T, L = this.libs;
    switch (e.type) {
      case 'fx': if (L.fx) L.fx.spawn(e.name, { at: new T.Vector3(e.at[0], e.at[1], e.at[2]), parent: this.root }).catch(() => {}); break;
      case 'impact': if (L.audio) try { L.audio.playImpact(e.strength, IMPACT_KIND[this.sport] || 'ball'); } catch (x) { /* sem áudio */ } break;
      case 'sfx': if (L.audio && e.kind === 'crowd') L.audio.crowd(e.volume); else if (L.audio && e.kind === 'click') L.audio.playImpact(0.2, 'ball'); break;
      case 'cue': if (L.audio) L.audio.play(e.name); break;
      case 'bell': if (L.audio) L.audio.whistle(); break;
      case 'course': break;
      default: break;
    }
    if (this.hud) this.hud.onEvent(e);
  }

  // ── por quadro ────────────────────────────────────────────────
  /** Desenha a partida local (activity) ou o instantâneo da sala (snap). */
  update(dt, snap = null) {
    const s = snap || (this.activity ? this.activity.snapshot() : null);
    if (!s) return;
    this._actors(s.a || [], dt);
    this._balls(s);
    this._camera(s, dt);
    if (this.sport === 'bowling' && s.x && s.x.l) this._pinsUpdate(s.x.l);
    this._aim(s);
    if (this.hud && snap) this.hud.fromSnapshot(snap);
    if (this.libs.anims) for (const v of this.visuals.values()) if (v.player) v.player.update(dt);
    if (this.libs.avatar) this.libs.avatar.update(dt);
    if (this.libs.fx) this.libs.fx.update(dt);
    if (this.env) this.env.update(this.camera.position);
  }

  render() { if (this.env) this.env.render(); else if (this.renderer) this.renderer.render(this.scene, this.camera); }

  _actors(list, dt) {
    const seen = new Set();
    for (const a of list) {
      const [id, x, y, z, yaw, anim, expr] = a;
      seen.add(id);
      let v = this.visuals.get(id);
      if (!v) { v = this._spawnVisual(id); this.visuals.set(id, v); }
      v.group.position.set(x, y, z);
      v.group.rotation.set(0, yaw, 0);
      if (anim && anim !== v.anim && v.player) { v.anim = anim; v.player.play(anim, { loop: /wait|walk|run/.test(anim) }).catch(() => {}); }
      if (anim && anim !== v.anim && v.avatar) { v.anim = anim; v.avatar.play(anim).catch(() => {}); }
      const ex = expr || 'neutral';
      if (ex !== v.expression && v.mii && this.libs.mii) { v.expression = ex; this.libs.mii.setExpression(v.mii, ex).catch(() => {}); }
    }
    for (const [id, v] of this.visuals) if (!seen.has(id)) { this.root.remove(v.group); this.visuals.delete(id); }
  }

  _actorInfo(id) {
    const a = this.activity ? this.activity.actors.find((x) => x.id === id) : null;
    return a || null;
  }

  _spawnVisual(id) {
    const T = this.T;
    const group = new T.Group();
    group.name = 'actor-' + id;
    this.root.add(group);
    const v = { group, player: null, anim: null, expression: 'neutral', mii: null, avatar: null };
    const info = this._actorInfo(id);
    const slot = info ? info.slot : null;
    const useAvatar = slot && slot.local && slot.character && slot.character.kind === 'vrm' && this.libs.avatar && !this._avatarUsed;
    (async () => {
      if (useAvatar) {
        this._avatarUsed = true;
        v.avatar = this.libs.avatar;
        const sc = v.avatar.vrm.scene;
        // o avatar é do palco do WEBC: guarda onde ele estava para devolver no fim
        this._avatarHome = { parent: sc.parent, position: sc.position.clone(), quaternion: sc.quaternion.clone(), scale: sc.scale.clone() };
        v.avatar.attach(group);
        v.avatar.vrm.scene.scale.setScalar(this.data.unitsPerMeter); // VRM em metros, cena em 10 u/m
        return;
      }
      const mii = this.libs.mii;
      if (!mii) return;
      // Mii criado no editor (info completo) ou um dos 60 perfis .rcd
      const ref = slot && slot.miiInfo ? { id: slot.profileId, info: slot.miiInfo }
        : slot && slot.info && slot.info.id && mii.profiles.some((p) => p.id === slot.info.id) ? slot.info.id : (id % Math.max(1, mii.profiles.length));
      const g = await mii.build(ref, { body: true });
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      group.add(g);
      v.mii = g;
      const body = g.userData.mii.body;
      if (body && this.libs.anims) v.player = this.libs.anims.player(body);
      if (v.anim && v.player) v.player.play(v.anim, { loop: true }).catch(() => {});
      for (const [bone, model] of Object.entries(info ? info.attachments : {})) {
        const item = await this._item(model);
        const b = body && body.userData.nw4r ? body.userData.nw4r.boneByName.get(bone) : null;
        if (item && b) b.add(item);
      }
    })().catch((e) => console.warn('sports: ator não montou', e.message));
    return v;
  }

  async _ballMesh(i) {
    const T = this.T;
    const [name, radius] = BALL_MODEL[this.sport] || ['', 1];
    let m = await this._item(name);
    if (m) {
      const box = new T.Box3().setFromObject(m), size = box.getSize(new T.Vector3());
      const d = Math.max(size.x, size.y, size.z) || 1;
      m.scale.setScalar((radius * 2.4) / d);
    } else m = new T.Mesh(new T.SphereGeometry(radius * 1.2, 16, 12), new T.MeshStandardMaterial({ color: this.sport === 'tennis' ? 0xd8ff40 : 0xffffff }));
    m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    const g = new T.Group();
    g.add(m);
    this.root.add(g);
    this.ballMeshes[i] = g;
    return g;
  }

  _balls(s) {
    const list = s.b || [];
    list.forEach((b, i) => {
      const g = this.ballMeshes[i];
      if (!g) { if (!this._ballPending) { this._ballPending = true; this._ballMesh(i).finally(() => { this._ballPending = false; }); } return; }
      g.visible = true;
      g.position.set(b[0], b[1], b[2]);
    });
    for (let i = list.length; i < this.ballMeshes.length; i++) if (this.ballMeshes[i]) this.ballMeshes[i].visible = false;
  }

  _pinsUpdate(l) {
    const T = this.T;
    if (!this.pins) return;
    if (!this._bowlBall) {
      this._bowlBall = true;
      const name = (this.activity && this.activity.ballModel) || 'bwg_ball_blue';
      this._item(name).then((m) => {
        const g = new T.Group();
        if (m) g.add(m); else g.add(new T.Mesh(new T.SphereGeometry(1.09, 20, 14), new T.MeshStandardMaterial({ color: 0x3355ee })));
        this.root.add(g);
        this._bowlBallMesh = g;
      });
    }
    if (this._bowlBallMesh) {
      this._bowlBallMesh.position.set(l.b[0], l.b[1], l.b[2]);
      this._bowlBallMesh.rotation.set(-l.b[4], 0, 0);
      this._bowlBallMesh.visible = !l.b[3];
    }
    const q = new T.Quaternion(), axis = new T.Vector3(), p = new T.Vector3();
    l.p.forEach((pin, i) => {
      const b = this.pins.bones[i];
      if (!b) return;
      b.visible = !!pin;
      if (!pin) { b.scale.setScalar(0.0001); return; }
      b.scale.setScalar(1);
      p.set(pin[0], 0, pin[1]);
      // tombado: gira 90° em torno do eixo horizontal perpendicular ao impulso
      axis.set(pin[4], 0, -pin[3]).normalize();
      q.setFromAxisAngle(axis.lengthSq() > 0 ? axis : new T.Vector3(1, 0, 0), (pin[2] || 0) * Math.PI / 2);
      if (b.parent && b.parent !== this.pins.group) b.parent.worldToLocal(p);
      b.position.copy(p);
      b.quaternion.copy(q);
    });
  }

  _aim(s) {
    const T = this.T;
    let pts = null;
    if (this.sport === 'golf' && s.x && Array.isArray(s.x.aim)) pts = s.x.aim.map((q) => new T.Vector3(q[0], q[1], q[2]));
    if (this.sport === 'bowling' && s.x && Array.isArray(s.x.aim)) {
      const [x, ang] = s.x.aim, a = (ang * Math.PI) / 180;
      pts = [new T.Vector3(x, 0.1, 4), new T.Vector3(x + Math.sin(a) * 80, 0.1, 4 - Math.cos(a) * 80)];
    }
    if (!pts || pts.length < 2) { if (this.aimLine) this.aimLine.visible = false; return; }
    if (!this.aimLine) {
      this.aimLine = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({ color: 0xffee55, transparent: true, opacity: 0.85, depthTest: false }));
      this.aimLine.renderOrder = 10;
      this.root.add(this.aimLine);
    }
    this.aimLine.geometry.setFromPoints(pts);
    this.aimLine.visible = true;
  }

  _camera(s, dt) {
    const c = s.c;
    if (!c) return;
    const T = this.T, cam = this.camera;
    const sharp = this.activity ? this.activity.camera.sharp : 4;
    const pos = new T.Vector3(c[0], c[1], c[2]), look = new T.Vector3(c[3], c[4], c[5]);
    const k = sharp > 0 ? 1 - Math.exp(-sharp * dt) : 1;
    cam.position.lerp(pos, k);
    this._look = this._look ? this._look.lerp(look, k) : look;
    cam.lookAt(this._look);
    if (Math.abs(cam.fov - c[6]) > 0.01) { cam.fov += (c[6] - cam.fov) * k; cam.updateProjectionMatrix(); }
    if (cam.far < 20000) { cam.far = 60000; cam.near = 0.5; cam.updateProjectionMatrix(); }
  }

  dispose() {
    this.unbind();
    if (this.libs.avatar && this._avatarUsed) {
      try {
        const av = this.libs.avatar, h = this._avatarHome, sc = av.vrm.scene;
        av.detach();
        if (h) { sc.scale.copy(h.scale); if (h.parent) av.attach(h.parent, h.position, h.quaternion); }
      } catch (e) { /* já devolvido */ }
    }
    this.scene.remove(this.root);
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.visuals.clear();
  }
}
