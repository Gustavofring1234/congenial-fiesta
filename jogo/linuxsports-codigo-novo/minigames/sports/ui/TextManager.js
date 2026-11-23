// Textos do jogo por ID, nos idiomas do WEBC (pt, en, ja).
//
// Fontes (Text/text_index.json, de tools/stage_web_assets.py):
//   bmg  Text/<idioma>/<arquivo>.text.json  extração completa dos .bmg (MESGbmg1): id (MID1), index (INF1), text
//        com {0}, {1}... e args. O jogo só traz 'us' (= en). pt e ja vêm de tools/translate_texts.py (offline,
//        Gemini, chave só no ambiente do servidor) quando gerados; mensagem sem tradução cai no inglês.
//   tsv  Text/tsv/<arquivo>.tsv  extração parcial (indice -> texto) de raw/docs/textos, usada só quando o .bmg
//        não tem a mensagem.
// Os ids se repetem entre arquivos: toda busca leva o arquivo ('common_message' ou 'sports_message').
import { defaultStore } from '../engine/assets/AssetStore.js';

export const LANGUAGES = ['pt', 'en', 'ja'];
const BMG_LANG = { en: 'us', pt: 'pt', ja: 'ja' };

const parseId = (id) => (typeof id === 'string' ? (id.startsWith('0x') ? parseInt(id, 16) : Number(id)) : id);

/** Idioma ativo do WEBC (<html data-idioma>), senão o do navegador, senão pt. */
export function webcLanguage() {
  const d = globalThis.document?.documentElement?.dataset?.idioma;
  if (LANGUAGES.includes(d)) return d;
  const nav = globalThis.navigator?.language?.slice(0, 2).toLowerCase();
  return LANGUAGES.includes(nav) ? nav : 'pt';
}

function parseTsv(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const tab = lines[i].indexOf('\t');
    if (tab < 0) continue;
    const idx = Number(lines[i].slice(0, tab));
    const t = lines[i].slice(tab + 1).replace(/\\n/g, '\n');
    if (Number.isFinite(idx) && t) out.set(idx, t);
  }
  return out;
}

export class TextManager {
  constructor(store = defaultStore()) {
    this.store = store;
    this.language = 'en';
    this.files = new Map();     // `${lang}/${file}` -> {byId, byIndex}
    this.tsv = new Map();       // file -> Map(index -> text)
    this.listeners = new Set();
    this.observer = null;
  }

  /** Carrega um idioma (+ o inglês como reserva e os .tsv). */
  static async load(language = webcLanguage(), store = defaultStore()) {
    const tm = new TextManager(store);
    await tm.setLanguage(language);
    return tm;
  }

  async index() { return this.store.json('Text/text_index.json'); }

  async loadLang(lang) {
    const idx = await this.index();
    const bl = BMG_LANG[lang] || lang;
    await Promise.all(idx.bmg.filter((e) => e.language === bl).map(async (e) => {
      const key = `${lang}/${e.file}`;
      if (this.files.has(key)) return;
      const doc = await this.store.json(e.path);
      const byId = new Map(), byIndex = new Map();
      for (const m of doc.messages) { byId.set(m.id, m); byIndex.set(m.index, m); }
      this.files.set(key, { byId, byIndex });
    }));
    if (!this.tsv.size) {
      await Promise.all((idx.tsv || []).map(async (t) => {
        try { this.tsv.set(t.file, parseTsv(await this.store.text(t.path))); } catch (e) { /* tsv é opcional */ }
      }));
    }
  }

  /** Troca o idioma (pt, en, ja); avisa quem chamou onChange. */
  async setLanguage(lang) {
    const l = LANGUAGES.includes(lang) ? lang : 'en';
    await this.loadLang('en');
    if (l !== 'en') await this.loadLang(l);
    this.language = l;
    for (const f of this.listeners) { try { f(l); } catch (e) { console.error(e); } }
    return l;
  }

  /** Segue <html data-idioma> do WEBC (C.definirIdioma). Devolve a função que para de seguir. */
  followWebc() {
    const html = globalThis.document?.documentElement;
    if (!html || typeof MutationObserver !== 'function') return () => {};
    this.observer?.disconnect();
    this.observer = new MutationObserver(() => { const l = webcLanguage(); if (l !== this.language) this.setLanguage(l); });
    this.observer.observe(html, { attributes: true, attributeFilter: ['data-idioma'] });
    return () => { this.observer?.disconnect(); this.observer = null; };
  }

  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }

  /** Mensagem {id, index, text, args} no idioma ativo, no inglês ou no .tsv; null se não existir. */
  get(file, id) {
    const n = parseId(id);
    for (const lang of [this.language, 'en']) {
      const m = this.files.get(`${lang}/${file}`)?.byId.get(n);
      if (m && m.text) return { ...m, language: lang };
    }
    const en = this.files.get(`en/${file}`)?.byId.get(n);
    const t = en ? this.tsv.get(file)?.get(en.index) : null;
    if (t) return { ...en, text: t, language: 'tsv' };
    return en ? { ...en, language: 'en' } : null;
  }

  byIndex(file, index) {
    for (const lang of [this.language, 'en']) {
      const m = this.files.get(`${lang}/${file}`)?.byIndex.get(index);
      if (m && m.text) return { ...m, language: lang };
    }
    const t = this.tsv.get(file)?.get(index);
    return t ? { index, text: t, language: 'tsv' } : null;
  }

  has(file, id) { return !!this.get(file, id)?.text; }

  /** Texto com {n} trocados pelos argumentos; id inexistente vira "[arquivo#id]" (visível sem quebrar a tela). */
  format(file, id, ...args) {
    const m = this.get(file, id);
    if (!m) return `[${file}#${id}]`;
    return m.text.replace(/\{(\d+)\}/g, (s, i) => (args[+i] !== undefined ? String(args[+i]) : s));
  }

  /** Busca por id (decimal ou 0x...) ou trecho do texto, sem diferenciar caixa. */
  search(query, { file = null, limit = 200 } = {}) {
    const q = String(query).toLowerCase();
    const id = /^(0x[0-9a-f]+|\d+)$/i.test(q) ? parseId(q) : null;
    const out = [];
    for (const [key, f] of this.files) {
      const [lang, name] = key.split('/');
      if (lang !== this.language && lang !== 'en') continue;
      if (file && name !== file) continue;
      for (const m of f.byId.values()) {
        if ((id !== null && m.id === id) || (m.text && m.text.toLowerCase().includes(q))) out.push({ file: name, language: lang, ...m });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
