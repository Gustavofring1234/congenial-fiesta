// Textos do jogo (.bmg), extraídos por tools/bmg_extract.py para assets/text/<idioma>/<arquivo>.text.json.
//
// Cada mensagem tem `id` (valor da seção MID1, único por arquivo), `index` (posição na INF1),
// `text` com {0}, {1}… onde o jogo insere valores (`args`: 'value' = número/texto, 'name' = nome do Mii)
// e `controls` (tags de janela/formatação, sem efeito no texto).
// Os ids se repetem entre arquivos, então toda busca leva o arquivo: 'common_message' ou 'sports_message'.
import { getJson } from '../engine/assets.js';

const parseId = (id) => (typeof id === 'string' ? Number(id) : id); // aceita 0x3e700, '0x3e700' ou '255744'

export class TextManager {
  /** Carrega todos os arquivos de um idioma listados em index/text-index.json. */
  static async load({ language = 'us', fetchJson = getJson } = {}) {
    const index = await fetchJson('index/text-index.json');
    const entries = index.filter((e) => e.language === language);
    if (!entries.length) throw new Error(`TextManager: nenhum texto para o idioma "${language}"`);
    const tm = new TextManager(language);
    for (const e of entries) tm.add(await fetchJson(e.path));
    return tm;
  }

  constructor(language) {
    this.language = language;
    this.files = new Map(); // arquivo -> { byId: Map, messages: [] }
  }

  add(doc) {
    this.files.set(doc.file, { byId: new Map(doc.messages.map((m) => [m.id, m])), messages: doc.messages });
  }

  /** Mensagem completa ou null. */
  get(file, id) {
    return this.files.get(file)?.byId.get(parseId(id)) ?? null;
  }

  byIndex(file, index) {
    return this.files.get(file)?.messages[index] ?? null;
  }

  /** Texto com os {n} trocados pelos argumentos; id inexistente vira "[arquivo#id]" (visível, sem quebrar a tela). */
  format(file, id, ...args) {
    const m = this.get(file, id);
    if (!m) return `[${file}#${typeof id === 'number' ? `0x${id.toString(16)}` : id}]`;
    return m.text.replace(/\{(\d+)\}/g, (all, n) => (args[n] !== undefined ? String(args[n]) : all));
  }

  /** Busca por id (decimal ou 0x…) ou por trecho do texto, sem diferenciar caixa. */
  search(query, { file = null, limit = 200 } = {}) {
    const q = String(query).trim().toLowerCase();
    const asId = /^(0x[0-9a-f]+|\d+)$/.test(q) ? Number(q) : null;
    const out = [];
    for (const [name, f] of this.files) {
      if (file && name !== file) continue;
      for (const m of f.messages) {
        if (!q || m.id === asId || m.text.toLowerCase().includes(q)) {
          out.push({ file: name, ...m });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }
}
