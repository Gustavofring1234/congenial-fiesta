// Tênis (RPTnsScene), porte de Activities/Tennis/TennisActivity.cs: simples ou duplas na quadra tns_Field_a. Como no
// original, os jogadores correm sozinhos até a bola; o jogador só bate. O momento do gesto define a direção
// (adiantado = cruzado, puxado para o lado oposto ao braço; atrasado = paralela), a força define a rapidez, o gesto
// para cima dá topspin e para baixo slice/lob. Saque em 2 tempos: o 1º gesto (ou confirmar) joga a bola, o 2º bate;
// no ápice com força = saque-foguete.
import { SportActivity } from '../common/SportActivity.js';
import { v3, add, sub, scale, flat, flatLen, dot, clamp, clamp01, mix, invLerp, lerp } from '../common/vec3.js';
import { BALLS, GRAVITY, step, bounce, backspinAxis } from '../common/BallFlight.js';
import { BallBody, planeWorld } from '../common/BallBody.js';
import { TennisScore, TennisEvent } from './TennisScore.js';
import { TennisCourt, side } from './TennisCourt.js';

const BALL_RADIUS = 0.35;
const HIT_RADIUS = 22;      // alcance da raquete (u) a partir do centro do jogador
const HIT_HEIGHT = 26;

export class TennisActivity extends SportActivity {
  constructor(o) {
    super(o);
    const opt = this.session.options;
    this.teamSize = opt.tennisDoubles ? 2 : 1;
    this.court = new TennisCourt(this.sport.geometry || {}, { doubles: !!opt.tennisDoubles, upm: this.upm });
    this.scoreRules = new TennisScore(opt.tennisGames || 3, this.teamSize, 0);
    this.ball = new BallBody({ params: BALLS.tennis, world: planeWorld(0, 'court'), radius: BALL_RADIUS, upm: this.upm, restSpeed: 2 });
    this.ball.onBounce = (point, n, speed) => this.onBounce(point, n, speed);
    this.ball.interceptor = (b, prev) => this.netCheck(b, prev);
    this.balls.push(this.ball);
    this.tplayers = [];
    this.resetPointState();
    this.gestureKind = 'swing';
  }

  resetPointState() {
    this.lastHitTeam = -1;
    this.bouncesOnSide = 0;
    this.bounceSideTeam = -1;
    this.serving = false;
    this.pointWinner = -1;
    this.pointReason = null;
    this.intercepter = null;
    this.interceptPoint = v3();
    this.lastHitTime = 0;
    this.reServe = false;
  }

  *run() {
    const sc = this.scoreRules;
    this.title('Tênis');
    this.showLayout('vsScoreServer_00');
    this.buildPlayers();
    this.cameraSet(v3(0, this.M(7), this.court.halfLength + this.M(11)), v3(0, 0, -this.M(3)), 50);
    this.cue('SE_TR_Common_Sports_Game_Start');
    this.sfx('crowd', 0.35);
    const g = this.session.options.tennisGames || 3;
    yield this.banner(`${g} ${g === 1 ? 'game' : 'games'} - ${this.teamSize === 2 ? 'duplas' : 'simples'}`, 1.5);
    while (!sc.isMatchOver) {
      yield* this.playPoint();
      if (this.pointWinner < 0) continue;
      const ev = sc.pointTo(this.pointWinner);
      yield* this.announcePoint(ev);
    }
    this.cue('SE_TR_Common_Sports_Game_End');
    yield this.banner(`${sc.winner === 0 ? 'Você venceu!' : 'Você perdeu'}  ${sc.games[0]}-${sc.games[1]}`, 2.5);
    this.finish(this.buildResult());
  }

  /** Time 0: jogador local (+ parceiro CPU em duplas); time 1: adversários. Índices de session.players em ordem. */
  buildPlayers() {
    const n = this.players.length;
    for (let team = 0; team < 2; team++) {
      for (let k = 0; k < this.teamSize; k++) {
        const index = Math.min(team * this.teamSize + k, n - 1);
        const slot = this.players[index];
        const s = side(team);
        const home = this.teamSize === 1 ? v3(0, 0, s * (this.court.halfLength + 6))
          : v3((k === 0 ? 1 : -1) * s * this.court.singlesHalfWidth * 0.55, 0, s * this.court.halfLength * (k === 0 ? 0.95 : 0.45));
        const actor = this.spawnActor(slot, home, v3(0, 0, -s), team);
        actor.moveSpeed = this.M(4.2 + 2.2 * (slot.ai ? slot.ai.speed : 0.5));
        actor.attach('wrist_r', 'tns_racket');
        actor.play('tns_waitR', this.time);
        this.tplayers.push({ actor, slot, index, team, home });
      }
    }
  }

  teamPlayer(team, i) { const m = this.tplayers.filter((q) => q.team === team); return m[clamp(i, 0, m.length - 1)]; }

  *playPoint() {
    this.resetPointState();
    this.updateHud();
    const server = this.teamPlayer(this.scoreRules.servingTeam, this.scoreRules.serverIndex);
    this.resetPositions(server);
    yield 0.6;
    while (this.pointWinner < 0) {
      if (this.reServe) { this.resetPositions(server); yield 0.5; }
      this.reServe = false;
      yield* this.serve(server);
      if (this.pointWinner >= 0) return;
      yield* this.rally();
      if (this.pointWinner >= 0 || this.scoreRules.isMatchOver) return;
    }
  }

  resetPositions(server) {
    const sideIdx = this.scoreRules.serveSide;
    for (const p of this.tplayers) {
      const s = side(p.team);
      let pos = p.home;
      if (p === server) pos = this.court.servePosition(p.team, sideIdx);
      else if (p.team !== server.team && (this.tplayers.length === 2 || this.isReceiver(p, sideIdx))) {
        const sp = this.court.servePosition(server.team, sideIdx);
        pos = v3(-sp.x * 1.6, 0, s * (this.court.halfLength + 2)); // recebedor na diagonal
      }
      p.actor.pos = { ...pos };
      p.actor.face(v3(0, 0, -s));
      p.actor.play('tns_waitR', this.time);
    }
  }

  isReceiver(p, sideIdx) { const m = this.tplayers.filter((q) => q.team === p.team); return m.indexOf(p) === sideIdx % m.length; }

  *serve(server) {
    this.serving = true;
    const sc = this.scoreRules, sideIdx = sc.serveSide, receiver = 1 - server.team;
    const s = side(server.team);
    const hand = add(add(server.actor.pos, v3(0, this.M(1), 0)), scale(server.actor.right, 2));
    this.ball.hold(hand);
    this.ball.visible = true;
    server.actor.play('tns_toss_waitR', this.time);
    const human = server.slot.human;
    this.hint(human ? 'Gesto (ou confirmar) lança a bola; gesto de novo para sacar' : '');
    if (human) {
      this.clearGesture(server.index);
      this.gestureKind = 'swing';
      yield () => this.takeConfirm(server.index) || !!this.takeGesture(server.index);
    } else yield 0.8;
    // lançamento: sobe ~1,5 m acima da mão (ápice em ~0,55 s)
    server.actor.play('tns_tossR', this.time);
    this.ball.launch(hand, v3(0, this.M(5.4), 0));
    this.clearGesture(server.index);
    const apex = 5.4 / GRAVITY;
    const ai = server.slot.ai;
    const cpuAt = apex + (human ? 0 : this.err(server.index, 0.12));
    let tossTime = 0, g = null;
    for (;;) {
      tossTime += this.dt;
      if (human) g = this.takeGesture(server.index);
      else if (tossTime >= cpuAt) g = { power: 0.75 + 0.45 * ai.power, angle: 90 + this.err(server.index, 15), dirX: 0, dirY: 1 };
      if (g) break;
      if (this.ball.pos.y < hand.y - this.M(0.3) && tossTime > apex) break; // deixou cair: refaz
      yield;
    }
    this.hint('');
    if (!g) { this.ball.hold(hand); this.serving = false; yield* this.serve(server); return; }
    const timing = Math.abs(tossTime - apex);
    const rocket = timing < 0.06 && g.power > 1;
    const speed = this.M(mix(28, 48, clamp01(g.power / 1.4)) * (rocket ? 1.18 : 1) * mix(1, 0.75, clamp01(timing / 0.3)));
    const target = this.court.serviceBoxCenter(receiver, sideIdx);
    target.x += -(90 - g.angle) * 0.35 * s + (timing > 0.15 ? (this.rng.next() - 0.5) * 18 : 0);   // gesto inclinado = para a direita de quem saca
    target.z += -s * (this.rng.next() - 0.4) * 14 * clamp01(timing / 0.2);
    const from = { ...this.ball.pos };
    const v = this.court.solveShot(from, target, speed, 80, this.ball.params, BALL_RADIUS);
    server.actor.play('tns_serveR', this.time);
    this.ball.launch(from, v, scale(backspinAxis(v), -80));
    this.hitFeedback(server, g.power, rocket);
    if (rocket) { this.fx('Tns_ball_rocketserve', from); this.fx('Tns_rocketserve_slow', from); }
    this.lastHitTeam = server.team;
    this.lastHitTime = this.time;
    this.bouncesOnSide = 0;
    this.bounceSideTeam = -1;
    yield;
  }

  *rally() {
    let stall = 0;
    const c = this.court;
    while (this.pointWinner < 0 && !this.reServe) {
      this.stepPlayers(this.dt);
      this.tryHits();
      const bp = this.ball.pos;
      if (!this.ball.simulating || bp.y < -this.M(5) || Math.abs(bp.z) > c.halfLength + this.M(25) || Math.abs(bp.x) > this.M(25)) {
        stall += this.dt;
        if (stall > 0.2) this.decideDeadBall();
      }
      this.cameraFollow(v3(bp.x * 0.3, this.M(7), c.halfLength + this.M(11)), v3(bp.x * 0.3, 0, clamp(bp.z, -c.halfLength, c.halfLength * 0.3) - this.M(3)), 2, 50);
      yield;
    }
    this.ball.stop();
  }

  decideDeadBall() {
    if (this.pointWinner >= 0) return;
    if (this.bouncesOnSide >= 1 && this.bounceSideTeam >= 0) this.end(1 - this.bounceSideTeam, 'dois quiques');
    else this.end(this.lastHitTeam >= 0 ? 1 - this.lastHitTeam : 1 - this.scoreRules.servingTeam, 'fora');
  }

  end(winner, reason) {
    if (this.pointWinner >= 0) return;
    this.pointWinner = winner;
    this.pointReason = reason;
    this.serving = false;
  }

  onBounce(point, normal, speed) {
    if (this.pointWinner >= 0 || normal.y < 0.6) return;
    this.fx('Tns_ball_mark', point);
    this.impact(clamp01(speed / this.M(20)) * 0.5, 0.5, 240);
    const sideTeam = point.z >= 0 ? 0 : 1;
    const sc = this.scoreRules;
    if (this.serving) {
      this.serving = false;
      if (sideTeam === this.lastHitTeam || !this.court.inServiceBox(point, 1 - this.lastHitTeam, sc.serveSide)) {
        const dbl = sc.faultCount === 1;
        this.emit('banner', { text: dbl ? 'Dupla falta' : 'Falta', seconds: 1.2 });
        if (dbl) this.end(1 - this.lastHitTeam, 'dupla falta');
        else { sc.fault(); this.reServe = true; }
        return;
      }
      this.bounceSideTeam = sideTeam;
      this.bouncesOnSide = 1;
      return;
    }
    if (sideTeam === this.lastHitTeam && this.bounceSideTeam !== sideTeam) { this.end(1 - this.lastHitTeam, 'bola não passou a rede'); return; }
    if (this.bounceSideTeam !== sideTeam) {
      if (!this.court.inCourt(point, sideTeam)) { this.end(sideTeam, 'fora'); this.fx('Tns_ply_miss01', point); return; }
      this.bounceSideTeam = sideTeam;
      this.bouncesOnSide = 1;
    } else if (++this.bouncesOnSide >= 2) this.end(1 - sideTeam, 'dois quiques');
  }

  netCheck(b, prev) {
    const pos = b.pos;
    if (Math.sign(prev.z) !== Math.sign(pos.z) && Math.abs(pos.x) < this.court.netHalfWidth + 2) {
      const at = lerp(prev, pos, invLerp(prev.z, pos.z, 0));
      if (at.y - BALL_RADIUS < this.court.netHeight(at.x)) {
        b.pos = v3(at.x, at.y, Math.sign(prev.z) * (BALL_RADIUS + 0.2));
        b.vel = v3(b.vel.x * 0.3, Math.min(b.vel.y, 0) * 0.3, -b.vel.z * 0.1);
        this.impact(0.25, 0.1, 140);
        return true;
      }
    }
    return false;
  }

  // ── movimento e rebatidas ─────────────────────────────────────
  stepPlayers(dt) {
    const bp = this.ball.pos, bv = this.ball.vel;
    let incoming = bv.z > 0 ? 0 : 1;
    if (this.lastHitTeam >= 0 && incoming === this.lastHitTeam) incoming = 1 - this.lastHitTeam;
    if (!this.intercepter || this.intercepter.team !== incoming) {
      this.interceptPoint = this.predictIntercept(incoming);
      let best = Infinity;
      this.intercepter = null;
      for (const p of this.tplayers) {
        if (p.team !== incoming) continue;
        const d = flatLen(sub(p.actor.pos, this.interceptPoint));
        if (d < best) { best = d; this.intercepter = p; }
      }
    }
    for (const p of this.tplayers) {
      const s = side(p.team);
      const target = p === this.intercepter ? sub(this.interceptPoint, scale(p.actor.right, this.M(0.9))) : p.home;
      let k = p === this.intercepter ? 1 : 0.6;
      if (!p.slot.human && p.slot.ai && this.time - this.lastHitTime < p.slot.ai.reaction) k = 0; // tempo de reação
      const arrived = p.actor.moveTowards(target, dt, k, 'tns_walkR', 'tns_waitR', this.time);
      p.actor.face(v3(bp.x - p.actor.pos.x, 0, -s * this.M(10)), dt);
      if (arrived && p === this.intercepter) p.actor.play('tns_wait2R', this.time);
    }
  }

  /** Simula adiante (com quique) e devolve o primeiro ponto rebatível no lado do time. */
  predictIntercept(team) {
    const s = side(team), prm = this.ball.params, c = this.court;
    const st = { pos: { ...this.ball.pos }, vel: { ...this.ball.vel }, spin: { ...this.ball.spin } };
    let bounced = this.bounceSideTeam === team;
    let cand = v3(st.pos.x, 0, s * c.halfLength * 0.8);
    for (let t = 0; t < 3; t += 1 / 60) {
      step(st, v3(), prm, this.upm, 1 / 60);
      if (st.pos.y < BALL_RADIUS && st.vel.y < 0) {
        st.pos.y = BALL_RADIUS;
        st.vel = bounce(st.vel, v3(0, 1, 0), st.spin, prm, this.upm);
        if (st.pos.z * s > 0) bounced = true;
      }
      if (st.pos.z * s > 0 && bounced && st.pos.y > this.M(0.5) && st.pos.y < this.M(1.4) && st.vel.y < 0)
        return v3(clamp(st.pos.x, -c.doublesHalfWidth - this.M(3), c.doublesHalfWidth + this.M(3)), 0, st.pos.z);
      if (st.pos.z * s > c.halfLength + this.M(6)) return v3(st.pos.x, 0, s * (c.halfLength + this.M(5)));
      if (st.pos.z * s > 0) cand = v3(st.pos.x, 0, st.pos.z);
    }
    return cand;
  }

  tryHits() {
    if (this.serving || this.pointWinner >= 0 || !this.intercepter) return;
    const p = this.intercepter;
    if (p.team === this.lastHitTeam) return;
    if (this.bounceSideTeam === p.team && this.bouncesOnSide >= 2) return;
    const bp = this.ball.pos;
    const rel = sub(bp, add(p.actor.pos, v3(0, this.M(1), 0)));
    const radius = p.slot.human ? HIT_RADIUS * 1.4 : HIT_RADIUS * (p.slot.ai ? p.slot.ai.reach : 1);
    const inReach = flatLen(rel) < radius && bp.y < HIT_HEIGHT && bp.y > 0.4;
    // voleio só perto da rede; no fundo espera o quique
    const allowed = this.bounceSideTeam === p.team || Math.abs(p.actor.pos.z) < this.court.serviceLine;
    if (!inReach || !allowed) {
      if (p.slot.human && this.takeGesture(p.index)) this.swing(p); // girou no vazio
      return;
    }
    const s = side(p.team);
    const timing = clamp((-rel.z * s) / radius, -1, 1); // + = bola ainda na frente = adiantado
    if (p.slot.human) {
      const g = this.takeGesture(p.index);
      if (!g) return;
      this.hit(p, g.power, timing, g.dirY);
    } else {
      const ai = p.slot.ai;
      const want = this.err(p.index, 0.6);
      if (timing > want + 0.1) return;
      this.hit(p, 0.6 + 0.5 * ai.power + this.err(p.index, 0.15), timing, ai.aggression > 0.6 ? 0.6 : 0.2);
    }
  }

  forehand(p) { return dot(sub(this.ball.pos, p.actor.pos), p.actor.right) >= 0; }

  swing(p) {
    p.actor.play(this.forehand(p) ? 'tns_forehandR' : 'tns_backhandL', this.time);
    this.sfx('whoosh', 0.5);
  }

  hit(p, power01, timing, dirY) {
    const s = side(p.team), c = this.court;
    this.swing(p);
    const pull = timing * (this.forehand(p) ? 1 : -1);
    const hw = c.halfWidth * 0.85;
    const ai = p.slot.human ? null : p.slot.ai;
    // adiantado puxa para a esquerda de quem bate (cruzado, destro); atrasado empurra para a direita
    const x = clamp(-pull * hw * s + (ai ? this.err(p.index, hw * 0.5) + ai.sideBias * 6 : 0), -c.halfWidth - this.M(1.5), c.halfWidth + this.M(1.5));
    const power = clamp(power01, 0.1, 1.6);
    const lob = dirY < -0.4 && power < 0.7;
    let depth = mix(0.55, 0.92, clamp01(power)) * c.halfLength;
    // a CPU erra o comprimento conforme a precisão, mas mira dentro da quadra (o C# deixava ~17% das bolas saírem)
    if (ai) depth = Math.min(depth + this.err(p.index, this.M(2.5)), c.halfLength - this.M(0.3) + this.M(1.5) * (1 - ai.accuracy));
    if (power > 1.2) depth += (power - 1.2) * this.M(12) * this.rng.next(); // força demais arrisca sair
    const aim = v3(x, 0, -s * depth);
    const speed = this.M(lob ? 14 : mix(16, 38, clamp01(power / 1.3)));
    const topspin = lob ? 20 : dirY > 0.3 ? 260 : dirY < -0.2 ? -120 : 120;
    const from = { ...this.ball.pos };
    const v = c.solveShot(from, aim, speed, topspin, this.ball.params, BALL_RADIUS);
    if (lob) v.y = Math.max(v.y, this.M(9));
    this.ball.launch(from, v, scale(backspinAxis(v), -topspin));
    this.hitFeedback(p, power, false);
    this.lastHitTeam = p.team;
    this.lastHitTime = this.time;
    this.bounceSideTeam = -1;
    this.bouncesOnSide = 0;
    this.intercepter = null;
    this.emit('hit', { team: p.team, power: Math.round(power * 100) / 100 });
  }

  hitFeedback(p, power, rocket) {
    this.impact(clamp01(power), 0.55, rocket ? 320 : 260);
    this.fx('Tns_ball_spark', this.ball.pos);
    if (power > 1.1) this.fx(p.team === 0 ? 'Tns_ply_good_blue' : 'Tns_ply_good_red', add(p.actor.pos, v3(0, this.M(2.2), 0)));
  }

  *announcePoint(ev) {
    const sc = this.scoreRules, w = this.pointWinner;
    this.updateHud();
    for (const p of this.tplayers) {
      if (p.team === w) { p.actor.play('tns_A0_jumpR', this.time); p.actor.setExpression('smile'); } else p.actor.setExpression('sad');
    }
    if (w === 0) this.fx('Tns_jumpsmoke', this.tplayers[0].actor.pos);
    let msg;
    if (ev === TennisEvent.Game) msg = `Game! ${sc.games[0]}-${sc.games[1]}`;
    else if (ev === TennisEvent.MatchOver) msg = 'Game, set e partida!';
    else if (ev === TennisEvent.Deuce) msg = 'Iguais';
    else if (ev === TennisEvent.Advantage) msg = `Vantagem ${w === 0 ? 'sua' : 'do adversário'}`;
    else msg = `${w === 0 ? 'Ponto seu' : 'Ponto do adversário'}  ${sc.pointText(0)}`;
    if (this.pointReason && ev === TennisEvent.Point) msg += `\n(${this.pointReason})`;
    if (ev === TennisEvent.Game || ev === TennisEvent.MatchOver) this.cue('SE_TR_Common_Sports_Training_GoodLong');
    this.emit('point', { winner: w, event: ev, reason: this.pointReason });
    yield this.banner(msg, ev === TennisEvent.Point ? 1.4 : 2);
    for (const p of this.tplayers) p.actor.setExpression('neutral');
  }

  updateHud() {
    const sc = this.scoreRules;
    this.score(`${sc.servingTeam === 0 ? '*' : ' '} Você  games ${sc.games[0]}   ${TennisScore.call(sc.points[0])}\n`
      + `${sc.servingTeam === 1 ? '*' : ' '} CPU   games ${sc.games[1]}   ${TennisScore.call(sc.points[1])}\n`
      + sc.pointText(0) + (sc.faultCount > 0 ? '  (2º saque)' : ''));
    this.pane('vsScoreServer_00', 'T_scoreL_00', sc.games[0]);
    this.pane('vsScoreServer_00', 'T_scoreR_00', sc.games[1]);
    this.pane('vsScoreServer_00', 'T_scoreVsBar_00', sc.pointText(0));
  }

  buildResult() {
    const r = this.newResult(), sc = this.scoreRules;
    const opp = Math.min(this.teamSize, this.players.length - 1);
    this.addPlayer(r, this.players[0], sc.games[0], `${sc.games[0]} games`);
    this.addPlayer(r, this.players[opp], sc.games[1], `${sc.games[1]} games`);
    r.winner = sc.winner;
    r.humanWon = sc.winner === 0;
    r.lines.push(`Pontos jogados: ${sc.pointsPlayed}`);
    if (r.humanWon) r.records.push({ field: 'TnsSuccess', value: 1, mode: 'add' });
    return r;
  }

  extraState() {
    const sc = this.scoreRules;
    return { g: sc.games.slice(), p: sc.points.slice(), sv: sc.servingTeam, f: sc.faultCount };
  }
}
