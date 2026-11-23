// Súmula de golfe por tacadas (porte de Activities/Rules/GolfScorecard.cs), com limite de tacadas por buraco.
export class GolfScorecard {
  constructor(parPerHole, players, maxStrokesPerHole = 10) {
    if (!parPerHole || !parPerHole.length) throw new Error('sem buracos');
    this.par = parPerHole.slice();
    this.players = Math.max(1, players);
    this.maxStrokesPerHole = maxStrokesPerHole;
    this.strokes = Array.from({ length: this.players }, () => new Array(this.par.length).fill(0));
    this.holed = Array.from({ length: this.players }, () => new Array(this.par.length).fill(false));
  }

  get holes() { return this.par.length; }
  strokesOf(p, h) { return this.strokes[p][h]; }
  isHoled(p, h) { return this.holed[p][h]; }

  /** Conta uma tacada (+ penalidade). Devolve true se atingiu o limite (buraco encerrado). */
  addStroke(p, h, penalty = 0) {
    if (this.holed[p][h]) throw new Error('buraco já concluído');
    this.strokes[p][h] += 1 + penalty;
    if (this.strokes[p][h] >= this.maxStrokesPerHole) { this.strokes[p][h] = this.maxStrokesPerHole; this.holed[p][h] = true; return true; }
    return false;
  }

  hole(p, h) { this.holed[p][h] = true; }
  holeComplete(h) { for (let p = 0; p < this.players; p++) if (!this.holed[p][h]) return false; return true; }
  total(p) { return this.strokes[p].reduce((a, b) => a + b, 0); }

  /** Relação ao par só dos buracos concluídos. */
  toPar(p) { let t = 0; for (let h = 0; h < this.par.length; h++) if (this.holed[p][h]) t += this.strokes[p][h] - this.par[h]; return t; }

  leader() { let best = 0; for (let p = 1; p < this.players; p++) if (this.total(p) < this.total(best)) best = p; return best; }

  static toParText(d) { return d === 0 ? 'E' : d > 0 ? '+' + d : String(d); }

  /** Nome do resultado do buraco (glf_hole_in_one_model / nice_in...). */
  static resultName(strokes, par) {
    if (strokes === 1) return 'Hole in one!';
    const d = strokes - par;
    const names = { '-3': 'Albatroz', '-2': 'Eagle', '-1': 'Birdie', 0: 'Par', 1: 'Bogey', 2: 'Double bogey', 3: 'Triple bogey' };
    if (names[d] !== undefined) return names[d];
    return d < -3 ? 'Condor' : '+' + d;
  }
}
