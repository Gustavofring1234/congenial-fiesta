// Base das modalidades (porte de Activities/Common/SportActivity.cs + SportActor.cs), sem motor gráfico:
//   * a partida é um gerador (function*) no lugar das corrotinas do Unity: `yield 0.5` espera meio segundo, `yield`
//     espera um quadro, `yield () => cond` espera a condição, `yield* sub()` chama outra etapa. update(dt) avança.
//   * atores são dados ({pos, facing, anim, expression}); quem desenha (ActivityStage) copia para os modelos 3D.
//   * gestos e controles chegam por jogador (índice em session.players): o local pelo SportsInputBridge, os remotos
//     pela sala (RoomSync). A CPU decide sozinha com o seu perfil de IA.
//   * tudo que a tela mostra sai como evento ({type, ...}) para o ActivityStage/HUD e para os convidados da sala.
// Assim a mesma partida roda no navegador, no Node (testes, só CPU) e no anfitrião da sala (autoritativo).
import { v3, sub, flat, flatLen, norm, scale, add, rightOf, clamp, pack, round } from './vec3.js';
import { SeededRandom } from './rng.js';
import { aiError } from './AiProfile.js';

export const UPM = 10;

/** Gesto do SportsInputBridge -> gesto canônico das regras (como o GestureEvent do C#). */
export function normalizeGesture(d = {}) {
  const dir = d.dir || { x: 0, y: 1 };
  const force = clamp(+d.force || 0, 0, 1);
  const speed = +d.speed || 0;
  // power: 0..1,3 (acima de 1 = descontrole), como GestureEvent.speed
  const power = clamp(speed > 0 ? Math.max(force, speed) : force, 0, 1.3);
  const angle = Math.hypot(dir.x, dir.y) > 1e-6 ? (Math.atan2(dir.y, dir.x) * 180) / Math.PI : 90;
  return { power, angle, dirX: +dir.x || 0, dirY: +dir.y || 0, hand: d.hand === 'L' ? 'L' : 'R', spin: +d.spin || 0, source: d.source || 'local' };
}

let actorIds = 0;

/** Ator (jogador, CPU, defensor). */
export class SportActor {
  constructor(slot, pos, forward, team = 0) {
    this.id = ++actorIds;
    this.slot = slot;
    this.team = team;
    this.pos = { ...pos };
    this.facing = norm(flat(forward));
    this.anim = null;
    this.animSince = 0;
    this.expression = 'neutral';
    this.moveSpeed = 40;          // u/s (4 m/s)
    this.turnSpeed = 720;         // graus/s
    this.attachments = {};        // osso -> nome do modelo (taco, raquete, luvas)
    this.visible = true;
  }

  get right() { return rightOf(this.facing); }
  get yaw() { return Math.atan2(this.facing.x, this.facing.z); }

  play(anim, time = 0) { if (anim && anim !== this.anim) { this.anim = anim; this.animSince = time; } return true; }

  face(dir, dt = -1) {
    const f = norm(flat(dir));
    if (f.x === 0 && f.z === 0) return;
    if (dt < 0) { this.facing = f; return; }
    const a0 = Math.atan2(this.facing.x, this.facing.z), a1 = Math.atan2(f.x, f.z);
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const maxStep = (this.turnSpeed * Math.PI / 180) * dt;
    const a = a0 + clamp(d, -maxStep, maxStep);
    this.facing = v3(Math.sin(a), 0, Math.cos(a));
  }

  /** Anda até o alvo (no plano). Devolve true quando chegou. */
  moveTowards(target, dt, speedScale = 1, walk = null, idle = null, time = 0) {
    const d = flat(sub(target, this.pos));
    const L = flatLen(d);
    const stepLen = this.moveSpeed * speedScale * dt;
    if (L <= Math.max(0.5, stepLen)) {
      this.pos.x = target.x; this.pos.z = target.z;
      if (idle) this.play(idle, time);
      return true;
    }
    if (stepLen <= 0) return false;
    this.pos = add(this.pos, scale(d, stepLen / L));
    this.face(d, dt);
    if (walk) this.play(walk, time);
    return false;
  }

  attach(bone, model) { if (model) this.attachments[bone] = model; else delete this.attachments[bone]; }
  setExpression(e) { this.expression = e; }

  /** Estado compacto para a sala: [id, x, y, z, yaw, anim, expr]. */
  pack() { return [this.id, ...pack(this.pos, 1), round(this.yaw, 2), this.anim || '', this.expression === 'neutral' ? 0 : this.expression]; }
}

export class SportActivity {
  /**
   * @param {object} o
   * @param {object} o.session  {sport, players:[{profileId, name, human, remote?, ai, info}], options, seed, localIndex}
   * @param {object} o.data     GameplayData
   * @param {object} [o.world]  mundo de colisão (BallBody.meshWorld) quando a modalidade precisa da cena
   */
  constructor({ session, data, world = null } = {}) {
    this.session = session;
    this.data = data;
    this.sport = data ? data.sport(session.sport) : {};
    this.world = world;
    this.rng = new SeededRandom(session.seed || 1);
    this.upm = data ? data.unitsPerMeter : UPM;
    this.time = 0;
    this.dt = 0;
    this.paused = false;
    this.finished = false;
    this.result = null;
    this.actors = [];
    this.balls = [];              // BallBody ativos (update automático)
    this.gestureKind = 'swing';
    this.pending = new Map();     // jogador -> gesto
    this.confirms = new Set();    // jogadores que apertaram confirmar
    this.controls = new Map();    // jogador -> {move, aim, guard, charge}
    this.listeners = new Set();
    this.events = [];             // últimos eventos (para a sala), com número de sequência
    this.seq = 0;
    this.hud = { title: '', score: '', hint: '', meter: null, panes: {}, layouts: new Set() };
    this.camera = { pos: v3(0, 30, 60), look: v3(), fov: 45, sharp: 0 };
    this._co = null;
    this._wait = null;
    this.onFinish = null;
  }

  // ── ciclo ───────────────────────────────────────────────────────
  start() {
    this._co = this.run();
    this._wait = null;
    return this;
  }

  /** Conteúdo da partida (gerador). Chama this.finish(resultado) no fim. */
  *run() { this.finish(this.newResult()); }

  update(dt) {
    if (this.finished || this.paused || !this._co) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.dt = dt;
    this.time += dt;
    for (const b of this.balls) b.update(dt);
    this.tick(dt);
    const w = this._wait;
    if (typeof w === 'number' && this.time < w) return;
    if (typeof w === 'function' && !w(dt)) return;
    this._wait = null;
    let r;
    try { r = this._co.next(); } catch (e) { this._co = null; throw e; }
    if (r.done) { this._co = null; if (!this.finished) this.finish(this.newResult()); return; }
    const v = r.value;
    if (typeof v === 'number') this._wait = this.time + v;
    else if (typeof v === 'function') this._wait = v;
  }

  /** Física/IA por quadro de cada modalidade (opcional). */
  tick(dt) {}

  /** Roda até terminar (testes e CPU contra CPU). Devolve o resultado. */
  simulate({ dt = 1 / 60, maxSeconds = 3600 } = {}) {
    if (!this._co && !this.finished) this.start();
    const n = Math.ceil(maxSeconds / dt);
    for (let i = 0; i < n && !this.finished; i++) this.update(dt);
    return this.result;
  }

  abort() {
    if (this.finished) return;
    this.finish({ ...this.newResult(), aborted: true });
  }

  finish(r) {
    if (this.finished) return;
    this.finished = true;
    r.sport = this.session.sport;
    this.result = r;
    this._co = null;
    this.emit('finish', { result: r });
    if (this.onFinish) this.onFinish(r);
  }

  // ── eventos (tela, som, sala) ──────────────────────────────────
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }

  emit(type, payload = {}) {
    const ev = { ...payload, type, seq: ++this.seq, t: round(this.time, 2) };
    this.events.push(ev);
    if (this.events.length > 48) this.events.shift();
    for (const f of this.listeners) { try { f(ev, this); } catch (e) { console.error(e); } }
    return ev;
  }

  banner(text, seconds) { this.emit('banner', { text, seconds }); return seconds; }
  hint(text) { if (text !== this.hud.hint) { this.hud.hint = text; this.emit('hint', { text }); } }
  score(text) { if (text !== this.hud.score) { this.hud.score = text; this.emit('score', { text }); } }
  title(text) { this.hud.title = text; this.emit('title', { text }); }
  meter(value, visible = true) { this.hud.meter = visible ? clamp(value, 0, 1) : null; }
  pane(layoutKey, pane, text) {
    const id = this.sport.hud ? this.sport.hud[layoutKey] : null;
    if (!id) return;
    const k = id + '/' + pane;
    if (this.hud.panes[k] === text) return;
    this.hud.panes[k] = text;
    this.emit('pane', { layout: id, pane, text: String(text) });
  }
  showLayout(layoutKey, on = true) {
    const id = this.sport.hud ? this.sport.hud[layoutKey] : null;
    if (!id) return;
    if (on) this.hud.layouts.add(id); else this.hud.layouts.delete(id);
    this.emit('layout', { layout: id, on });
  }
  fx(name, at) { if (!this.sport.effects || this.sport.effects.includes(name)) this.emit('fx', { name, at: pack(at, 1) }); }
  impact(strength, hardness = 0.6, hz = 180) { this.emit('impact', { strength: round(strength, 2), hardness, hz }); }
  sfx(kind, volume = 1) { this.emit('sfx', { kind, volume: round(volume, 2) }); }
  cue(name) { this.emit('cue', { name }); }

  cameraSet(pos, look, fov = 45) { this.camera = { pos: { ...pos }, look: { ...look }, fov, sharp: 0 }; }
  cameraFollow(pos, look, sharp, fov = 45) { this.camera = { pos: { ...pos }, look: { ...look }, fov, sharp }; }

  // ── jogadores e entrada ────────────────────────────────────────
  get players() { return this.session.players; }
  M(m) { return m * this.upm; }
  name(slot) { return slot && slot.name ? slot.name : 'CPU'; }
  isHuman(p) { const s = this.players[p]; return !!(s && s.human); }
  aiOf(p) { const s = this.players[p]; return s ? s.ai : null; }
  err(p, scale) { return aiError(this.aiOf(p), this.rng, scale); }

  spawnActor(slot, pos, forward, team = 0) {
    const a = new SportActor(slot, pos, forward, team);
    this.actors.push(a);
    return a;
  }

  removeActor(a) { const i = this.actors.indexOf(a); if (i >= 0) this.actors.splice(i, 1); }

  /** Gesto de um jogador (local ou remoto). */
  pushGesture(p, detail) {
    if (this.paused || this.finished) return;
    this.pending.set(p, detail && detail.power !== undefined ? detail : normalizeGesture(detail));
  }
  pushConfirm(p) { this.confirms.add(p); }
  setControls(p, c) { this.controls.set(p, { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, guard: false, charge: 0, ...c }); }
  controlsOf(p) { return this.controls.get(p) || { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, guard: false, charge: 0 }; }

  takeGesture(p) {
    const g = this.pending.get(p);
    if (!g) return null;
    this.pending.delete(p);
    return g;
  }
  takeConfirm(p) { const ok = this.confirms.has(p); this.confirms.delete(p); return ok; }
  clearGesture(p) { this.pending.delete(p); this.confirms.delete(p); }

  /** Espera o gesto do jogador p. onFrame(dt) roda a cada quadro (mirar); devolver false cancela. */
  *waitGesture(kind, p, onFrame = null, timeout = -1) {
    this.gestureKind = kind;
    this.clearGesture(p);
    const t0 = this.time;
    for (;;) {
      const g = this.takeGesture(p);
      if (g) return g;
      if (onFrame && onFrame(this.dt) === false) return null;
      if (timeout > 0 && this.time - t0 > timeout) return null;
      yield;
    }
  }

  // ── resultado ──────────────────────────────────────────────────
  newResult() {
    return { sport: this.session.sport, players: [], winner: -1, humanWon: false, aborted: false, lines: [], records: [] };
  }

  addPlayer(r, slot, score, text) {
    r.players.push({ profileId: slot.profileId, name: slot.name, human: !!slot.human, score, scoreText: text });
  }

  // ── sala (anfitrião autoritativo) ──────────────────────────────
  /** Estado compacto da partida (sem os eventos). Cada modalidade acrescenta o seu em extraState(). */
  snapshot() {
    return {
      k: this.session.sport,
      t: round(this.time, 2),
      b: this.balls.filter((b) => b.visible !== false).map((b) => [...pack(b.pos, 1), ...pack(b.vel, 1)]),
      a: this.actors.filter((a) => a.visible).map((a) => a.pack()),
      c: [...pack(this.camera.pos, 0), ...pack(this.camera.look, 0), this.camera.fov],
      h: [this.hud.score, this.hud.hint],
      x: this.extraState(),
      f: this.finished ? 1 : 0,
    };
  }

  extraState() { return null; }

  static flat(v) { return flat(v); }
}

export { v3 };
