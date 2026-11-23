// Regras da luta de boxe (porte de Activities/Rules/BoxingBout.cs): rounds com relógio, barra de vida com parte
// recuperável, quedas com contagem até 10, K.O., nocaute técnico com 3 quedas no round e decisão por pontos.
// A sorte da contagem vem de um SeededRandom: reproduzível em teste e igual nos dois lados da sala.
import { SeededRandom } from '../common/rng.js';

export const MAX_HEALTH = 100;
export const BoutEnd = Object.freeze({ None: 'none', KO: 'ko', TKO: 'tko', Decision: 'decision', Draw: 'draw' });

export class BoxingBout {
  constructor(rounds = 3, roundSeconds = 60, seed = 1) {
    this.rounds = Math.max(1, rounds);
    this.roundSeconds = Math.max(5, roundSeconds);
    this.rng = seed instanceof SeededRandom ? seed : new SeededRandom(seed);
    this.health = [MAX_HEALTH, MAX_HEALTH];
    this.recoverable = [MAX_HEALTH, MAX_HEALTH];
    this.knockdownsRound = [0, 0];
    this.knockdowns = [0, 0];
    this.damageDealt = [0, 0];
    this.landed = [0, 0];
    this.thrown = [0, 0];
    this.round = 1;
    this.roundTime = 0;
    this.end = BoutEnd.None;
    this.winner = -1;
    this.downFighter = -1;
  }

  get isOver() { return this.end !== BoutEnd.None; }
  get timeLeft() { return Math.max(0, this.roundSeconds - this.roundTime); }

  throwPunch(a) { this.thrown[a]++; }

  /** Golpe conectado. true se derrubou o adversário. */
  land(attacker, damage) {
    if (this.isOver || this.downFighter >= 0) return false;
    const d = 1 - attacker;
    damage = Math.max(0, damage);
    this.landed[attacker]++;
    this.damageDealt[attacker] += damage;
    this.health[d] = Math.max(0, this.health[d] - damage);
    // parte do dano é recuperável (barra vermelha do boxGauge): volta devagar se não apanhar
    this.recoverable[d] = Math.max(this.health[d], this.recoverable[d] - damage * 0.4);
    if (this.health[d] <= 0) {
      this.downFighter = d;
      this.knockdownsRound[d]++;
      this.knockdowns[d]++;
      if (this.knockdownsRound[d] >= 3) this._finish(BoutEnd.TKO, attacker);
      return true;
    }
    return false;
  }

  /** Contagem da queda: em que número o lutador levanta (11 = não levanta, K.O.). */
  resolveCount() {
    if (this.downFighter < 0) return 0;
    const f = this.downFighter;
    if (this.isOver) return 11; // nocaute técnico já decidido
    const stamina = this.recoverable[f] / MAX_HEALTH;
    const getUp = Math.max(0.05, 0.95 - 0.28 * (this.knockdowns[f] - 1) - 0.25 * (1 - stamina));
    let count = 11;
    if (this.rng.next() < getUp) count = 3 + Math.floor(this.rng.next() * 6) + (this.knockdowns[f] - 1);
    if (count >= 10) count = 11;
    if (count === 11) { this._finish(BoutEnd.KO, 1 - f); return count; }
    this.health[f] = Math.max(15, this.recoverable[f] * 0.6);   // levanta com parte do recuperável
    this.recoverable[f] = this.health[f];
    this.downFighter = -1;
    return count;
  }

  /** Avança o relógio (só corre com os dois em pé). true quando o round termina. */
  tick(dt) {
    if (this.isOver || this.downFighter >= 0) return false;
    this.roundTime += dt;
    for (let f = 0; f < 2; f++) if (this.health[f] < this.recoverable[f]) this.health[f] = Math.min(this.recoverable[f], this.health[f] + dt * 2.5);
    if (this.roundTime < this.roundSeconds) return false;
    this.endRound();
    return true;
  }

  endRound() {
    if (this.isOver) return;
    if (this.round >= this.rounds) { this._decide(); return; }
    this.round++;
    this.roundTime = 0;
    this.knockdownsRound = [0, 0];
    for (let f = 0; f < 2; f++) {   // intervalo: recupera parte
      this.health[f] = Math.min(MAX_HEALTH, this.health[f] + (MAX_HEALTH - this.health[f]) * 0.35);
      this.recoverable[f] = Math.max(this.recoverable[f], this.health[f]);
    }
  }

  _decide() {
    // pontos: dano causado, -10 por queda sofrida, +5 por queda causada
    const a = this.damageDealt[0] - 10 * this.knockdowns[0] + 5 * this.knockdowns[1];
    const b = this.damageDealt[1] - 10 * this.knockdowns[1] + 5 * this.knockdowns[0];
    if (Math.abs(a - b) < 1) this._finish(BoutEnd.Draw, -1);
    else this._finish(BoutEnd.Decision, a > b ? 0 : 1);
  }

  _finish(e, w) { this.end = e; this.winner = w; }
}
