// Sorteio com semente (mulberry32): a mesma semente dá a mesma partida em qualquer navegador, no Node e nos dois
// lados da sala (o anfitrião manda a semente; os convidados reproduzem a mesma IA quando precisam prever).
export class SeededRandom {
  constructor(seed = 1) { this.state = (Math.floor(seed) >>> 0) || 0x9e3779b9; }

  /** [0, 1) */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Inteiro em [0, n). */
  int(n) { return Math.floor(this.next() * n); }
  range(a, b) { return a + (b - a) * this.next(); }
  chance(p) { return this.next() < p; }
  pick(list) { return list[this.int(list.length)]; }

  /** Normal padrão (Box-Muller). */
  gaussian() {
    const u1 = 1 - this.next(), u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Estado para salvar/restaurar (pausa, ressincronização). */
  save() { return this.state; }
  restore(s) { this.state = s >>> 0; }
}
