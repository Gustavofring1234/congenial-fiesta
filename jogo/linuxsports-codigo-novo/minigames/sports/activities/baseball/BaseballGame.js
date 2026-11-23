// Regras de beisebol (porte de Activities/Rules/BaseballGame.cs): contagem bola/strike, eliminações, bases,
// entradas, walk-off e entradas extras limitadas, para a partida de N entradas do RPBsbScene (o jogador rebate numa
// metade e arremessa na outra).
export const PitchResult = Object.freeze({
  Ball: 'ball', CalledStrike: 'calledStrike', SwingingStrike: 'swingingStrike', Foul: 'foul', Single: 'single',
  Double: 'double', Triple: 'triple', HomeRun: 'homeRun', Out: 'out', DoublePlay: 'doublePlay',
});

export class BaseballGame {
  constructor(innings = 3) {
    if (innings < 1) throw new RangeError('innings');
    this.innings = innings;
    this.runsByInning = [[0], []];
    this.inning = 0;          // 0-based
    this.bottom = false;      // false = alto (time 0 rebate)
    this.balls = 0;
    this.strikes = 0;
    this.outs = 0;
    this.bases = 0;           // bit 0 = 1ª, 1 = 2ª, 2 = 3ª
    this.isGameOver = false;
    this.hits = [0, 0];
    this.runs = [0, 0];
    this.consecutiveHits = 0;
    this.bestStreak = [0, 0];
    this._sacrifice = false;
    this._halfJustEnded = false;
  }

  get battingTeam() { return this.bottom ? 1 : 0; }
  get fieldingTeam() { return this.bottom ? 0 : 1; }
  get winner() { return !this.isGameOver ? -1 : this.runs[0] > this.runs[1] ? 0 : this.runs[1] > this.runs[0] ? 1 : -1; }
  linescore(team) { return this.runsByInning[team]; }
  bestConsecutiveHits(team) { return this.bestStreak[team]; }

  /** Marca a próxima eliminação como voo de sacrifício (bola alta funda). */
  markSacrificeFly() { this._sacrifice = true; }

  /** Aplica o resultado de um arremesso; devolve as corridas da jogada. */
  apply(r) {
    if (this.isGameOver) throw new Error('Partida encerrada');
    let scored = 0;
    switch (r) {
      case PitchResult.Ball: if (++this.balls >= 4) scored = this._walk(); break;
      case PitchResult.CalledStrike:
      case PitchResult.SwingingStrike: if (++this.strikes >= 3) { this.consecutiveHits = 0; this._addOut(); } break;
      case PitchResult.Foul: if (this.strikes < 2) this.strikes++; break;
      case PitchResult.Single: scored = this._hit(1); break;
      case PitchResult.Double: scored = this._hit(2); break;
      case PitchResult.Triple: scored = this._hit(3); break;
      case PitchResult.HomeRun: scored = this._hit(4); break;
      case PitchResult.Out:
        this.consecutiveHits = 0;
        // bola alta apanhada: corredor da 3ª marca em sacrifício com menos de 2 eliminações
        if (this.outs < 2 && (this.bases & 4) && this._sacrifice) { this.bases &= ~4; scored = 1; }
        this._sacrifice = false;
        this._addOut();
        break;
      case PitchResult.DoublePlay:
        this.consecutiveHits = 0;
        if ((this.bases & 1) && this.outs < 2) { this.bases &= ~1; this._addOut(); }
        if (!this._halfJustEnded) this._addOut();
        break;
      default: throw new Error('resultado desconhecido: ' + r);
    }
    if (scored > 0) this._score(scored);
    this._halfJustEnded = false;
    return scored;
  }

  _walk() {
    let scored = 0;
    if (this.bases & 1) {
      if (this.bases & 2) { if (this.bases & 4) scored = 1; this.bases |= 4; }
      this.bases |= 2;
    }
    this.bases |= 1;
    this._resetCount();
    return scored;
  }

  _hit(n) {
    let scored = 0;
    const t = this.battingTeam;
    this.hits[t]++;
    this.consecutiveHits++;
    if (this.consecutiveHits > this.bestStreak[t]) this.bestStreak[t] = this.consecutiveHits;
    const b = this.bases << n; // todos avançam o número de bases da rebatida
    for (let k = 3; k < 7; k++) if ((b >> k) & 1) scored++;
    this.bases = b & 7;
    if (n === 4) scored++; else this.bases |= 1 << (n - 1);
    this._resetCount();
    return scored;
  }

  _score(n) {
    const t = this.battingTeam;
    this.runs[t] += n;
    const list = this.runsByInning[t];
    list[list.length - 1] += n;
    if (this.bottom && this.inning >= this.innings - 1 && this.runs[1] > this.runs[0]) this.isGameOver = true; // walk-off
  }

  _addOut() {
    this._resetCount();
    if (++this.outs < 3) return;
    this.outs = 0;
    this.bases = 0;
    this.consecutiveHits = 0;
    this._halfJustEnded = true;
    if (!this.bottom) {
      if (this.inning >= this.innings - 1 && this.runs[1] > this.runs[0]) { this.isGameOver = true; return; }
      this.bottom = true;
      this.runsByInning[1].push(0);
    } else {
      if (this.inning >= this.innings - 1 && this.runs[0] !== this.runs[1]) { this.isGameOver = true; return; }
      if (this.inning >= this.innings + 2) { this.isGameOver = true; return; } // extras limitadas: empate
      this.bottom = false;
      this.inning++;
      this.runsByInning[0].push(0);
    }
  }

  _resetCount() { this.balls = 0; this.strikes = 0; }

  get countText() { return `${this.balls}-${this.strikes}, ${this.outs} ${this.outs === 1 ? 'eliminação' : 'eliminações'}`; }
  get halfText() { return `${this.bottom ? 'Baixo' : 'Alto'} da ${this.inning + 1}ª`; }
}
