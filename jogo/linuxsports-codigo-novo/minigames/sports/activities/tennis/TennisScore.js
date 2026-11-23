// Contagem de tênis (porte de Activities/Rules/TennisScore.cs): 0/15/30/40, iguais, vantagem; games; troca de saque
// a cada game; partida de N games com 2 de vantagem (decisão no game N+1), como no RPTnsScene (1, 3 ou 5 games).
export const TennisEvent = Object.freeze({ Point: 'point', Deuce: 'deuce', Advantage: 'advantage', Game: 'game', MatchOver: 'matchOver' });

export class TennisScore {
  constructor(gamesToWin = 3, teamSize = 1, firstServer = 0) {
    if (gamesToWin < 1) throw new RangeError('gamesToWin');
    this.gamesToWin = gamesToWin;
    this.teamSize = Math.max(1, teamSize);
    this.points = [0, 0];
    this.games = [0, 0];
    this.servingTeam = firstServer;
    this.serverIndex = 0;
    this.winner = -1;
    this.pointsPlayed = 0;
    this.faultCount = 0;
    this.serverRotation = [0, 0];
  }

  get isMatchOver() { return this.winner >= 0; }
  /** Lado do saque: 0 = direita (deuce), 1 = esquerda (vantagem). */
  get serveSide() { return (this.points[0] + this.points[1]) % 2; }

  /** Falta de saque. true = dupla falta (ponto do recebedor). */
  fault() {
    if (this.isMatchOver) return false;
    if (this.faultCount === 0) { this.faultCount = 1; return false; }
    this.pointTo(1 - this.servingTeam);
    return true;
  }

  pointTo(team) {
    if (this.isMatchOver) return TennisEvent.MatchOver;
    this.pointsPlayed++;
    this.faultCount = 0;
    this.points[team]++;
    const o = 1 - team, P = this.points;
    if (P[team] >= 4 && P[team] - P[o] >= 2) return this._winGame(team);
    if (P[team] >= 3 && P[o] >= 3) {
      if (P[team] === P[o]) { P[0] = P[1] = 3; return TennisEvent.Deuce; }
      return TennisEvent.Advantage;
    }
    return TennisEvent.Point;
  }

  _winGame(team) {
    this.games[team]++;
    this.points[0] = this.points[1] = 0;
    const o = 1 - team, G = this.games, N = this.gamesToWin;
    const won = G[team] >= N && (G[team] - G[o] >= 2 || G[team] > N || N === 1);
    // rotação do saque: troca o time; em duplas cada time alterna os seus jogadores
    this.serverRotation[this.servingTeam] = (this.serverRotation[this.servingTeam] + 1) % this.teamSize;
    this.servingTeam = 1 - this.servingTeam;
    this.serverIndex = this.serverRotation[this.servingTeam];
    if (won) { this.winner = team; return TennisEvent.MatchOver; }
    return TennisEvent.Game;
  }

  static call(p) { return ['0', '15', '30', '40'][Math.min(p, 3)]; }

  pointText(team = 0) {
    const a = this.points[team], b = this.points[1 - team];
    if (a >= 3 && b >= 3) return a === b ? 'Iguais' : a > b ? 'Vantagem' : 'Vantagem adv.';
    return `${TennisScore.call(a)}-${TennisScore.call(b)}`;
  }

  isGamePoint(team) { const o = 1 - team; return this.points[team] >= 3 && this.points[team] > this.points[o]; }

  isMatchPoint(team) {
    if (!this.isGamePoint(team)) return false;
    const g = this.games[team] + 1, o = this.games[1 - team], N = this.gamesToWin;
    return g >= N && (g - o >= 2 || g > N || N === 1);
  }
}
