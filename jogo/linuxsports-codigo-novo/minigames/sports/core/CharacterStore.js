// Personagens do jogador (Tarefa "escolha ou crie o seu personagem antes da partida"):
//   * Miis criados no editor estilo Wii (core/MiiEditor.js);
//   * avatares .vrm importados do aparelho na tela de escolha;
//   * as personagens VRoid (.vrm) que o WEBC já guardou no navegador (Loja, Sketchfab, importadas em Personagens),
//     lidas pela API do WEBC (C.listarPersonagens / C.lerPersonagem) quando ela existe.
// O índice (nome, tipo, data, info do Mii) fica no localStorage — leitura síncrona e rápida — e os dados completos
// (o Mii e o arquivo .vrm, que pode ter dezenas de MB) no IndexedDB. Sem IndexedDB (navegação privada), os Miis ainda
// ficam no localStorage e o .vrm importado vale só nesta visita.
import { memoryStorage } from './RecordStore.js';

const INDEX_KEY = 'ls.chars';
const DB_NAME = 'linuxsports-personagens';
const DB_STORE = 'chars';

function safeLocalStorage() {
  try { const s = globalThis.localStorage; if (s) { s.getItem('ls.teste'); return s; } } catch (e) { /* bloqueado */ }
  return memoryStorage();
}

let ids = 0;
const newId = (p) => `${p}-${Date.now().toString(36)}-${(++ids).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

export class CharacterStore {
  /**
   * @param {object} [o]
   * @param {Storage} [o.storage]
   * @param {IDBFactory|null} [o.indexedDB]
   * @param {object|null} [o.webc]  {listar(): Promise<[{id, nome, tipo}]>, ler(id): Promise<{roupas:[{id, blob}], roupaAtual}>}
   */
  constructor({ storage = safeLocalStorage(), indexedDB = globalThis.indexedDB || null, webc = null } = {}) {
    this.storage = storage;
    this.idb = indexedDB;
    this.webc = webc;
    this.db = null;
    this.memory = new Map();    // blobs sem IndexedDB (só nesta visita)
    this._open = null;
  }

  /** API de personagens do WEBC, se a página a tiver carregado. */
  static webcApi(C = globalThis.C) {
    if (!C || typeof C.listarPersonagens !== 'function' || typeof C.lerPersonagem !== 'function') return null;
    return { listar: () => C.listarPersonagens(), ler: (id) => C.lerPersonagem(id) };
  }

  _index() { try { return JSON.parse(this.storage.getItem(INDEX_KEY) || '[]') || []; } catch (e) { return []; } }
  _writeIndex(list) { this.storage.setItem(INDEX_KEY, JSON.stringify(list)); }

  _db() {
    if (!this.idb) return Promise.resolve(null);
    if (!this._open) {
      this._open = new Promise((ok) => {
        try {
          const r = this.idb.open(DB_NAME, 1);
          r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(DB_STORE)) r.result.createObjectStore(DB_STORE); };
          r.onsuccess = () => ok(r.result);
          r.onerror = () => ok(null);
        } catch (e) { ok(null); }
      }).then((db) => (this.db = db));
    }
    return this._open;
  }

  async _put(key, value) {
    const db = await this._db();
    if (!db) { this.memory.set(key, value); return; }
    await new Promise((ok, fail) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => ok();
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error || new Error('o navegador recusou guardar (pouco espaço?)'));
    });
  }

  async _get(key) {
    if (this.memory.has(key)) return this.memory.get(key);
    const db = await this._db();
    if (!db) return undefined;
    return new Promise((ok) => {
      try {
        const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
        req.onsuccess = () => ok(req.result);
        req.onerror = () => ok(undefined);
      } catch (e) { ok(undefined); }
    });
  }

  async _delete(key) {
    this.memory.delete(key);
    const db = await this._db();
    if (!db) return;
    await new Promise((ok) => { const tx = db.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).delete(key); tx.oncomplete = () => ok(); tx.onerror = () => ok(); });
  }

  /**
   * Todos os personagens salvos, os mais novos primeiro:
   * [{key, kind: 'mii'|'vrm', name, source: 'local'|'webc', created, info?}]
   */
  async list() {
    const own = this._index().map((e) => ({ ...e, source: 'local' }));
    let webc = [];
    if (this.webc) {
      try {
        webc = ((await this.webc.listar()) || []).filter((p) => p.tipo === 'vrm')
          .map((p) => ({ key: 'webc:' + p.id, webcId: p.id, kind: 'vrm', name: p.nome || 'Personagem', source: 'webc', created: p.criado || 0 }));
      } catch (e) { webc = []; }
    }
    return [...own, ...webc].sort((a, b) => (b.created || 0) - (a.created || 0));
  }

  /** Guarda um Mii do editor. Devolve a entrada. */
  async saveMii(info) {
    const entry = { key: newId('mii'), kind: 'mii', name: info.name, created: Date.now(), info };
    const list = this._index();
    list.push(entry);
    this._writeIndex(list);              // o Mii é pequeno: o índice já o guarda inteiro (vale sem IndexedDB)
    try { await this._put(entry.key, info); } catch (e) { /* o localStorage já tem */ }
    return { ...entry, source: 'local' };
  }

  /** Importa um .vrm do aparelho (File/Blob). Confere a assinatura glTF binário antes de guardar. */
  async importVrm(file, name = '') {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (String.fromCharCode(...head) !== 'glTF') throw new Error('o arquivo não é um .vrm (glTF binário)');
    const entry = { key: newId('vrm'), kind: 'vrm', name: (name || file.name || 'Avatar').replace(/\.vrm$/i, '').slice(0, 40), created: Date.now(), size: file.size };
    await this._put(entry.key, file);
    const list = this._index();
    list.push(entry);
    this._writeIndex(list);
    return { ...entry, source: 'local' };
  }

  /** O arquivo .vrm (Blob) de uma entrada vrm (do jogo ou do WEBC). */
  async vrmBlob(entry) {
    if (entry.source === 'webc') {
      const p = await this.webc.ler(entry.webcId);
      if (!p || !p.roupas || !p.roupas.length) throw new Error('personagem do WEBC sem roupa .vrm');
      const r = p.roupas.find((x) => x.id === p.roupaAtual) || p.roupas[0];
      return r.blob;
    }
    const b = await this._get(entry.key);
    if (!b) throw new Error('o arquivo deste avatar não está mais guardado neste navegador');
    return b;
  }

  async remove(entry) {
    if (entry.source !== 'local') return false;
    this._writeIndex(this._index().filter((e) => e.key !== entry.key));
    await this._delete(entry.key);
    return true;
  }
}

/** Lê um .vrm (Blob) com o GLTFLoader + VRMLoaderPlugin do pacote do WEBC. Devolve o VRM (three-vrm). */
export async function loadVrm(blob, runtime) {
  const loader = new runtime.GLTFLoader();
  loader.register((parser) => new runtime.VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(await blob.arrayBuffer(), '');
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('o arquivo não tem um avatar VRM');
  if (runtime.has('VRMUtils')) {
    try { runtime.VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch (e) { /* otimização opcional */ }
    // VRM 0.x olha para -Z: gira para +Z (o mesmo que o palco do WEBC faz)
    try { if (vrm.meta && vrm.meta.metaVersion === '0') runtime.VRMUtils.rotateVRM0(vrm); } catch (e) { /* VRM 1.0 */ }
  }
  vrm.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  return vrm;
}
