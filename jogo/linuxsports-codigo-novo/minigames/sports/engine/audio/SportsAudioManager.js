// Áudio dos minigames no WEBC (Web Audio API). Porte de AudioManager.cs e ProceduralAudio.cs:
//   - os 5 .wav do menu Home (Audio/audio_index.json, gerado por tools/export_audio.py) são decodificados no load();
//     os 8 bancos .brsar do jogo não estão no projeto: entram depois por registerBank();
//   - sem clipe, o efeito é sintetizado (impacto, apito, torcida, vento) de forma determinística pela semente;
//   - o contexto é liberado no primeiro gesto do usuário (unlock()).
//
// As funções synth* são puras: devolvem Float32Array em [-1, 1] para um sampleRate e uma semente. Assim são testáveis
// em Node sem AudioContext. O gerenciador só monta os AudioBuffer e os nós (fontes, ganhos, barramentos).

/** Limiares de impacto por tipo de objeto (tom, dureza, duração, ganho), como AudioManager.PlayImpact. */
export const IMPACT_KINDS = {
  ball: { pitch: 180, hardness: 0.6, duration: 0.35, gain: 0.9 },  // bola na raquete, bola de beisebol
  pin: { pitch: 260, hardness: 0.9, duration: 0.3, gain: 0.85 },   // pino de boliche (madeira, estalo)
  punch: { pitch: 110, hardness: 0.3, duration: 0.3, gain: 0.95 }, // soco (corpo, tom grave)
  bat: { pitch: 320, hardness: 0.85, duration: 0.4, gain: 0.9 },   // taco de beisebol
  club: { pitch: 140, hardness: 0.7, duration: 0.35, gain: 0.9 },  // taco de golfe
};

const TAU = 2 * Math.PI;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const nQuadros = (duracao, sr) => Math.max(1, Math.floor(duracao * sr));

/**
 * Gerador de ruído determinístico (xorshift32) em [-1, 1). A mesma semente dá sempre a mesma sequência.
 * @returns {() => number}
 */
export function makeRng(semente) {
  let x = (Math.imul((semente | 0) ^ 0x5bd1e995, 0x9e3779b1) ^ 0x6d2b79f5) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return (x / 4294967296) * 2 - 1;
  };
}

/** Normaliza o pico para peakTarget (no máximo ×4, como ProceduralAudio.Normalize). */
function normalizar(s, alvo) {
  let pico = 0;
  for (let i = 0; i < s.length; i++) pico = Math.max(pico, Math.abs(s[i]));
  if (pico <= 1e-6) return s;
  let k = Math.min(alvo / pico, 4);
  if (pico * k > 1) k = 1 / pico;
  for (let i = 0; i < s.length; i++) s[i] *= k;
  return s;
}

/**
 * Batida: tom com queda de altura + estalo de ruído curto, com decaimento exponencial (ProceduralAudio, Impact).
 * @param {number} sr  taxa de amostragem
 * @param {number} semente
 */
export function synthImpact(sr, semente, { duration = 0.35, pitch = 180, hardness = 0.6, gain = 0.9 } = {}) {
  const n = nQuadros(duration, sr);
  const o = new Float32Array(n);
  const rnd = makeRng(semente);
  const dur = clamp01(hardness), g = clamp01(gain);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = pitch * (1 + 1.5 * Math.exp(-t * 40));
    const corpo = Math.sin(TAU * f * t) * Math.exp(-t * (12 + 10 * dur));
    lp += (rnd() - lp) * (0.2 + 0.7 * dur);
    const estalo = lp * Math.exp(-t * (300 - 150 * dur));
    o[i] = (corpo * (1 - 0.4 * dur) + estalo * (0.4 + 0.8 * dur)) * g;
  }
  return normalizar(o, 0.95 * Math.max(g, 1e-3));
}

/**
 * Apito do árbitro: seno com vibrato leve e sopro de ruído; ataque e soltura curtos para não estalar.
 */
export function synthWhistle(sr, semente, { duration = 0.6, pitch = 2900, gain = 0.6 } = {}) {
  const n = nQuadros(duration, sr);
  const o = new Float32Array(n);
  const rnd = makeRng(semente);
  const g = clamp01(gain);
  let fase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = pitch * (1 + 0.012 * Math.sin(TAU * 7 * t));
    fase += (TAU * f) / sr;
    const env = Math.min(1, t / 0.015) * Math.min(1, (duration - t) / 0.04);
    o[i] = (Math.sin(fase) + 0.25 * Math.sin(2 * fase) + 0.04 * rnd()) * env * g;
  }
  return normalizar(o, 0.95 * Math.max(g, 1e-3));
}

/**
 * Ruído filtrado de plateia ('crowd') ou vento ('wind') com modulação lenta (ProceduralAudio, Crowd/Wind).
 * O fim é cruzado com o começo: o loop não tem salto (a última amostra segue a primeira).
 */
export function synthAmbient(kind, sr, semente, { duration = 4, pitch = 500, gain = 0.35 } = {}) {
  const crowd = kind === 'crowd';
  if (!crowd && kind !== 'wind') throw new Error(`synthAmbient: tipo desconhecido ${kind}`);
  const n = nQuadros(duration, sr);
  const o = new Float32Array(n);
  const rnd = makeRng(semente);
  const g = clamp01(gain);
  const fase0 = ((semente >>> 0) % 1000) / 1000 * TAU;
  const taxaLfo = crowd ? 0.7 : 0.23;
  let baixo = 0, banda = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const lfo = 0.6 + 0.4 * Math.sin(TAU * taxaLfo * t + fase0);
    const fc = pitch * (crowd ? 0.8 + 0.4 * Math.sin(TAU * 3.1 * t) : 0.6 + 0.8 * lfo);
    const f = 2 * Math.sin((Math.PI * Math.min(fc, sr / 6)) / sr);
    const entrada = rnd();
    baixo += f * banda;
    const alta = entrada - baixo - (crowd ? 0.9 : 0.5) * banda;
    banda += f * alta;
    o[i] = (crowd ? banda : baixo * 0.7) * lfo * g;
  }
  // cruza o fim com o começo e corta o trecho cruzado: a amostra 0 passa a ser a que vinha depois da última
  const fade = Math.min(Math.floor(n / 4), Math.round(sr / 4));
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    o[i] = o[i] * a + o[n - fade + i] * (1 - a);
  }
  return normalizar(o.slice(0, n - fade), 0.95 * Math.max(g, 1e-3));
}

export const synthCrowd = (sr, semente, opc) => synthAmbient('crowd', sr, semente, opc);
export const synthWind = (sr, semente, opc) => synthAmbient('wind', sr, semente, opc);

/** Sementes fixas por efeito (como SfxParams.Of): o mesmo som em cada partida. */
const SEMENTE = { impact: 11, whistle: 23, crowd: 37, wind: 41 };

export class SportsAudioManager {
  /**
   * @param {{context?: AudioContext}} [o]  contexto de áudio; sem ele, cria um (se a Web Audio existir).
   */
  constructor({ context = null } = {}) {
    this.dono = !context;
    this.ctx = context || criarContexto();
    this.buffers = new Map();        // nome do clipe -> AudioBuffer
    this.cues = new Map();           // nome do som do .brsar (HOMESE_...) -> nome do clipe
    this.sintetizados = new Map();   // chave -> AudioBuffer
    this.bancos = [];
    this.bancosAusentes = [];
    this.falhas = [];
    this.laços = { crowd: null, wind: null };
    this.nivelTorcida = 0;
    this.volumes = { master: 1, sfx: 1, ambient: 0.6 };
    this._gesto = null;
    if (this.ctx) {
      this.master = this.ctx.createGain();
      this.sfxBus = this.ctx.createGain();
      this.ambBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.ambBus.connect(this.master);
      this.master.connect(this.ctx.destination);
      this._aplicarVolumes();
    }
  }

  /**
   * Decodifica os clipes de audio_index.json (caminhos relativos a assets/). Um arquivo que falha não derruba o resto:
   * vai para `falhas`. Devolve quantos clipes ficaram prontos.
   * @param {AssetStore} store
   */
  async load(store) {
    if (!this.ctx) throw new Error('SportsAudioManager.load: sem AudioContext');
    const indice = await store.json('Audio/audio_index.json');
    this.bancosAusentes = indice.missingBanks || [];
    const tarefas = [];
    for (const banco of indice.banks || []) {
      this.bancos.push(banco.name);
      for (const clip of banco.clips) {
        tarefas.push(
          this._decodificar(await store.arrayBuffer(clip.file))
            .then((buf) => { this.buffers.set(clip.name, buf); this.cues.set(clip.cue, clip.name); })
            .catch((e) => { this.falhas.push({ nome: clip.name, erro: e.message }); })
        );
      }
    }
    await Promise.all(tarefas);
    return this.buffers.size;
  }

  /**
   * Banco externo (ex.: um .brsar convertido): sounds = {nome: url | AudioBuffer}. Urls são baixadas e decodificadas.
   * @returns {Promise<number>} quantos sons entraram
   */
  async registerBank(nome, { sounds = {} } = {}) {
    if (!this.ctx) throw new Error('registerBank: sem AudioContext');
    this.bancos.push(nome);
    let n = 0;
    await Promise.all(Object.entries(sounds).map(async ([som, origem]) => {
      try {
        const buf = typeof origem === 'string'
          ? await this._decodificar(await (await fetch(origem)).arrayBuffer())
          : origem;
        this.buffers.set(som, buf);
        n++;
      } catch (e) { this.falhas.push({ nome: som, erro: e.message }); }
    }));
    return n;
  }

  /**
   * Libera o áudio no primeiro gesto (clique, toque ou tecla). Devolve Promise<boolean> com o estado 'running'.
   * Se o contexto já está rodando, resolve na hora.
   */
  unlock() {
    if (!this.ctx) return Promise.resolve(false);
    if (this.ctx.state === 'running') return Promise.resolve(true);
    if (!this._gesto) {
      this._gesto = new Promise((resolver) => {
        const doc = globalThis.document;
        const tentar = () => {
          this.ctx.resume().then(() => {
            if (this.ctx.state !== 'running') return;
            for (const [nome, f] of ouvintes) doc && doc.removeEventListener(nome, f, true);
            this._gesto = null;
            resolver(true);
          }, () => {});
        };
        const ouvintes = [['pointerdown', tentar], ['keydown', tentar], ['touchend', tentar]];
        if (!doc) { resolver(false); return; }
        for (const [nome, f] of ouvintes) doc.addEventListener(nome, f, true);
      });
    }
    return this._gesto;
  }

  /** Toca um clipe por nome ou pelo nome do som do .brsar. Devolve {stop()} ou null se não existe. */
  play(nome, { volume = 1, rate = 1 } = {}) {
    const buf = this.buffers.get(nome) || this.buffers.get(this.cues.get(nome));
    if (!buf) return null;
    return this._tocar(buf, this.sfxBus, { volume, rate, loop: false });
  }

  /** Batida com força 0..1 (volume e brilho, quantizados em 4 níveis para reaproveitar o buffer). */
  playImpact(force, kind = 'ball') {
    const p = IMPACT_KINDS[kind];
    if (!p) throw new Error(`playImpact: tipo desconhecido ${kind} (${Object.keys(IMPACT_KINDS).join(', ')})`);
    if (!this.ctx) return null;
    const q = Math.round(clamp01(force) * 3) / 3;
    const buf = this._sintetizado(`impact:${kind}:${q}`, (sr) => synthImpact(sr, SEMENTE.impact, { ...p, gain: p.gain * (0.3 + 0.7 * q) }));
    return this._tocar(buf, this.sfxBus, { volume: 1, rate: 1, loop: false });
  }

  /** Apito do árbitro (sintetizado). */
  whistle() {
    if (!this.ctx) return null;
    const buf = this._sintetizado('whistle', (sr) => synthWhistle(sr, SEMENTE.whistle));
    return this._tocar(buf, this.sfxBus, { volume: 1, rate: 1, loop: false });
  }

  /** Nível da torcida 0..1 (loop). Nível 0 deixa o laço tocando em silêncio, sem clique. */
  crowd(nivel = 0) {
    this.nivelTorcida = clamp01(nivel);
    if (!this.ctx) return;
    if (!this.laços.crowd) {
      const buf = this._sintetizado('crowd', (sr) => synthAmbient('crowd', sr, SEMENTE.crowd));
      this.laços.crowd = this._laco(buf, 0);
    }
    this.laços.crowd.ganho.gain.setTargetAtTime(this.nivelTorcida, this.ctx.currentTime, 0.2);
  }

  /** Ambiente: 'wind' (vento em loop), 'crowd' (torcida em nível médio) ou 'off' (cala o ambiente). */
  ambient(tipo) {
    if (!['wind', 'crowd', 'off'].includes(tipo)) throw new Error(`ambient: tipo desconhecido ${tipo}`);
    if (!this.ctx) return;
    if (tipo === 'wind') {
      if (!this.laços.wind) {
        const buf = this._sintetizado('wind', (sr) => synthAmbient('wind', sr, SEMENTE.wind));
        this.laços.wind = this._laco(buf, 0);
      }
      this.laços.wind.ganho.gain.setTargetAtTime(1, this.ctx.currentTime, 0.3);
    } else if (this.laços.wind) {
      this.laços.wind.ganho.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    }
    if (tipo === 'crowd') this.crowd(0.6);
    if (tipo === 'off') this.crowd(0);
  }

  /** Volumes 0..1: master (tudo), sfx (efeitos) e ambient (laços). Undefined mantém o valor atual. */
  setVolume(master, sfx, ambient) {
    if (master !== undefined) this.volumes.master = clamp01(master);
    if (sfx !== undefined) this.volumes.sfx = clamp01(sfx);
    if (ambient !== undefined) this.volumes.ambient = clamp01(ambient);
    this._aplicarVolumes();
  }

  dispose() {
    for (const l of Object.values(this.laços)) if (l) l.fonte.stop();
    this.laços = { crowd: null, wind: null };
    this._gesto = null;
    if (this.ctx && this.dono && this.ctx.close) this.ctx.close();
    this.ctx = null;
  }

  // ── internos ────────────────────────────────────────────────────

  _aplicarVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    this.sfxBus.gain.value = this.volumes.sfx;
    this.ambBus.gain.value = this.volumes.ambient;
  }

  _decodificar(arrayBuffer) {
    return this.ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  /** Buffer sintetizado no sampleRate do contexto, guardado por chave. */
  _sintetizado(chave, fazer) {
    const k = `${chave}@${this.ctx.sampleRate}`;
    let buf = this.sintetizados.get(k);
    if (!buf) {
      const dados = fazer(this.ctx.sampleRate);
      buf = this.ctx.createBuffer(1, dados.length, this.ctx.sampleRate);
      buf.copyToChannel(dados, 0);
      this.sintetizados.set(k, buf);
    }
    return buf;
  }

  _tocar(buf, barramento, { volume, rate, loop }) {
    const fonte = this.ctx.createBufferSource();
    fonte.buffer = buf;
    fonte.loop = loop;
    fonte.playbackRate.value = rate;
    const ganho = this.ctx.createGain();
    ganho.gain.value = volume;
    fonte.connect(ganho).connect(barramento);
    fonte.start();
    return { fonte, ganho, stop: () => { try { fonte.stop(); } catch (e) { /* já parou */ } } };
  }

  _laco(buf, volume) {
    const fonte = this.ctx.createBufferSource();
    fonte.buffer = buf;
    fonte.loop = true;
    const ganho = this.ctx.createGain();
    ganho.gain.value = volume;
    fonte.connect(ganho).connect(this.ambBus);
    fonte.start();
    return { fonte, ganho };
  }
}

function criarContexto() {
  const C = globalThis.AudioContext || globalThis.webkitAudioContext;
  return C ? new C() : null;
}
