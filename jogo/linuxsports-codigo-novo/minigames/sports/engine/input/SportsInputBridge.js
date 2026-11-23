// Entrada única dos minigames de esporte (substitui o Wiimote). Porte de InputRouter.cs, GestureRecognition.cs e
// da classe Entrada do WEBC (minijogos.js), com estas fontes:
//   mouse e toque  ponteiro sobre o elemento: arrasto e soltar = gesto (força e direção do arrasto); toque curto =
//                  confirm; segurar sem arrastar = carga por tempo, e soltar dispara o gesto; botão direito e dois
//                  dedos = back; a posição = aim.
//   teclado        WASD/setas = move; Espaço segurado e solto = gesto com a carga (toque curto = confirm); Enter =
//                  confirm; Esc/Backspace = back; Shift = guarda.
//   gamepad        analógico esquerdo = move, direito = aim; peteleco no direito = gesto; gatilho direito = carga e
//                  gesto ao soltar; A = confirm; B = back. Lido em poll().
//   câmera         captura.ouvir (WEBC): pose do corpo por quadro. Gestos pelo pulso em relação aos ombros, normalizado
//                  pela largura dos ombros, com suavização; a mira vem do indicador (ou do pulso direito).
//
// Ações (eventos do EventTarget, detail = {force 0..1, dir {x,y}, hand 'L'|'R', spin -1..1, source, ...}):
//   'swing' | 'throw' | 'strike'  o gesto da modalidade (gestureKind); os demais gestos são ignorados
//   'aim'      mira mudou (dir = {x,y}, -1..1, y para cima)
//   'move'     teclas de movimento mudaram (dir)
//   'confirm'  toque curto / Enter / A
//   'back'     Esc / Backspace / botão direito / dois dedos / B
// poll() devolve o estado contínuo: {aim, move, guard, charge 0..1}.
//
// Toda a lógica de detecção está em funções PURAS exportadas (swipeMeasure, curvatura, flickStep, frameFromResult,
// aimFromResult, createGestureState, stepGestures). A classe só conecta os eventos.

/** Ações de gesto aceitas como gestureKind. */
export const GESTURE_KINDS = ['swing', 'throw', 'strike'];

/** Limiares do ponteiro (unidades de altura de tela, como SwipeTracker). */
export const POINTER_CFG = {
  window: 0.1,           // s, janela da média de velocidade
  minSpeed: 0.8,         // alturas de tela/s para contar como gesto
  reference: 4,          // alturas/s = força 1
  maxSpeed: 2,           // limite do speed
  tapDistance: 0.025,    // alturas: toque curto se andou menos que isso
  tapTime: 0.3,          // s
  keyTapTime: 0.22,      // s: segurar mais que isso (sem arrastar) é carga, não confirm
  chargeTime: 1,         // s para carga 1 (teclado e mouse parado)
};

/**
 * Limiares da câmera, em unidades de largura dos ombros (sw) e segundos. Velocidades em sw/s.
 * Ruído de 1 cm a 30 quadros/s dá ~0,9 sw/s: os limiares ficam bem acima disso.
 */
export const CAMERA_CFG = {
  visible: 0.5,          // visibilidade mínima de ombros, pulsos e nariz
  smooth: 0.5,           // suavização exponencial da posição (como o "suavizar" da captura)
  window: 0.3,           // s de histórico por pulso
  minDt: 0.05,           // s mínimos entre o primeiro e o último ponto da janela
  cooldown: 0.6,         // s sem novo gesto na mesma mão
  guardRadius: 1.0,      // sw: pulso até essa distância do nariz conta como guarda
  swing: { speed: 4, ref: 12, arc: 0.9, raio: 0.3 },
  throw: { speed: 3, ref: 9, below: -1.8, travel: 0.8 },
  strike: { speed: 4, ref: 12, travel: 0.8, low: -1.8, high: 1.2 },
  leanScale: 2,          // inclinação do tronco (sw) que vale move = 1
};

/** Peteleco no analógico (StickFlickDetector): sai do repouso e chega ao disparo rapidamente. */
export const FLICK_CFG = { rest: 0.25, fire: 0.9, referenceTime: 0.08, maxTime: 0.2, maxSpeed: 2 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Relógio em segundos (performance.now quando existe). Injetável em SportsInputBridge({clock}). */
export const relogio = () => (globalThis.performance ? globalThis.performance.now() / 1000 : Date.now() / 1000);

// ── ponteiro ───────────────────────────────────────────────────────

/**
 * Maior velocidade (média na janela) entre os pontos do arrasto, como SwipeTracker.Move.
 * @param {{t:number,x:number,y:number}[]} samples  em ordem cronológica
 * @returns {{vx:number, vy:number, mag:number}}
 */
export function peakVelocity(samples, window = POINTER_CFG.window) {
  let melhor = { vx: 0, vy: 0, mag: 0 };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i];
    let j = i - 1;
    while (j > 0 && a.t - samples[j - 1].t <= window) j--;
    const b = samples[j];
    const dt = a.t - b.t;
    if (dt <= 1e-4) continue;
    const vx = (a.x - b.x) / dt, vy = (a.y - b.y) / dt;
    const mag = Math.hypot(vx, vy);
    if (mag > melhor.mag) melhor = { vx, vy, mag };
  }
  return melhor;
}

/**
 * Curvatura do arrasto: o produto vetorial entre a velocidade da primeira metade e a da segunda, normalizado.
 * +1 = curva para a esquerda (anti-horário na tela), -1 = para a direita, 0 = reta ou pontos insuficientes.
 */
export function curvatura(samples) {
  const n = samples.length;
  if (n < 4) return 0;
  const m = Math.floor(n / 2);
  const a = samples[0], b = samples[m], c = samples[n - 1];
  const dt1 = b.t - a.t, dt2 = c.t - b.t;
  if (dt1 <= 1e-4 || dt2 <= 1e-4) return 0;
  const v1x = (b.x - a.x) / dt1, v1y = (b.y - a.y) / dt1;
  const v2x = (c.x - b.x) / dt2, v2y = (c.y - b.y) / dt2;
  const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-6 || m2 < 1e-6) return 0;
  return clamp((v1x * v2y - v1y * v2x) / (m1 * m2), -1, 1);
}

/**
 * Mede um arrasto do ponteiro. tap = toque curto e parado. valid = gesto (velocidade de pico >= minSpeed).
 * force = pico/reference (0..1), speed = até maxSpeed, dir = unitário do pico.
 */
export function swipeMeasure(samples, cfg = POINTER_CFG) {
  const vazio = { tap: false, valid: false, force: 0, speed: 0, dir: { x: 0, y: 0 }, spin: 0, duration: 0 };
  if (samples.length < 2) return vazio;
  const primeiro = samples[0], ultimo = samples[samples.length - 1];
  const dur = ultimo.t - primeiro.t;
  const dist = Math.hypot(ultimo.x - primeiro.x, ultimo.y - primeiro.y);
  const tap = dist <= cfg.tapDistance && dur <= cfg.tapTime;
  const pico = peakVelocity(samples, cfg.window);
  const force = Math.min(1, pico.mag / cfg.reference);
  if (tap || pico.mag < cfg.minSpeed) return { ...vazio, tap, force: tap ? 0 : force, duration: dur };
  return {
    tap: false, valid: true, force,
    speed: Math.min(cfg.maxSpeed, pico.mag / cfg.reference),
    dir: { x: pico.vx / pico.mag, y: pico.vy / pico.mag },
    spin: curvatura(samples),
    duration: dur,
  };
}

// ── peteleco (analógico) ──────────────────────────────────────────

/** Estado do peteleco: `saida` = último instante em repouso (-1 = ainda não saiu do repouso). */
export function createFlickState() { return { armado: true, saida: -1 }; }

/**
 * Um quadro do analógico direito (x, y em -1..1, y para cima). Devolve {state, gesto} com gesto = null ou
 * {force, dir, speed, duration}. Porta StickFlickDetector.Update: sai do repouso (rest) e passa de fire em até maxTime.
 */
export function flickStep(state, x, y, t, cfg = FLICK_CFG) {
  const mag = Math.hypot(x, y);
  if (mag < cfg.rest) return { state: { armado: true, saida: t }, gesto: null };
  if (state.armado && mag >= cfg.fire && state.saida >= 0) {
    const subida = Math.max(1e-3, t - state.saida);
    if (subida > cfg.maxTime) return { state: { armado: false, saida: state.saida }, gesto: null };
    return {
      state: { armado: false, saida: state.saida },
      gesto: {
        force: Math.min(1, cfg.referenceTime / subida),
        speed: Math.min(cfg.maxSpeed, cfg.referenceTime / subida),
        dir: { x: x / mag, y: y / mag },
        duration: subida,
      },
    };
  }
  return { state, gesto: null };
}

// ── câmera: pose e mira (funções puras) ───────────────────────────

/** Ponto de pose (MediaPipe, metros) para o referencial canônico: x = esquerda da pessoa, y para cima, z para a frente. */
function canonico(m) {
  return { x: m[0], y: -m[1], z: -m[2], v: m.length > 3 ? m[3] : 1 };
}

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Quadro do WEBC ({corpo:{mundo:[33 x [x,y,z,vis]], imagem}, maos, t em ms}) -> quadro normalizado para a detecção:
 * t em segundos, ok (ombros visíveis), sw (largura dos ombros em metros), mid (centro dos ombros), wrist {L, R},
 * nose, lean. Pontos MediaPipe Pose: 0 nariz, 11/12 ombros, 15/16 pulsos (esquerdo/direito da pessoa).
 */
export function frameFromResult(result, cfg = CAMERA_CFG) {
  const t = result && typeof result.t === 'number' ? result.t / 1000 : undefined;
  const sem = { ok: false, t, sw: 0, mid: null, wrist: { L: null, R: null }, nose: null, lean: 0 };
  const mundo = result && result.corpo && result.corpo.mundo;
  if (!Array.isArray(mundo) || mundo.length < 33) return sem;
  const P = mundo.map(canonico);
  const visivel = (i) => P[i].v >= cfg.visible;
  if (!visivel(11) || !visivel(12)) return sem;
  const sw = dist3(P[11], P[12]);
  if (sw < 0.05) return sem;
  const mid = { x: (P[11].x + P[12].x) / 2, y: (P[11].y + P[12].y) / 2, z: (P[11].z + P[12].z) / 2 };
  const rel = (p) => ({ x: (p.x - mid.x) / sw, y: (p.y - mid.y) / sw, z: (p.z - mid.z) / sw });
  const frame = {
    ok: true, t, sw, mid,
    wrist: { L: visivel(15) ? rel(P[15]) : null, R: visivel(16) ? rel(P[16]) : null },
    nose: visivel(0) ? rel(P[0]) : null,
    lean: 0,
  };
  if (frame.nose) frame.lean = frame.nose.x; // nariz para a esquerda da pessoa = x positivo
  return frame;
}

/** Ponto normalizado da imagem ([x, y, ...] 0..1) -> mira da tela (espelhada: a mão direita vai para a direita). */
function miraDaImagem(p) {
  return { x: clamp(1 - 2 * p[0], -1, 1), y: clamp(1 - 2 * p[1], -1, 1) };
}

/**
 * Mira pela câmera: indicador (ponta, landmark 8) da mão direita; sem a mão, o pulso direito da imagem (16).
 * null se nada está visível.
 */
export function aimFromResult(result) {
  const maos = (result && result.maos) || [];
  const direita = maos.find((m) => m.lado === 'Right') || null;
  if (direita && direita.imagem && direita.imagem[8]) return miraDaImagem(direita.imagem[8]);
  const c = result && result.corpo;
  if (c && c.imagem && c.imagem[16] && (c.imagem[16][2] ?? 1) >= CAMERA_CFG.visible) return miraDaImagem(c.imagem[16]);
  return null;
}

// ── câmera: detecção de gestos (estado simples + passo puro) ───────

function novaMao() { return { hist: [], ema: null, esfriaAte: -Infinity }; }

/** Estado inicial da detecção (uma mão por lado, mais o estado da guarda). */
export function createGestureState() {
  return { mao: { L: novaMao(), R: novaMao() }, guarda: false };
}

/** Diferença angular em (-π, π]. */
function difAngulo(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Um quadro normalizado (frameFromResult) para o detector. Devolve a lista de eventos do quadro:
 *   {kind:'swing'|'throw'|'strike', hand:'L'|'R', force, dir, speed, spin, t}  (só o kind pedido em `kind`)
 *   {kind:'guard', on: boolean, t}   (sempre; a guarda não depende do gesto da modalidade)
 * Um gesto dispara uma vez; a mão fica em espera (cooldown) e o histórico é zerado.
 */
export function stepGestures(state, frame, kind = 'swing', cfg = CAMERA_CFG) {
  const eventos = [];
  if (!frame || !frame.ok) {
    state.mao.L.hist = []; state.mao.R.hist = [];
    state.mao.L.ema = null; state.mao.R.ema = null;
    if (state.guarda) { state.guarda = false; eventos.push({ kind: 'guard', on: false, t: frame ? frame.t : undefined }); }
    return eventos;
  }
  const t = frame.t;
  for (const lado of ['L', 'R']) {
    const m = state.mao[lado];
    const p = frame.wrist[lado];
    if (!p) { m.hist = []; m.ema = null; continue; }
    m.ema = m.ema ? {
      x: m.ema.x + (p.x - m.ema.x) * cfg.smooth,
      y: m.ema.y + (p.y - m.ema.y) * cfg.smooth,
      z: m.ema.z + (p.z - m.ema.z) * cfg.smooth,
    } : { ...p };
    m.hist.push({ t, x: m.ema.x, y: m.ema.y, z: m.ema.z });
    while (m.hist.length && t - m.hist[0].t > cfg.window) m.hist.shift();
    if (t < m.esfriaAte || m.hist.length < 3) continue;
    const a = m.hist[0], b = m.hist[m.hist.length - 1];
    const dt = b.t - a.t;
    if (dt < cfg.minDt) continue;
    const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt, vz = (b.z - a.z) / dt;
    const planar = Math.hypot(vx, vy);
    const dir = planar > 1e-6 ? { x: vx / planar, y: vy / planar } : { x: 0, y: 1 };
    let gesto = null;

    if (kind === 'swing') {
      // arco: a mão anda em volta do ombro (no plano da tela) com velocidade e curva suficientes
      let arco = 0;
      for (let i = 1; i < m.hist.length; i++) {
        const u = m.hist[i - 1], v = m.hist[i];
        if (Math.hypot(u.x, u.y) < cfg.swing.raio || Math.hypot(v.x, v.y) < cfg.swing.raio) continue;
        arco += Math.abs(difAngulo(Math.atan2(v.y, v.x), Math.atan2(u.y, u.x)));
      }
      if (planar >= cfg.swing.speed && arco >= cfg.swing.arc) {
        gesto = { kind, force: Math.min(1, planar / cfg.swing.ref), dir, speed: planar, spin: curvaturaPlanar(m.hist) };
      }
    } else if (kind === 'throw') {
      // de trás para frente, com a mão abaixo do ombro (boliche)
      if (vz >= cfg.throw.speed && b.z - a.z >= cfg.throw.travel && b.y <= cfg.throw.below) {
        gesto = { kind, force: Math.min(1, vz / cfg.throw.ref), dir, speed: vz, spin: 0 };
      }
    } else if (kind === 'strike') {
      // extensão rápida do braço para a frente, na altura do peito (boxe)
      if (vz >= cfg.strike.speed && b.z - a.z >= cfg.strike.travel && b.y > cfg.strike.low && b.y < cfg.strike.high) {
        gesto = { kind, force: Math.min(1, vz / cfg.strike.ref), dir, speed: vz, spin: 0 };
      }
    }
    if (gesto) {
      eventos.push({ ...gesto, hand: lado, t });
      m.esfriaAte = t + cfg.cooldown;
      m.hist = [];
      m.ema = null;
    }
  }

  // guarda: os dois pulsos perto do nariz
  const nariz = frame.nose;
  const guarda = !!(nariz && frame.wrist.L && frame.wrist.R
    && dist3(frame.wrist.L, nariz) <= cfg.guardRadius && dist3(frame.wrist.R, nariz) <= cfg.guardRadius);
  if (guarda !== state.guarda) { state.guarda = guarda; eventos.push({ kind: 'guard', on: guarda, t }); }
  return eventos;
}

/** Curvatura do arco do pulso no plano da tela (mesma regra de curvatura(), sobre o histórico suavizado). */
function curvaturaPlanar(hist) {
  return curvatura(hist.map((h) => ({ t: h.t, x: h.x, y: h.y })));
}

/** Movimento pela inclinação do tronco: nariz para um lado da linha dos ombros. */
export function leanMove(frame, cfg = CAMERA_CFG) {
  if (!frame || !frame.ok || !frame.nose) return null;
  return { x: clamp(-frame.lean * cfg.leanScale, -1, 1), y: 0 };
}

// ── teclado ───────────────────────────────────────────────────────

/** Vetor de movimento pelas teclas: x = D/→ − A/←, y = W/↑ − S/↓ (y para cima). */
export function keyMove(teclas) {
  const x = (teclas.has('KeyD') || teclas.has('ArrowRight') ? 1 : 0) - (teclas.has('KeyA') || teclas.has('ArrowLeft') ? 1 : 0);
  const y = (teclas.has('KeyW') || teclas.has('ArrowUp') ? 1 : 0) - (teclas.has('KeyS') || teclas.has('ArrowDown') ? 1 : 0);
  return { x, y };
}

/** Deadzone de analógico. */
const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v);

export class SportsInputBridge extends EventTarget {
  /**
   * @param {HTMLElement} element  onde o ponteiro é lido (ganha touch-action: none)
   * @param {{captura?: {ouvir: Function}, gestureKind?: 'swing'|'throw'|'strike', clock?: () => number,
   *          keyboard?: boolean, gamepad?: boolean}} [o]
   */
  constructor(element, { captura = null, gestureKind = 'swing', clock = relogio, keyboard = true, gamepad = true } = {}) {
    super();
    if (!GESTURE_KINDS.includes(gestureKind)) throw new Error(`gestureKind desconhecido: ${gestureKind}`);
    this.element = element;
    this.captura = captura;
    this.gestureKind = gestureKind;
    this.clock = clock;
    this.usaTeclado = !!keyboard;
    this.usaGamepad = !!gamepad;
    this.ponteiros = new Map();      // id -> {tipo, amostras, t0, andou}
    this.dedosJuntos = false;        // dois dedos viraram back: ignora o resto até soltar tudo
    this.miraPonteiro = null;
    this.miraPonteiroEm = -Infinity;
    this.teclas = new Set();
    this.espacoDesde = null;
    this.guardaCamera = false;
    this.miraCamera = null;
    this.miraCameraEm = -Infinity;
    this.moveCamera = null;
    this.estadoCamera = createGestureState();
    this.pad = { botoes: {}, gatilhoDesde: null, gatilhoPico: 0, flick: createFlickState() };
    this._remover = [];
    this._ligar();
  }

  /** Assina uma ação; devolve a função que cancela. f(detail, evento). */
  on(acao, f) {
    const h = (e) => f(e.detail, e);
    this.addEventListener(acao, h);
    return () => this.removeEventListener(acao, h);
  }

  emit(acao, detail) {
    this.dispatchEvent(new CustomEvent(acao, { detail }));
  }

  /** Estado contínuo para o jogo, lido a cada quadro. */
  poll() {
    const agora = this.clock();
    const pad = this.usaGamepad ? this._lerGamepad(agora) : { mira: null, move: null, carga: 0 };
    const teclado = this.usaTeclado ? keyMove(this.teclas) : { x: 0, y: 0 };
    const tecladoAtivo = teclado.x !== 0 || teclado.y !== 0;
    let aim = { x: 0, y: 0 };
    if (this.miraCamera && agora - this.miraCameraEm < 0.5) aim = { ...this.miraCamera };
    else if (this.miraPonteiro && agora - this.miraPonteiroEm < 2) aim = { ...this.miraPonteiro };
    else if (pad.mira) aim = pad.mira;
    else if (tecladoAtivo) aim = teclado;
    const move = tecladoAtivo ? teclado : (pad.move || this.moveCamera || { x: 0, y: 0 });
    const guard = this.guardaCamera || this.teclas.has('ShiftLeft') || this.teclas.has('ShiftRight');
    let charge = pad.carga;
    if (this.espacoDesde !== null) charge = Math.max(charge, clamp((agora - this.espacoDesde) / POINTER_CFG.chargeTime, 0, 1));
    for (const p of this.ponteiros.values()) {
      const tempo = clamp((agora - p.t0) / POINTER_CFG.chargeTime, 0, 1);
      const arrasto = p.andou ? swipeMeasure(p.amostras).force : 0;
      charge = Math.max(charge, tempo, arrasto);
    }
    return { aim, move, guard, charge };
  }

  dispose() {
    for (const r of this._remover) r();
    this._remover = [];
    this.ponteiros.clear();
    this.teclas.clear();
  }

  // ── ligação ─────────────────────────────────────────────────────

  _ligar() {
    const el = this.element;
    const ouve = (alvo, nome, f, opc) => {
      if (!alvo || !alvo.addEventListener) return;
      alvo.addEventListener(nome, f, opc);
      this._remover.push(() => alvo.removeEventListener(nome, f, opc));
    };
    if (el) {
      if (el.style) el.style.touchAction = 'none';
      ouve(el, 'pointerdown', (e) => this._ponteiroBaixo(e));
      ouve(el, 'pointermove', (e) => this._ponteiroMovido(e));
      ouve(el, 'pointerup', (e) => this._ponteiroSolto(e));
      ouve(el, 'pointercancel', (e) => this._ponteiroSolto(e));
      ouve(el, 'contextmenu', (e) => e.preventDefault());
    }
    const janela = globalThis.window && globalThis.window.addEventListener ? globalThis.window : null;
    if (janela && this.usaTeclado) {
      ouve(janela, 'keydown', (e) => this._teclaBaixa(e));
      ouve(janela, 'keyup', (e) => this._teclaSolta(e));
      ouve(janela, 'blur', () => this._perdeuFoco());
    }
    if (this.captura && typeof this.captura.ouvir === 'function') {
      const parar = this.captura.ouvir((r) => this._quadroCamera(r));
      if (typeof parar === 'function') this._remover.push(parar);
    }
  }

  _posicao(e) {
    const r = this.element.getBoundingClientRect();
    const h = r.height || 1;
    return {
      mira: {
        x: clamp(((e.clientX - r.left) / (r.width || 1)) * 2 - 1, -1, 1),
        y: clamp(1 - ((e.clientY - r.top) / h) * 2, -1, 1),
      },
      // alturas de tela, como o SwipeTracker (y para cima)
      p: { x: (e.clientX - r.left) / h, y: -((e.clientY - r.top) / h) },
    };
  }

  _definirMira(mira, origem) {
    this.miraPonteiro = mira;
    this.miraPonteiroEm = this.clock();
    this.emit('aim', { dir: { ...mira }, force: 0, source: origem });
  }

  _ponteiroBaixo(e) {
    const origem = e.pointerType === 'touch' ? 'touch' : 'mouse';
    if (origem === 'mouse' && e.button === 2) { this.emit('back', { source: 'mouse' }); return; }
    if (origem === 'mouse' && e.button !== 0) return;
    const pos = this._posicao(e);
    if (origem === 'touch' && this.ponteiros.size >= 1) {
      // segundo dedo: back, e nada mais até todos os dedos soltarem
      this.ponteiros.clear();
      this.dedosJuntos = true;
      this.emit('back', { source: 'touch' });
      return;
    }
    if (this.dedosJuntos) return;
    this._definirMira(pos.mira, origem);
    const agora = this.clock();
    this.ponteiros.set(e.pointerId, { tipo: origem, amostras: [{ t: agora, x: pos.p.x, y: pos.p.y }], t0: agora, andou: false });
    try { if (this.element.setPointerCapture) this.element.setPointerCapture(e.pointerId); } catch (x) { /* sem captura */ }
  }

  _ponteiroMovido(e) {
    const origem = e.pointerType === 'touch' ? 'touch' : 'mouse';
    if (origem === 'touch' && !this.ponteiros.has(e.pointerId)) return;
    const pos = this._posicao(e);
    this._definirMira(pos.mira, origem);
    const p = this.ponteiros.get(e.pointerId);
    if (!p) return;
    p.amostras.push({ t: this.clock(), x: pos.p.x, y: pos.p.y });
    if (p.amostras.length > 64) p.amostras.shift();
    const ini = p.amostras[0];
    if (Math.hypot(pos.p.x - ini.x, pos.p.y - ini.y) > POINTER_CFG.tapDistance) p.andou = true;
  }

  _ponteiroSolto(e) {
    const p = this.ponteiros.get(e.pointerId);
    if (!p) { if (this.ponteiros.size === 0) this.dedosJuntos = false; return; }
    this.ponteiros.delete(e.pointerId);
    if (this.ponteiros.size > 0) return; // ainda há um dedo na tela: o gesto espera o último
    const agora = this.clock();
    const medida = swipeMeasure(p.amostras);
    const segurado = agora - p.t0;
    const origem = p.tipo;
    if (medida.valid) {
      this.emit(this.gestureKind, { force: medida.force, speed: medida.speed, dir: medida.dir, hand: 'R', spin: medida.spin, source: origem });
    } else if (segurado >= POINTER_CFG.keyTapTime) {
      // segurou sem arrastar: a carga pelo tempo vira o gesto ao soltar
      this.emit(this.gestureKind, { force: clamp(segurado / POINTER_CFG.chargeTime, 0, 1), speed: 0, dir: { x: 0, y: 1 }, hand: 'R', spin: 0, source: origem });
    } else {
      this.emit('confirm', { source: origem });
    }
  }

  _teclaBaixa(e) {
    const k = e.code;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'Space') {
      e.preventDefault && e.preventDefault();
      if (e.repeat || this.espacoDesde !== null) return;
      this.espacoDesde = this.clock();
      return;
    }
    if (e.repeat) return;
    if (k === 'Enter') { this.emit('confirm', { source: 'keyboard' }); return; }
    if (k === 'Escape' || k === 'Backspace') { this.emit('back', { source: 'keyboard' }); return; }
    if (/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(k)) {
      this.teclas.add(k);
      this.emit('move', { dir: keyMove(this.teclas), force: 0, source: 'keyboard' });
    } else if (k === 'ShiftLeft' || k === 'ShiftRight') {
      this.teclas.add(k);
    }
  }

  _teclaSolta(e) {
    const k = e.code;
    if (k === 'Space') {
      if (this.espacoDesde === null) return;
      const segurado = this.clock() - this.espacoDesde;
      this.espacoDesde = null;
      if (segurado < POINTER_CFG.keyTapTime) this.emit('confirm', { source: 'keyboard' });
      else this.emit(this.gestureKind, { force: clamp(segurado / POINTER_CFG.chargeTime, 0, 1), speed: 0, dir: { x: 0, y: 1 }, hand: 'R', spin: 0, source: 'keyboard' });
      return;
    }
    if (/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(k)) {
      this.teclas.delete(k);
      this.emit('move', { dir: keyMove(this.teclas), force: 0, source: 'keyboard' });
    } else if (k === 'ShiftLeft' || k === 'ShiftRight') this.teclas.delete(k);
  }

  _perdeuFoco() {
    this.teclas.clear();
    this.espacoDesde = null;
    this.ponteiros.clear();
    this.dedosJuntos = false;
  }

  /** Um quadro da câmera (captura.ouvir). Gestos da modalidade viram ações; mira e guarda viram estado. */
  _quadroCamera(r) {
    const frame = frameFromResult(r);
    if (frame.t === undefined) frame.t = this.clock();
    const mira = aimFromResult(r);
    if (mira) { this.miraCamera = mira; this.miraCameraEm = frame.t; }
    const lean = leanMove(frame);
    this.moveCamera = lean;
    for (const ev of stepGestures(this.estadoCamera, frame, this.gestureKind)) {
      if (ev.kind === 'guard') { this.guardaCamera = ev.on; continue; }
      this.emit(this.gestureKind, { force: ev.force, speed: ev.speed, dir: ev.dir, hand: ev.hand, spin: ev.spin, source: 'camera' });
    }
  }

  /** Gamepad: lido em poll(). Devolve mira, movimento e carga do gatilho. */
  _lerGamepad(agora) {
    const nav = globalThis.navigator;
    const lista = nav && nav.getGamepads ? nav.getGamepads() : null;
    const pad = lista ? Array.from(lista).find((p) => p && p.connected) : null;
    if (!pad) { this.pad.botoes = {}; this.pad.gatilhoDesde = null; return { mira: null, move: null, carga: 0 }; }
    const eixo = (i) => dz(pad.axes[i] || 0);
    const move = { x: eixo(0), y: -eixo(1) };
    const mira = { x: eixo(2), y: -eixo(3) };
    const botao = (i) => { const b = pad.buttons[i]; return b ? { pressed: !!b.pressed, value: b.value || 0 } : { pressed: false, value: 0 }; };
    const antes = this.pad.botoes;
    const A = botao(0), B = botao(1), RT = botao(7);
    if (A.pressed && !antes[0]) this.emit('confirm', { source: 'gamepad' });
    if (B.pressed && !antes[1]) this.emit('back', { source: 'gamepad' });
    antes[0] = A.pressed; antes[1] = B.pressed;

    // gatilho direito: carga enquanto segura; soltar dispara o gesto com o pico
    if (RT.value > 0.15 && this.pad.gatilhoDesde === null) { this.pad.gatilhoDesde = agora; this.pad.gatilhoPico = 0; }
    if (this.pad.gatilhoDesde !== null) {
      this.pad.gatilhoPico = Math.max(this.pad.gatilhoPico, RT.value);
      if (RT.value < 0.1) {
        this.emit(this.gestureKind, { force: clamp(this.pad.gatilhoPico, 0, 1), speed: 0, dir: { x: 0, y: 1 }, hand: 'R', spin: 0, source: 'gamepad' });
        this.pad.gatilhoDesde = null;
        this.pad.gatilhoPico = 0;
      }
    }
    // peteleco no analógico direito
    const r = flickStep(this.pad.flick, mira.x, mira.y, agora);
    this.pad.flick = r.state;
    if (r.gesto) this.emit(this.gestureKind, { force: r.gesto.force, speed: r.gesto.speed, dir: r.gesto.dir, hand: 'R', spin: 0, source: 'gamepad' });
    const temMira = Math.hypot(mira.x, mira.y) > 0;
    const temMove = Math.hypot(move.x, move.y) > 0;
    return {
      mira: temMira ? mira : null,
      move: temMove ? move : null,
      carga: this.pad.gatilhoDesde !== null ? clamp(this.pad.gatilhoPico, 0, 1) : 0,
    };
  }
}
