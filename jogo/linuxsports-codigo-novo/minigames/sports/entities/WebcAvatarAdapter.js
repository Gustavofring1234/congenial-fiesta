// Adaptador entre o avatar VRM ativo do WEBC (o objeto `vrm` do three-vrm, palco.vrm) e o jogo de esportes.
//
// O WEBC é dono do VRM: quem o cria, o troca e o descarta é o palco. Este adaptador só toca o avatar:
//   - movimentos .vrma (VrmaPlayer, com fade entre clipes);
//   - expressões com fade (só as que existem no expressionManager; VRM 1.0 e nomes VRM 0.x);
//   - a posição no mundo do jogo (attach/teleport), com os spring bones reiniciados nesses momentos.
// Por padrão o WEBC chama vrm.update(dt) no laço dele. Com { ownsUpdate: true }, update(dt) também o chama.
import { runtime, UNITS_PER_METER } from '../lib/runtime.js';
import { VrmaLibrary, VrmaPlayer } from '../engine/animation/VrmaPlayer.js';

/** Velocidade do fade das expressões (1/s): cerca de 0,2 s para ir de 0 a 1. */
const FADE_PER_SECOND = 6;

/** Nomes por humor: primeiro o VRM 1.0, depois o VRM 0.x. Só é usado o que existir no avatar. */
const MOODS = {
  celebrate: ['happy', 'joy'],
  lose: ['sad', 'sorrow'],
  neutral: ['neutral', 'relaxed'],
};
const ALL_MOOD_NAMES = [...new Set(Object.values(MOODS).flat())];

/** Atribui um vetor (Vector3/Quaternion ou array) ao destino. */
function assign(target, src) {
  if (!src) return;
  if (Array.isArray(src)) target.fromArray(src);
  else target.copy(src);
}

export class WebcAvatarAdapter {
  /**
   * @param {object} vrm  VRM do three-vrm (vrm.scene, vrm.humanoid, vrm.expressionManager, vrm.springBoneManager)
   * @param {object} [o]
   * @param {VrmaLibrary} [o.library]  catálogo dos .vrma (padrão: VrmaLibrary sobre o store compartilhado)
   * @param {boolean} [o.ownsUpdate=false]  true: update(dt) também chama vrm.update(dt)
   */
  constructor(vrm, { library = null, ownsUpdate = false } = {}) {
    if (!vrm?.scene) throw new Error('WebcAvatarAdapter: o VRM precisa de scene');
    this.vrm = vrm;
    this.library = library || new VrmaLibrary();
    this.player = new VrmaPlayer(vrm, this.library);
    this.ownsUpdate = ownsUpdate;
    this.parent = null;
    this.disposed = false;
    // expressões que existem neste avatar (name -> VRMExpression); o resto é ignorado sem erro
    const em = vrm.expressionManager;
    this.expressions = new Map();
    for (const name of ALL_MOOD_NAMES) {
      const e = em?.getExpression?.(name);
      if (e) this.expressions.set(name, e);
    }
    this.weights = new Map(); // peso atual com fade
    this.targets = new Map(); // peso alvo
  }

  /**
   * Altura em metros pela pose normalizada: distância quadril -> cabeça mais o maior comprimento de perna
   * (quadril -> coxa -> canela -> pé, com os ossos que existirem). Zero se o avatar não tem humanoide.
   */
  get height() {
    const T = runtime.THREE;
    const { scene, humanoid } = this.vrm;
    if (!humanoid) return 0;
    scene.updateMatrixWorld(true);
    const at = (name) => {
      const n = humanoid.getNormalizedBoneNode(name);
      return n ? scene.worldToLocal(n.getWorldPosition(new T.Vector3())) : null;
    };
    const hips = at('hips');
    const head = at('head');
    if (!hips || !head) return 0;
    let legs = 0;
    for (const side of ['left', 'right']) {
      const chain = [hips, ...['UpperLeg', 'LowerLeg', 'Foot'].map((b) => at(side + b))].filter(Boolean);
      let len = 0;
      for (let i = 1; i < chain.length; i++) len += chain[i - 1].distanceTo(chain[i]);
      legs = Math.max(legs, len);
    }
    return hips.distanceTo(head) + legs;
  }

  /** Fator de metros para unidades do jogo: 10 unidades = 1 m (UNITS_PER_METER do runtime). */
  sportScale() { return UNITS_PER_METER; }

  /** Toca um movimento .vrma (VrmaPlayer.play). Devolve a ação do mixer, ou null se o nome não existir. */
  async play(name, opts = {}) {
    if (this.disposed) return null;
    return this.player.play(name, opts);
  }

  /** Para o movimento atual com fade. */
  stop(fade = 0.2) { this.player.stop(fade); }

  /** Comemoração (happy, ou joy no VRM 0.x). Devolve o nome usado ou null. */
  celebrate() { return this.setMood(MOODS.celebrate); }

  /** Derrota (sad, ou sorrow no VRM 0.x). Devolve o nome usado ou null. */
  lose() { return this.setMood(MOODS.lose); }

  /** Rosto neutro (neutral, ou relaxed se o avatar não tiver neutral). Devolve o nome usado ou null. */
  neutral() { return this.setMood(MOODS.neutral); }

  /** Liga a primeira expressão da lista e desliga as outras, com fade no update(). */
  setMood(candidates) {
    const found = candidates.find((n) => this.expressions.has(n)) ?? null;
    for (const name of this.expressions.keys()) {
      this.targets.set(name, name === found ? 1 : 0);
    }
    return found;
  }

  /**
   * Avança o avatar: primeiro o mixer dos movimentos e o fade das expressões; depois vrm.update(dt) só se
   * ownsUpdate (padrão do adaptador: o WEBC chama vrm.update).
   */
  update(dt, { ownsUpdate = this.ownsUpdate } = {}) {
    this.player.update(dt);
    const k = Math.min(1, dt * FADE_PER_SECOND);
    const em = this.vrm.expressionManager;
    for (const name of this.expressions.keys()) {
      if (!this.targets.has(name) && !this.weights.has(name)) continue; // nunca mexida: não sobrescreve o WEBC
      const cur = this.weights.get(name) ?? 0;
      const next = cur + ((this.targets.get(name) ?? 0) - cur) * k;
      this.weights.set(name, next);
      em.setValue(name, next);
    }
    if (ownsUpdate) this.vrm.update(dt);
  }

  /**
   * Põe o avatar na cena (filho de parent). position/quaternion: Vector3/Quaternion ou array.
   * Reinicia os spring bones (o avatar entra na pose atual, sem o rastro da posição anterior).
   */
  attach(parent, position = null, quaternion = null) {
    if (!parent) throw new Error('WebcAvatarAdapter.attach: parent ausente');
    if (this.parent && this.parent !== parent) this.parent.remove(this.vrm.scene);
    parent.add(this.vrm.scene);
    this.parent = parent;
    assign(this.vrm.scene.position, position);
    assign(this.vrm.scene.quaternion, quaternion);
    this.vrm.springBoneManager?.reset();
    return this;
  }

  /** Teletransporte: muda a posição e reinicia os spring bones (sem isso a franja e o cabelo "voam"). */
  teleport(position = null, quaternion = null) {
    assign(this.vrm.scene.position, position);
    assign(this.vrm.scene.quaternion, quaternion);
    this.vrm.springBoneManager?.reset();
    return this;
  }

  /** Tira o avatar da cena sem descartá-lo (o VRM continua com o WEBC). */
  detach() {
    if (this.parent) this.parent.remove(this.vrm.scene);
    this.parent = null;
    return this;
  }

  /** Para o mixer dos movimentos e tira o avatar da cena. Não descarta o VRM, que é do WEBC. */
  dispose() {
    if (this.disposed) return;
    this.player.dispose();
    this.detach();
    this.weights.clear();
    this.targets.clear();
    this.disposed = true;
  }
}
