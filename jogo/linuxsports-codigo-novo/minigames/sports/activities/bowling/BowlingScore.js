// Placar de boliche de 10 quadros (porte de Activities/Rules/BowlingScore.cs). Regras oficiais, as mesmas do
// RPBowScene: strike = 10 + 2 próximas bolas, spare = 10 + 1 próxima, 10º quadro com bolas extras. Pinos em máscara
// de bits: bit i = pino i+1 em pé.
export const FRAMES = 10;
export const ALL_PINS = 0x3ff;

export const popCount = (m) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };

// Triângulo dos pinos: coluna em meias distâncias (negativa = esquerda de quem joga) e fileira (1 na frente).
const COL = [0, -1, 1, -2, 0, 2, -3, -1, 1, 3];
const ROW = [0, 1, 1, 2, 2, 2, 3, 3, 3, 3];
export const pinColumn = (i) => COL[i];
export const pinRow = (i) => ROW[i];

/** Split: pino 1 caído e dois ou mais grupos de pinos sem pino entre eles (regra da USBC). */
export function isSplit(standing) {
  if ((standing & 1) || popCount(standing) < 2) return false;
  let seen = 0, groups = 0;
  for (let i = 0; i < 10; i++) {
    if (!((standing >> i) & 1) || ((seen >> i) & 1)) continue;
    groups++;
    const stack = [i];
    seen |= 1 << i;
    while (stack.length) {
      const a = stack.pop();
      for (let b = 0; b < 10; b++) {
        if (!((standing >> b) & 1) || ((seen >> b) & 1)) continue;
        const dr = Math.abs(ROW[a] - ROW[b]), dc = Math.abs(COL[a] - COL[b]);
        // vizinhos: mesma fileira a 2 meias distâncias, fileiras vizinhas a 1, ou exatamente atrás (sem vão)
        if ((dr === 0 && dc === 2) || (dr === 1 && dc === 1) || (dr === 2 && dc === 0)) { seen |= 1 << b; stack.push(b); }
      }
    }
  }
  return groups >= 2;
}

export class BowlingScore {
  constructor() {
    this.rolls = [];
    this.frameStart = [0];
    this.currentFrame = 0;
    this.rollInFrame = 0;
    this.standingMask = ALL_PINS;
    this.strikes = 0;
    this.spares = 0;
  }

  get isGameOver() { return this.currentFrame >= FRAMES; }

  /** Registra a bola pela máscara dos pinos que continuam em pé. Devolve {pins, frame, roll, strike, spare, split, gutter, frameComplete}. */
  roll(standingAfter) {
    if (this.isGameOver) throw new Error('Partida encerrada');
    standingAfter &= this.standingMask; // pino derrubado não volta
    const knocked = popCount(this.standingMask) - popCount(standingAfter);
    const fullRack = this.standingMask === ALL_PINS;
    this.rolls.push(knocked);
    const o = { pins: knocked, frame: this.currentFrame, roll: this.rollInFrame, strike: false, spare: false, split: fullRack && isSplit(standingAfter), gutter: knocked === 0, frameComplete: false };
    if (standingAfter === 0 && fullRack) { o.strike = true; this.strikes++; } else if (standingAfter === 0) { o.spare = true; this.spares++; }
    if (this.currentFrame < FRAMES - 1) {
      if (standingAfter === 0 || this.rollInFrame === 1) this._next();
      else { this.rollInFrame = 1; this.standingMask = standingAfter; }
    } else if (this.rollInFrame === 0) {
      this.rollInFrame = 1;
      this.standingMask = standingAfter === 0 ? ALL_PINS : standingAfter;
    } else if (this.rollInFrame === 1) {
      const first = this.rolls[this.rolls.length - 2];
      if (first === 10 || first + knocked === 10) { this.rollInFrame = 2; this.standingMask = standingAfter === 0 ? ALL_PINS : standingAfter; } else this._next();
    } else this._next();
    o.frameComplete = o.frame !== this.currentFrame;
    return o;
  }

  _next() {
    this.currentFrame++;
    this.rollInFrame = 0;
    this.standingMask = ALL_PINS;
    if (this.currentFrame < FRAMES) this.frameStart.push(this.rolls.length);
  }

  /** Pontos do quadro f (null se ainda pendente). */
  frameScore(f) {
    const R = this.rolls;
    if (f >= this.frameStart.length) return null;
    const r = this.frameStart[f];
    if (r >= R.length) return null;
    if (f === FRAMES - 1) {
      const n = R.length - r;
      if (n < 2) return null;
      const a = R[r], b = R[r + 1];
      if (a === 10 || a + b === 10) return n >= 3 ? a + b + R[r + 2] : null;
      return a + b;
    }
    if (R[r] === 10) return r + 2 < R.length ? 10 + R[r + 1] + R[r + 2] : null;
    if (r + 1 >= R.length) return null;
    if (R[r] + R[r + 1] === 10) return r + 2 < R.length ? 10 + R[r + 2] : null;
    return R[r] + R[r + 1];
  }

  cumulativeScore(f) {
    let t = 0;
    for (let i = 0; i <= f; i++) { const s = this.frameScore(i); if (s === null) return null; t += s; }
    return t;
  }

  /** Total dos quadros já fechados. */
  get total() {
    let t = 0;
    for (let f = 0; f < FRAMES; f++) { const s = this.frameScore(f); if (s === null) break; t += s; }
    return t;
  }

  /** Símbolos de um quadro ("X", "/", "-", dígitos). */
  frameMarks(f) {
    if (f >= this.frameStart.length) return '';
    const r = this.frameStart[f];
    const end = f + 1 < this.frameStart.length ? this.frameStart[f + 1] : this.rolls.length;
    let s = '', standing = 10;
    for (let i = r; i < end; i++) {
      const k = this.rolls[i];
      if (k === 10 && standing === 10) { s += 'X'; continue; }
      if (k === standing && standing < 10) { s += '/'; standing = 10; continue; }
      s += k === 0 ? '-' : String(k);
      standing -= k;
      if (f < FRAMES - 1 && i === r + 1) break;
    }
    return s;
  }

  /** Estado compacto (sala): bolas jogadas; o resto se reconstrói. */
  pack() { return this.rolls.slice(); }
}
