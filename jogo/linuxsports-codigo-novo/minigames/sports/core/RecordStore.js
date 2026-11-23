// Recordes por perfil com os campos do RPSportsPlayerData (getters/setters do DOL listados em gameplay_data.json ->
// records: BowStandardBest, BowPerfectCount, GolAceCount, GolStandardBest, BsbRenzokuBest, TnsSuccess, SkillLevel,
// StandardPlayCount...). Porte de Core/Game/RecordStore.cs: no Unity era PlayerPrefs; aqui é localStorage (leitura
// síncrona para a interface) espelhado no IndexedDB (cópia durável: sobrevive a limpezas do localStorage e é
// restaurada no próximo ready()). Pontos de habilidade por modalidade (0..2000) ajustados como Elo.
import { skillDelta, SKILL_MAX } from '../activities/common/AiProfile.js';

const PREFIX = 'ls.rec.';
const DB_NAME = 'linuxsports';
const DB_STORE = 'records';

/** Armazenamento em memória com a interface do localStorage (testes, navegação privada). */
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

function safeLocalStorage() {
  try { const s = globalThis.localStorage; if (s) { s.getItem('ls.teste'); return s; } } catch (e) { /* bloqueado */ }
  return memoryStorage();
}

export const RecordMode = Object.freeze({ Higher: 'higher', Lower: 'lower', Add: 'add' });

export class RecordStore {
  /**
   * @param {object} [o]
   * @param {string[]} [o.fields]      campos válidos (GameplayData.recordFields); vazio = aceita todos
   * @param {Storage} [o.storage]      localStorage (padrão) ou memoryStorage()
   * @param {IDBFactory|null} [o.indexedDB]  null desliga a cópia durável
   */
  constructor({ fields = [], storage = safeLocalStorage(), indexedDB = globalThis.indexedDB || null } = {}) {
    this.valid = fields.length ? new Set(fields) : null;
    this.storage = storage;
    this.idb = indexedDB;
    this.db = null;
    this._ready = null;
  }

  setValidFields(fields) { this.valid = fields && fields.length ? new Set(fields) : null; }
  isValid(field) { return !this.valid || this.valid.has(field); }
  static key(profile, field, variant = '') { return PREFIX + profile + '.' + field + (variant ? '.' + variant : ''); }

  /** Abre o IndexedDB e restaura o que faltar no localStorage. Pode ser ignorado (tudo funciona sem). */
  ready() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      if (!this.idb) return this;
      try {
        this.db = await new Promise((ok, fail) => {
          const r = this.idb.open(DB_NAME, 1);
          r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(DB_STORE)) r.result.createObjectStore(DB_STORE); };
          r.onsuccess = () => ok(r.result);
          r.onerror = () => fail(r.error);
        });
        const all = await this._idbAll();
        for (const [k, v] of all) if (this.storage.getItem(k) === null) this.storage.setItem(k, String(v));
        // e o caminho inverso: o que só existe no localStorage vai para o IndexedDB
        for (let i = 0; i < this.storage.length; i++) {
          const k = this.storage.key(i);
          if (k && k.startsWith(PREFIX) && !all.has(k)) this._idbPut(k, this.storage.getItem(k));
        }
      } catch (e) { this.db = null; }
      return this;
    })();
    return this._ready;
  }

  _idbAll() {
    return new Promise((ok) => {
      const out = new Map();
      try {
        const tx = this.db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { out.set(c.key, c.value); c.continue(); } else ok(out); };
        req.onerror = () => ok(out);
      } catch (e) { ok(out); }
    });
  }

  _idbPut(k, v) {
    if (!this.db) return;
    try { const tx = this.db.transaction(DB_STORE, 'readwrite'); if (v === null) tx.objectStore(DB_STORE).delete(k); else tx.objectStore(DB_STORE).put(v, k); } catch (e) { /* cópia durável indisponível */ }
  }

  _set(k, v) { this.storage.setItem(k, String(v)); this._idbPut(k, String(v)); }

  has(profile, field, variant = '') { return this.storage.getItem(RecordStore.key(profile, field, variant)) !== null; }

  get(profile, field, variant = '', def = 0) {
    const v = this.storage.getItem(RecordStore.key(profile, field, variant));
    const n = v === null ? NaN : parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  }

  /**
   * Envia um valor {field, variant?, value, mode: 'higher'|'lower'|'add'}. Devolve true se virou recorde novo
   * (no modo 'add' devolve false: é contagem, não recorde).
   */
  submit(profile, s) {
    if (!profile || !this.isValid(s.field)) return false;
    const k = RecordStore.key(profile, s.field, s.variant || '');
    const has = this.storage.getItem(k) !== null;
    const old = this.get(profile, s.field, s.variant || '');
    const mode = s.mode || RecordMode.Higher;
    let improved, value;
    if (mode === RecordMode.Add) { value = old + s.value; improved = s.value !== 0; }
    else if (mode === RecordMode.Lower) { improved = !has || s.value < old; value = improved ? s.value : old; }
    else { improved = !has || s.value > old; value = improved ? s.value : old; }
    if (improved) this._set(k, value);
    return improved && mode !== RecordMode.Add;
  }

  skill(profile, sport) { return this.get(profile, 'SkillLevel', sport, 0); }

  /** Atualiza os pontos de habilidade (Elo contra a força média da CPU) e devolve a variação. */
  updateSkill(profile, sport, opponentStrength01, outcome01) {
    const cur = this.skill(profile, sport);
    const next = Math.max(0, Math.min(SKILL_MAX, cur + skillDelta(cur, opponentStrength01, outcome01)));
    this._set(RecordStore.key(profile, 'SkillLevel', sport), next);
    return next - cur;
  }

  /** Registra o resultado de uma partida: recordes, contagem de partidas e habilidade. {newRecords:[{field,value}], skillDelta} */
  submitResult(profile, result, session) {
    const newRecords = [];
    for (const rec of result.records || []) if (this.submit(profile, rec)) newRecords.push({ field: rec.field, variant: rec.variant || '', value: rec.value });
    this.submit(profile, { field: 'StandardPlayCount', value: 1, mode: RecordMode.Add });
    if (!this.has(profile, 'StandardFirstDate')) this.submit(profile, { field: 'StandardFirstDate', value: Math.floor(Date.now() / 86400000), mode: RecordMode.Lower });
    let delta = 0;
    const cpus = (session.players || []).filter((p) => !p.human && p.ai);
    if (cpus.length) {
      const opp = cpus.reduce((t, p) => t + p.ai.skill, 0) / cpus.length;
      delta = this.updateSkill(profile, session.sport, opp, result.winner < 0 ? 0.5 : result.humanWon ? 1 : 0);
    }
    return { newRecords, skillDelta: delta, skill: this.skill(profile, session.sport) };
  }

  /** Todos os valores de um perfil {chave sem prefixo: valor}. */
  all(profile) {
    const out = {};
    const pre = PREFIX + profile + '.';
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k && k.startsWith(pre)) { const n = parseInt(this.storage.getItem(k), 10); if (Number.isFinite(n)) out[k.slice(pre.length)] = n; }
    }
    return out;
  }

  clear(profile) {
    const pre = PREFIX + profile + '.';
    const keys = [];
    for (let i = 0; i < this.storage.length; i++) { const k = this.storage.key(i); if (k && k.startsWith(pre)) keys.push(k); }
    for (const k of keys) { this.storage.removeItem(k); this._idbPut(k, null); }
  }
}

/** Rótulos dos recordes (tela de recordes e de resultado). */
export const RECORD_LABELS = Object.freeze({
  BowStandardBest: 'Melhor pontuação no boliche', BowPerfectCount: 'Jogos perfeitos', GolStandardBest: 'Melhor resultado no golfe',
  GolAceCount: 'Hole in one', BsbRenzokuBest: 'Rebatidas seguidas', TnsSuccess: 'Vitórias no tênis', StandardPlayCount: 'Partidas',
  SkillLevel: 'Habilidade',
});
