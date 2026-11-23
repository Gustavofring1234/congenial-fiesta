// Boliche (RPBowScene), porte de Activities/Bowling/BowlingActivity.cs. Geometria de gameplay_data.json: linha de
// falta em z = 0, pino 1 em z ≈ -182,8 (18,29 m), pista para -Z; as 7 pistas de fundo usam a tabela do DOL lida por
// Bowling::CheckBallLaneIntersection (no referencial do Wii, sem espelhar). Controle: mover = posição; mira (aim.x) =
// ângulo; gesto "throw": força = velocidade da bola, componente lateral = efeito (gancho no último terço).
import { SportActivity } from '../common/SportActivity.js';
import { v3, clamp, clamp01, mix } from '../common/vec3.js';
import { BowlingScore, FRAMES, ALL_PINS, pinColumn } from './BowlingScore.js';
import { BowlingLane } from './BowlingPhysics.js';

const RELEASE_Z = 4;
const BALL_MODELS = ['bwg_ball_blue', 'bwg_ball_pink', 'bwg_ball_green', 'bwg_ball_yellow'];

export class BowlingActivity extends SportActivity {
  constructor(o) {
    super(o);
    const g = this.sport.geometry || {};
    this.lane = new BowlingLane(g, this.upm);
    this.npcLaneX = (g.npcLaneX || []).filter((x) => Math.abs(x) >= 1);
    this.scores = this.players.map(() => new BowlingScore());
    this.frames = clamp(this.session.options.bowlingFrames || FRAMES, 1, FRAMES);
    this.current = 0;
    this.aim = { x: 0, angle: 0, visible: false };
    this.ballModel = BALL_MODELS[0];
    this.gestureKind = 'throw';
  }

  tick(dt) {
    if (!this.lane.ball.done || this.lane.moving) {
      this.lane.update(dt);
      let loud = 0;
      for (const h of this.lane.hits) if (h.kind === 'pin' || h.kind === 'ball') loud = Math.max(loud, h.speed);
      if (loud > 20 && this.time - (this._lastHit || 0) > 0.06) {
        this._lastHit = this.time;
        this.impact(clamp01(loud / 400), 0.35, 320);
        this.fx('Bow_pin_hit', v3(0, 2, this.lane.headPinZ));
      }
    }
  }

  *run() {
    this.title('Boliche');
    this.showLayout('score_00');
    this.players.forEach((slot, i) => {
      const a = this.spawnActor(slot, v3(20 + 8 * i, 0, 18), v3(0, 0, -1), i);
      a.play('bwg_waitR', this.time);
    });
    this.cue('SE_TR_Common_Sports_Game_Start');
    yield this.banner(`Boliche - ${this.frames} quadros`, 1.5);
    for (let f = 0; f < this.frames; f++) {
      for (let p = 0; p < this.players.length; p++) {
        const sc = this.scores[p];
        this.lane.resetPins(ALL_PINS);
        while (!sc.isGameOver && sc.currentFrame === f) yield* this.playRoll(p);
        this.actors[p].pos = v3(20 + 8 * p, 0, 18);
      }
    }
    yield 0.5;
    this.cue('SE_TR_Common_Sports_Game_End');
    yield this.banner('Fim de jogo', 2);
    this.finish(this.buildResult());
  }

  *playRoll(p) {
    const slot = this.players[p], sc = this.scores[p], actor = this.actors[p];
    this.current = p;
    this.ballModel = BALL_MODELS[p % BALL_MODELS.length];
    this.updateScoreHud(p);
    let x = 0, angle = 0, speed = 0, spin = 0;
    this.hint(slot.human ? '< > posição • mira com o ponteiro/analógico • gesto de arremesso (arrastar e soltar, Espaço, câmera)' : `Vez de ${this.name(slot)}`);
    this.cameraSet(v3(0, 14, 42), v3(0, 2, this.lane.headPinZ * 0.35), 40);
    actor.pos = v3(0, 0, 14);
    actor.face(v3(0, 0, -1));
    actor.play('bwg_waitR', this.time);
    if (slot.human) {
      const g = yield* this.waitGesture('throw', p, (dt) => {
        const c = this.controlsOf(p);
        x = clamp(x + c.move.x * 9 * dt, -this.lane.laneHalf + 2, this.lane.laneHalf - 2);
        angle = clamp(c.aim.x * 4, -4, 4);
        actor.pos = v3(x, 0, 14);
        this.aim = { x: x + 1.5, angle, visible: true };
        return true;
      });
      if (!g) return;
      speed = mix(5.5, 9.8, clamp01(g.power / 1.3));
      spin = clamp(g.dirX * 1.8, -1, 1);                     // gesto para a direita = curva para a direita
      angle += clamp((90 - g.angle) * 0.03, -2, 2);           // gesto inclinado = mira para o mesmo lado
    } else {
      yield 0.6;
      ({ x, angle, speed, spin } = this.cpuThrow(p, sc.standingMask));
      actor.pos = v3(x, 0, 14);
      this.aim = { x: x + 1.5, angle, visible: true };
      yield 0.4;
    }
    this.aim.visible = false;
    this.hint('');
    actor.play('bwg_throwR', this.time);
    // passos até a linha de falta
    const start = { ...actor.pos }, end = v3(x, 0, RELEASE_Z + 2);
    for (let t = 0; t < 0.7; t += this.dt) { actor.pos = v3(mix(start.x, end.x, t / 0.7), 0, mix(start.z, end.z, t / 0.7)); yield; }
    this.sfx('whoosh', 0.5);
    this.lane.release(x + 1.5, angle, speed, spin, RELEASE_Z);
    yield* this.followRoll();
    const outcome = sc.roll(this.lane.standingMask());
    yield* this.announce(p, outcome);
    if (outcome.frameComplete || sc.isGameOver) return;
    this.lane.resetPins(sc.standingMask); // sobra para a 2ª bola (ou pinos novos no 10º quadro)
  }

  *followRoll() {
    let t = 0, settle = 0, reached = false;
    const L = this.lane;
    while (t < 9) {
      t += this.dt;
      const b = L.ball;
      if (b.z < L.headPinZ + 6) reached = true;
      const camPos = reached ? v3(0, 12, L.headPinZ + 34) : v3(b.x * 0.5, 9, b.z + 30);
      const look = reached ? v3(0, 1, L.headPinZ - 3) : v3(b.x * 0.5, 1, b.z - 30);
      this.cameraFollow(camPos, look, reached ? 2.5 : 6, 38);
      if (reached || b.done) {
        settle = L.moving ? 0 : settle + this.dt;
        if (settle > 1.2) break;
      }
      yield;
    }
    L.ball.done = true;
  }

  *announce(p, o) {
    const actor = this.actors[p];
    let msg;
    if (o.strike) { msg = 'STRIKE!'; this.fx('Bow_perfect_kira', v3(0, 3, this.lane.headPinZ)); actor.play('bwg_A0_happyR', this.time); actor.setExpression('smile'); }
    else if (o.spare) { msg = 'SPARE!'; actor.play('bwg_A0_happyR', this.time); actor.setExpression('smile'); }
    else if (o.gutter) { msg = 'Canaleta'; actor.setExpression('sad'); }
    else if (o.split) msg = `Split! ${o.pins}`;
    else msg = `${o.pins} ${o.pins === 1 ? 'pino' : 'pinos'}`;
    this.emit('roll', { player: p, pins: o.pins, strike: o.strike, spare: o.spare, split: o.split, gutter: o.gutter });
    this.updateScoreHud(p);
    if (o.strike || o.spare) this.cue('SE_TR_Common_Sports_Training_GoodLong');
    yield this.banner(msg, o.strike || o.spare ? 1.6 : 1.1);
    actor.setExpression('neutral');
    if (this.scores[p].isGameOver && this.scores[p].total === 300) {
      this.fx('Bow_perfect_hubuki', v3(0, 6, this.lane.headPinZ));
      yield this.banner('Jogo perfeito: 300!', 2.5);
    }
  }

  updateScoreHud(current) {
    const lines = this.scores.map((s, p) => {
      let row = (p === current ? '> ' : '  ') + this.name(this.players[p]) + '  ';
      for (let f = 0; f < FRAMES; f++) row += '[' + s.frameMarks(f).padEnd(f === 9 ? 3 : 2) + ']';
      return row + '  ' + s.total;
    });
    const cur = this.scores[current];
    lines.push(`Quadro ${Math.min(cur.currentFrame + 1, 10)}, bola ${cur.rollInFrame + 1}`);
    this.score(lines.join('\n'));
    this.pane('score_00', 'T_score_00', cur.total);
  }

  /** CPU: mira o bolso 1-3 (ou o centro dos pinos restantes), compensando o gancho, com erro pelo perfil. */
  cpuThrow(p, standing) {
    const ai = this.aiOf(p);
    const sp = this.lane.g.pinSpacing;
    let targetX = 0.75; // bolso 1-3 de quem joga com a direita (pino 3 à direita, +X)
    if (standing !== ALL_PINS) {
      let sum = 0, n = 0;
      for (let i = 0; i < 10; i++) if ((standing >> i) & 1) { sum += pinColumn(i) * sp * 0.5; n++; }
      if (n) targetX = sum / n;
    }
    const half = this.lane.laneHalf;
    const x = clamp(ai.sideBias * 4, -half + 2, half - 2);
    const spin = clamp(ai.sideBias * 0.25 * ai.skill, -0.3, 0.3);
    const hookShift = spin * 6.5;             // efeito > 0 leva a bola para +X no fim
    const aimX = targetX - hookShift + this.err(p, 4.5);
    const dz = RELEASE_Z - this.lane.headPinZ;
    const angle = (Math.atan2(aimX - (x + 1.5), dz) * 180) / Math.PI;
    const speed = clamp(7 + 2.2 * ai.power + this.err(p, 1), 5.5, 9.8);
    return { x, angle, speed, spin };
  }

  buildResult() {
    const r = this.newResult();
    let best = -1, bestScore = -1;
    this.scores.forEach((s, p) => {
      const total = s.total;
      this.addPlayer(r, this.players[p], total, `${total} pontos (${s.strikes} strikes, ${s.spares} spares)`);
      if (total > bestScore) { bestScore = total; best = p; } else if (total === bestScore) best = -1;
    });
    r.winner = best;
    r.humanWon = best >= 0 && !!this.players[best].human;
    r.lines.push(`Melhor: ${bestScore}`);
    if (this.frames === FRAMES) {
      const human = this.scores[0].total;
      r.records.push({ field: 'BowStandardBest', value: human, mode: 'higher' });
      if (human === 300) r.records.push({ field: 'BowPerfectCount', value: 1, mode: 'add' });
    }
    return r;
  }

  extraState() {
    return {
      l: this.lane.pack(),
      s: this.scores.map((s) => [s.total, Array.from({ length: FRAMES }, (_, f) => s.frameMarks(f)).join('|')]),
      cur: this.current,
      aim: this.aim.visible ? [Math.round(this.aim.x * 10) / 10, Math.round(this.aim.angle * 100) / 100] : 0,
      bm: this.ballModel,
    };
  }
}
