// Partidas em sala (js/sala.js do WEBC): a sala troca o estado de cada pessoa a cada 120 ms (POST {codigo}/estado com
// meuEstado(); a resposta traz r.pessoas[] e r.agora, o relógio do servidor). Este módulo acrescenta um campo
// compacto "sp" a esse estado, sem mexer nos outros (p, r, e, emo, g, c, pose, rosto), e lê o "sp" das outras pessoas.
//
//   anfitrião (quem criou a partida) é AUTORITATIVO: roda a SportActivity e publica, a cada troca,
//     { v, m (id da partida), r:'h', s (modalidade), lb (lobby), k (quadro-chave a cada 1 s) | d (delta contra o último
//       quadro-chave), ev (eventos recentes), tc (relógio da sala do instantâneo) }
//     O delta é sempre contra o ÚLTIMO QUADRO-CHAVE (não contra a mensagem anterior): o servidor guarda só o estado
//     mais novo de cada pessoa, e um convidado que perdeu trocas ainda consegue aplicar qualquer delta.
//   convidado manda { v, m, r:'g', j (pedido para entrar), gs (últimos gestos com número), ct (controles) } e mostra
//     a partida interpolada pelo relógio da sala (instantes 0,25 s atrás do relógio, entre dois instantâneos).
// Gestos remotos entram na partida do anfitrião em pushGesture(índice do jogador remoto, gesto).
import { round } from '../activities/common/vec3.js';

export const SP_VERSION = 1;
const KEYFRAME_EVERY = 1.0;   // s
const INTERP_DELAY = 0.25;    // s atrás do relógio da sala
const EVENT_WINDOW = 3.0;     // s de eventos repetidos em cada troca (o convidado ignora os já vistos)
const MAX_GESTURES = 4;

// ── deltas e interpolação (funções puras, testadas em tests/sports/stage5) ──────────────────────

const same = (a, b) => (a === b) || JSON.stringify(a) === JSON.stringify(b);

/** Campos do instantâneo que mudaram em relação ao quadro-chave. */
export function diffSnapshot(key, snap) {
  const d = {};
  for (const k of Object.keys(snap)) if (!same(key[k], snap[k])) d[k] = snap[k];
  for (const k of Object.keys(key)) if (!(k in snap)) d[k] = null;
  return d;
}

/** Quadro-chave + delta = instantâneo completo. */
export function applyDelta(key, delta) {
  const s = { ...key };
  for (const [k, v] of Object.entries(delta || {})) { if (v === null) delete s[k]; else s[k] = v; }
  return s;
}

const lerpN = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/** Interpola dois instantâneos (bolas e câmera por índice; atores pelo id). */
export function interpolate(a, b, t) {
  if (!a) return b;
  if (!b || t >= 1) return b;
  if (t <= 0) return a;
  const out = { ...b };
  if (Array.isArray(a.b) && Array.isArray(b.b)) out.b = b.b.map((q, i) => (a.b[i] ? q.map((v, k) => lerpN(a.b[i][k], v, t)) : q));
  if (Array.isArray(a.a) && Array.isArray(b.a)) {
    const prev = new Map(a.a.map((x) => [x[0], x]));
    out.a = b.a.map((x) => {
      const p = prev.get(x[0]);
      if (!p) return x;
      return [x[0], lerpN(p[1], x[1], t), lerpN(p[2], x[2], t), lerpN(p[3], x[3], t), lerpAngle(p[4], x[4], t), x[5], x[6]];
    });
  }
  if (Array.isArray(a.c) && Array.isArray(b.c)) out.c = b.c.map((v, i) => lerpN(a.c[i], v, t));
  return out;
}

/** Gesto canônico -> lista curta [seq, power, angle, dirX, dirY, hand]. */
export const packGesture = (seq, g) => [seq, round(g.power, 3), round(g.angle, 1), round(g.dirX, 3), round(g.dirY, 3), g.hand === 'L' ? 0 : 1];
export const unpackGesture = (a) => ({ power: +a[1] || 0, angle: +a[2] || 90, dirX: +a[3] || 0, dirY: +a[4] || 0, hand: a[5] === 0 ? 'L' : 'R', spin: 0, source: 'room' });

// ── a ligação com a sala ─────────────────────────────────────────────────────────────

export class RoomSync {
  /**
   * @param {object} o
   * @param {object} o.sala       instância de Sala (js/sala.js): usa meuEstado(), remotos (Map id -> Remoto), eu.id
   * @param {Function} [o.clock]  relógio da sala em segundos (padrão C.relogioDaSala)
   */
  constructor({ sala, clock = null } = {}) {
    this.sala = sala;
    this.clock = clock || (() => (globalThis.C && globalThis.C.relogioDaSala ? globalThis.C.relogioDaSala() : Date.now() / 1000));
    this.role = null;              // 'host' | 'guest' | null
    this.matchId = null;
    this.activity = null;          // anfitrião
    this.lobby = null;             // anfitrião: {sport, options, seed, slots:[{peer, name}], started}
    this.peers = new Map();        // id -> último sp recebido
    this.seenGestures = new Map(); // anfitrião: peer -> último seq
    this.slotOfPeer = new Map();   // anfitrião: peer -> índice em session.players
    this.key = null; this.keyAt = -Infinity; this.keySeq = 0;
    this.outgoing = null;
    this.myGestures = []; this.gestureSeq = 0; this.myControls = null; this.joinRequest = null;
    this.buffer = [];              // convidado: [{tc, snap}]
    this.guestKey = null; this.guestKeySeq = -1;
    this.seenEvents = 0;
    this.hostId = null;
    this.onEvent = null;           // convidado: eventos da partida remota
    this.onLobby = null;           // (lobby, hostId) quando um anfitrião anuncia
    this.onJoin = null;            // anfitrião: (peerId, nome) pediu para entrar
    this._orig = null;
    this._patched = new WeakSet();
  }

  /** Liga ao estado da sala sem quebrar os outros campos. */
  attach() {
    const sala = this.sala;
    if (!sala || this._orig) return this;
    this._orig = sala.meuEstado.bind(sala);
    sala.meuEstado = () => {
      const e = this._orig();
      if (this.outgoing) e.sp = this.outgoing;
      return e;
    };
    return this;
  }

  detach() {
    if (this._orig && this.sala) this.sala.meuEstado = this._orig;
    this._orig = null;
    this.outgoing = null;
    this.role = null;
  }

  get myId() { return this.sala && this.sala.eu ? this.sala.eu.id : 'eu'; }

  /** Lê o "sp" dos remotos (embrulha Remoto.receber uma vez por remoto). Chamado a cada quadro. */
  _watchRemotes() {
    const rem = this.sala && this.sala.remotos;
    if (!rem) return;
    for (const r of rem.values()) {
      if (this._patched.has(r)) continue;
      this._patched.add(r);
      const orig = r.receber.bind(r);
      r.receber = (j) => { const out = orig(j); try { this.receive(r.id, (j.estado || {}).sp, j.nome); } catch (e) { console.error(e); } return out; };
    }
    for (const id of [...this.peers.keys()]) if (!rem.has(id)) this.peers.delete(id);
  }

  // ── anfitrião ───────────────────────────────────────────────
  host(lobby) {
    this.role = 'host';
    this.matchId = `${this.myId}:${Date.now().toString(36)}`;
    this.lobby = { sport: lobby.sport, options: lobby.options || {}, seed: lobby.seed || 1, slots: [], started: false };
    this.slotOfPeer.clear();
    this.seenGestures.clear();
    this._publishHost();
    return this.matchId;
  }

  /** Aceita um convidado no próximo lugar livre (índice em session.players definido pela máquina de estados). */
  admit(peerId, name, slotIndex) {
    if (this.role !== 'host') return;
    this.slotOfPeer.set(peerId, slotIndex);
    this.lobby.slots = this.lobby.slots.filter((s) => s.peer !== peerId).concat([{ peer: peerId, name, slot: slotIndex }]);
    this._publishHost();
  }

  startMatch(activity) {
    this.activity = activity;
    this.lobby.started = true;
    this.lobby.seed = activity.session.seed;
    this.key = null; this.keyAt = -Infinity;
    this._publishHost();
  }

  endMatch() {
    this.activity = null;
    if (this.lobby) this.lobby.started = false;
    this._publishHost();
  }

  _publishHost() {
    const sp = { v: SP_VERSION, m: this.matchId, r: 'h', s: this.lobby ? this.lobby.sport : null, lb: this.lobby };
    const a = this.activity;
    if (a) {
      const now = this.clock();
      const snap = a.snapshot();
      if (!this.key || now - this.keyAt >= KEYFRAME_EVERY) {
        this.key = snap; this.keyAt = now; this.keySeq++;
        sp.k = snap;
      } else sp.d = diffSnapshot(this.key, snap);
      sp.ks = this.keySeq;
      sp.tc = round(now, 3);
      sp.ev = a.events.filter((e) => a.time - e.t <= EVENT_WINDOW);
    }
    this.outgoing = sp;
  }

  // ── convidado ───────────────────────────────────────────────
  join(hostId, matchId) {
    this.role = 'guest';
    this.hostId = hostId;
    this.matchId = matchId;
    this.joinRequest = matchId;
    this.buffer = []; this.guestKey = null; this.guestKeySeq = -1; this.seenEvents = 0;
    this._publishGuest();
  }

  /** Gesto local do convidado (vai para o anfitrião nas próximas trocas). */
  sendGesture(g) {
    this.myGestures.push(packGesture(++this.gestureSeq, g));
    if (this.myGestures.length > MAX_GESTURES) this.myGestures.shift();
    this._publishGuest();
  }

  sendControls(c) {
    this.myControls = [round(c.move.x, 2), round(c.move.y, 2), round(c.aim.x, 2), round(c.aim.y, 2), c.guard ? 1 : 0, round(c.charge || 0, 2)];
    this._publishGuest();
  }

  _publishGuest() {
    this.outgoing = { v: SP_VERSION, m: this.matchId, r: 'g', j: this.joinRequest, gs: this.myGestures.slice(), ct: this.myControls };
  }

  /** Instantâneo a mostrar agora (interpolado), ou null. */
  view() {
    if (this.role !== 'guest' || !this.buffer.length) return null;
    const t = this.clock() - INTERP_DELAY;
    const B = this.buffer;
    if (t <= B[0].tc) return B[0].snap;
    for (let i = 0; i < B.length - 1; i++) {
      if (t >= B[i].tc && t <= B[i + 1].tc) {
        const span = B[i + 1].tc - B[i].tc;
        return interpolate(B[i].snap, B[i + 1].snap, span > 1e-6 ? (t - B[i].tc) / span : 1);
      }
    }
    return B[B.length - 1].snap;
  }

  // ── recepção (dos dois papéis) ──────────────────────────────
  receive(peerId, sp, name = '') {
    if (!sp || sp.v !== SP_VERSION) { this.peers.delete(peerId); return; }
    this.peers.set(peerId, { ...sp, name });
    if (sp.r === 'h' && this.onLobby && sp.lb) this.onLobby(sp.lb, peerId, sp.m, name);
    if (this.role === 'host' && sp.r === 'g' && sp.m === this.matchId) this._fromGuest(peerId, sp, name);
    if (this.role === 'guest' && sp.r === 'h' && peerId === this.hostId && sp.m === this.matchId) this._fromHost(sp);
  }

  _fromGuest(peerId, sp, name) {
    if (sp.j && !this.slotOfPeer.has(peerId) && this.onJoin) this.onJoin(peerId, name);
    const slot = this.slotOfPeer.get(peerId);
    const a = this.activity;
    if (slot === undefined || !a) return;
    const last = this.seenGestures.get(peerId) || 0;
    for (const g of sp.gs || []) if (g[0] > last) { a.pushGesture(slot, unpackGesture(g)); this.seenGestures.set(peerId, g[0]); }
    if (Array.isArray(sp.ct)) a.setControls(slot, { move: { x: sp.ct[0], y: sp.ct[1] }, aim: { x: sp.ct[2], y: sp.ct[3] }, guard: !!sp.ct[4], charge: sp.ct[5] || 0 });
  }

  _fromHost(sp) {
    let snap = null;
    if (sp.k) { this.guestKey = sp.k; this.guestKeySeq = sp.ks; snap = sp.k; }
    else if (sp.d && this.guestKey && sp.ks === this.guestKeySeq) snap = applyDelta(this.guestKey, sp.d);
    if (snap && typeof sp.tc === 'number') {
      const B = this.buffer;
      if (!B.length || sp.tc > B[B.length - 1].tc) B.push({ tc: sp.tc, snap });
      while (B.length > 12) B.shift();
    }
    for (const e of sp.ev || []) {
      if (e.seq <= this.seenEvents) continue;
      this.seenEvents = e.seq;
      if (this.onEvent) this.onEvent(e);
    }
  }

  /** A cada quadro: lê os remotos e (anfitrião) atualiza o que vai na próxima troca. */
  update() {
    this._watchRemotes();
    if (this.role === 'host') this._publishHost();
  }

  /** Anfitriões anunciando partidas agora: [{peer, name, matchId, lobby}]. */
  openMatches() {
    const out = [];
    for (const [peer, sp] of this.peers) if (sp.r === 'h' && sp.lb && !sp.lb.started) out.push({ peer, name: sp.name, matchId: sp.m, lobby: sp.lb });
    return out;
  }
}
