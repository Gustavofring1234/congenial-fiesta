// Beisebol (RPBsbScene), porte de Activities/Baseball/BaseballActivity.cs, no estádio ballpark00: home na origem,
// linhas de falta em +X (1ª base) e +Z (3ª) no referencial do Wii, muro com a distância por ângulo tirada da malha
// de colisão bbl_Field_a (gameplay_data.json). O jogador rebate no alto da entrada e arremessa no baixo.
// Rebater: gesto "swing"; a diferença para a passagem da bola pela base (janela de ±0,13 s) decide contato e direção
// (adiantado = puxa para o campo esquerdo). Arremessar: direcional escolhe o tipo (^ rápida, < curva, > slider,
// v troca), gesto "throw": força = velocidade, inclinação = lado, para cima/baixo = altura. 5 tipos com Magnus.
import { SportActivity } from '../common/SportActivity.js';
import { v3, add, sub, scale, flat, flatLen, norm, dot, cross, between, clamp, clamp01, mix, UP } from '../common/vec3.js';
import { BALLS, step, backspinAxis, predictLanding } from '../common/BallFlight.js';
import { BallBody, planeWorld } from '../common/BallBody.js';
import { BaseballGame, PitchResult } from './BaseballGame.js';
import { plateCrossing, solvePitch } from './PitchMath.js';

const BALL_RADIUS = 0.37;
export const SWING_WINDOW = 0.13;
const PITCHES = ['fastball', 'curve', 'slider', 'changeup', 'splitter'];
const PITCH_NAME = { fastball: 'Rápida', curve: 'Curva', slider: 'Slider', changeup: 'Troca de velocidade', splitter: 'Splitter' };
// posições defensivas: ângulo a partir da linha da 1ª base (graus) e distância (m)
const FIELD_POS = [[8, 26], [30, 40], [60, 40], [82, 26], [18, 78], [45, 88], [72, 78]];

export class BaseballActivity extends SportActivity {
  constructor(o) {
    super(o);
    const g = this.sport.geometry || {};
    this.game = new BaseballGame(clamp(this.session.options.baseballInnings || 3, 1, 9));
    this.home = v3(...(g.home || [0, 0, 0]));
    this.firstLine = norm(v3(...(g.firstBaseLine || [1, 0, 0])));
    this.thirdLine = norm(v3(...(g.thirdBaseLine || [0, 0, 1])));
    this.cf = norm(add(this.firstLine, this.thirdLine));
    this.side = norm(cross(UP, this.cf));
    this.pitcherDist = g.pitcherDistance || 184.4;
    this.baseDist = g.baseDistance || 274.3;
    this.fence = g.fence || [];
    this.fenceStep = g.fenceAngleStepDeg || 5;
    this.pitcherSpot = add(this.home, scale(this.cf, this.pitcherDist));
    this.ball = new BallBody({ params: BALLS.baseball, world: planeWorld(0, 'grass'), radius: BALL_RADIUS, upm: this.upm, restSpeed: 3 });
    this.ball.onBounce = (p, n, s) => { if (s > this.M(3)) { this.fx('Bsb_bound_grass01', p); this.impact(clamp01(s / this.M(30)) * 0.4, 0.4, 200); } };
    this.ball.visible = false;
    this.balls.push(this.ball);
    this.fielders = [];
    this.fielderHome = [];
    this.runners = [null, null, null];
    this.pitchType = 'fastball';
    this.gestureKind = 'swing';
  }

  /** Índice do jogador local (time 0) e do adversário (time 1). */
  slotOfTeam(team) { return team === 0 ? 0 : Math.min(1, this.players.length - 1); }

  fieldPoint(angleDeg, d) { return add(this.home, scale(between(this.firstLine, this.thirdLine, angleDeg), d)); }
  fieldAngle(p) { return (Math.atan2(dot(p, this.thirdLine), dot(p, this.firstLine)) * 180) / Math.PI; }
  fenceAt(angleDeg) {
    if (!this.fence.length) return this.M(100);
    const k = clamp(angleDeg / this.fenceStep, 0, this.fence.length - 1.001), i = Math.floor(k);
    return mix(this.fence[i], this.fence[Math.min(i + 1, this.fence.length - 1)], k - i);
  }
  basePos(b) {
    const d = this.baseDist;
    return [scale(this.firstLine, d), add(scale(this.firstLine, d), scale(this.thirdLine, d)), scale(this.thirdLine, d), this.home][b];
  }

  *run() {
    const game = this.game;
    this.title('Beisebol');
    this.showLayout('bblVsGame_00');
    this.sfx('crowd', 0.4);
    this.cue('SE_TR_Common_Sports_Game_Start');
    yield this.banner(`Play ball! ${game.innings} ${game.innings === 1 ? 'entrada' : 'entradas'}`, 1.6);
    while (!game.isGameOver) {
      const batTeam = game.battingTeam;
      this.setupHalf(batTeam);
      const half = game.inning * 2 + (game.bottom ? 1 : 0);
      yield this.banner(`${game.halfText} - ${this.name(this.players[this.slotOfTeam(batTeam)])} rebate`, 1.4);
      while (!game.isGameOver && game.inning * 2 + (game.bottom ? 1 : 0) === half) yield* this.playPitch();
    }
    this.cue('SE_TR_Common_Sports_Game_End');
    const w = game.winner;
    yield this.banner(`${w === 0 ? 'Vitória' : w === 1 ? 'Derrota' : 'Empate'} ${game.runs[0]} x ${game.runs[1]}`, 2.5);
    this.finish(this.buildResult());
  }

  setupHalf(batTeam) {
    this.actors = [];
    this.fielders = [];
    this.runners = [null, null, null];
    const batSlot = this.players[this.slotOfTeam(batTeam)], fieldSlot = this.players[this.slotOfTeam(1 - batTeam)];
    this.batter = this.spawnActor(batSlot, sub(this.home, scale(this.side, this.M(0.9))), this.side, batTeam);
    this.batter.attach('wrist_l', 'bbl_Bat');
    this.batter.play('bbl_b_waitR', this.time);
    this.pitcher = this.spawnActor(fieldSlot, this.pitcherSpot, scale(this.cf, -1), 1 - batTeam);
    this.pitcher.attach('wrist_l', 'bbl_Glove_l');
    this.pitcher.play('bbl_p_waitR', this.time);
    this.catcher = this.spawnActor(fieldSlot, sub(this.home, scale(this.cf, this.M(1.2))), this.cf, 1 - batTeam);
    this.catcher.play('bbl_c_waitR', this.time);
    FIELD_POS.forEach(([a, d], i) => {
      const pos = this.fieldPoint(a, this.M(d));
      this.fielderHome[i] = pos;
      const f = this.spawnActor(fieldSlot, pos, sub(this.home, pos), 1 - batTeam);
      f.moveSpeed = this.M(6.5 + 2 * (fieldSlot.ai ? fieldSlot.ai.speed : 0.5));
      f.play('bbl_A0_waitR', this.time);
      this.fielders.push(f);
    });
    this.cameraBatting();
    this.updateHud();
  }

  cameraBatting() { this.cameraSet(add(sub(this.home, scale(this.cf, this.M(7))), v3(0, this.M(2.4), 0)), add(this.pitcherSpot, v3(0, this.M(1), 0)), 42); }

  *playPitch() {
    const game = this.game;
    const batP = this.slotOfTeam(game.battingTeam), pitP = this.slotOfTeam(game.fieldingTeam);
    this.cameraBatting();
    const release = add(add(this.pitcherSpot, v3(0, this.M(1.9), 0)), scale(this.side, this.M(0.4)));
    this.ball.hold(release);
    this.ball.visible = true;
    this.pitcher.play('bbl_p_waitR', this.time);
    this.batter.play('bbl_b_swing_wait1R', this.time);
    let type, speedMS, lateral, height;
    if (!this.isHuman(pitP)) {
      this.hint(this.isHuman(batP) ? 'Gesto de rebatida quando a bola chegar (arrastar e soltar, Espaço, câmera)' : '');
      yield 0.9 + this.rng.next() * 0.6;
      ({ type, speedMS, lateral, height } = this.cpuPitch(pitP));
    } else {
      type = 'fastball';
      const pick = (dt) => {
        const m = this.controlsOf(pitP).move;
        if (m.y > 0.6) type = 'fastball'; else if (m.x < -0.6) type = 'curve'; else if (m.x > 0.6) type = 'slider'; else if (m.y < -0.6) type = 'changeup';
        this.pitchType = type;
        this.hint(`Arremesso: ${PITCH_NAME[type]}   (^ rápida  < curva  > slider  v troca)  •  gesto para arremessar`);
        return true;
      };
      const g = yield* this.waitGesture('throw', pitP, pick);
      if (!g) return;
      const base = type === 'changeup' ? 30 : type === 'curve' ? 33 : 37;
      speedMS = clamp(base * (0.75 + 0.3 * clamp(g.power, 0, 1.4)), 22, 46);
      lateral = clamp((90 - g.angle) / 45, -1, 1) * 0.35;
      height = 0.8 + clamp(g.dirY, -1, 1) * 0.1;
    }
    this.pitchType = type;
    this.hint('');
    this.gestureKind = 'swing';
    this.pitcher.play(type === 'fastball' ? 'bbl_p_pitch1R' : 'bbl_p_pitch2R', this.time);
    yield 0.45;
    const target = add(add(this.home, scale(this.side, this.M(lateral))), v3(0, this.M(height), 0));
    const spin = this.pitchSpin(type, norm(sub(target, release)));
    const v = solvePitch(release, target, this.M(speedMS), spin, this.home, this.cf, this.ball.params, this.upm);
    this.ball.launch(release, v, spin);
    this.fx('Bsb_ball_tail01', release);
    this.sfx('whoosh', 0.3);
    this.pane('bblCommon_00', 'T_ballSpeed_00', Math.round(speedMS * 3.6));
    this.pane('bblCommon_00', 'T_ballName_00', PITCH_NAME[type]);
    this.emit('pitch', { pitch: type, kmh: Math.round(speedMS * 3.6) });

    const crossing = plateCrossing(release, v, spin, this.home, this.cf, this.ball.params, this.upm);
    const tCross = crossing.time;
    let swung = false, swingDt = 0, swingPower = 0, cpuSwing = false, cpuDt = 0;
    if (!this.isHuman(batP)) {
      const ai = this.aiOf(batP);
      const discipline = 0.45 + 0.5 * ai.skill;
      cpuSwing = this.inZone(crossing.point) ? this.rng.chance(0.55 + 0.4 * discipline) : this.rng.chance(0.45 * (1 - discipline));
      // erro de tempo da CPU um pouco maior que no C# (lá saíam ~6 home runs por entrada entre CPUs fortes)
      cpuDt = this.err(batP, 0.24) + (type === 'changeup' ? 0.05 * (1 - ai.skill) : 0);
    }
    this.clearGesture(batP);
    const t0 = this.time;
    for (;;) {
      const since = this.time - t0;
      if (!swung && this.isHuman(batP)) { const g = this.takeGesture(batP); if (g) { swung = true; swingDt = since - tCross; swingPower = g.power; } }
      if (!swung && cpuSwing && since >= tCross + cpuDt - 0.02) { swung = true; swingDt = cpuDt; swingPower = 0.55 + 0.4 * this.aiOf(batP).power; }
      if (swung && this.batter.anim !== 'bbl_b_swing1R') {
        this.batter.play('bbl_b_swing1R', this.time);
        this.sfx('whoosh', 0.6);
        this.fx('Bsb_batblur01', add(this.batter.pos, v3(0, this.M(1), 0)));
      }
      // contato: gesto adiantado espera a bola chegar; atrasado acontece na hora do gesto
      if (swung && Math.abs(swingDt) <= SWING_WINDOW && since >= Math.max(tCross, tCross + swingDt) - 0.01) {
        yield* this.contact(swingDt, swingPower, batP);
        return;
      }
      if (since > tCross + 0.35) break;
      yield;
    }
    // sem contato: bola na luva do apanhador
    this.ball.hold(add(sub(this.home, scale(this.cf, this.M(1))), v3(0, this.M(0.8), 0)));
    this.catcher.play('bbl_c_recerveR', this.time);
    this.impact(0.3, 0.2, 120);
    const res = swung ? PitchResult.SwingingStrike : this.inZone(crossing.point) ? PitchResult.CalledStrike : PitchResult.Ball;
    this.applyResult(res);
    yield this.banner(res === PitchResult.Ball ? 'Ball' : res === PitchResult.SwingingStrike ? 'Strike (girou)' : 'Strike', 1);
    yield* this.afterPlay();
  }

  cpuPitch(p) {
    const ai = this.aiOf(p);
    const n = ai.skill > 0.6 ? 5 : ai.skill > 0.3 ? 4 : 2;
    const type = PITCHES[this.rng.int(n)];
    const base = type === 'changeup' ? 30 : type === 'curve' ? 32 : type === 'splitter' ? 35 : 36;
    // quanto mais habilidosa, mais a CPU mira as bordas da zona (às vezes erra para fora)
    return {
      type,
      speedMS: base + 8 * ai.power + this.err(p, 1.5),
      lateral: clamp(this.err(p, 0.28) + (this.rng.chance(0.5) ? -1 : 1) * 0.12 * ai.skill, -0.45, 0.45),
      height: 0.8 + this.err(p, 0.25),
    };
  }

  pitchSpin(type, dir) {
    const back = backspinAxis(dir);
    switch (type) {
      case 'curve': return add(scale(back, -180), scale(UP, 60));   // topspin: cai bastante
      case 'slider': return scale(UP, -170);                        // desvia para o lado
      case 'changeup': return scale(back, 90);
      case 'splitter': return scale(back, -60);
      default: return scale(back, 210);                            // rápida "sobe"
    }
  }

  /** Zona de strike: meia largura da base (0,216 m) + raio da bola; altura de 0,45 a 1,07 m. */
  inZone(at) {
    const lat = dot(sub(at, this.home), this.side) / this.upm, h = at.y / this.upm;
    return Math.abs(lat) <= 0.216 + 0.037 && h >= 0.45 && h <= 1.07;
  }

  *contact(dt, power, batP) {
    const quality = 1 - Math.abs(dt) / SWING_WINDOW;              // 1 = no ponto
    let spray = clamp(-dt / SWING_WINDOW, -1, 1) * 48;              // adiantado puxa para o campo esquerdo (3ª base)
    const exit = mix(18, 50, quality * clamp01(power / 1.3) * 0.85 + 0.15 * quality);
    let launch;
    if (quality > 0.75) launch = mix(18, 32, this.rng.next());
    else if (this.rng.chance(0.5)) launch = mix(-6, 10, this.rng.next());   // rasteira
    else launch = mix(40, 70, this.rng.next());                             // bola alta
    spray += (this.rng.next() - 0.5) * 20 * (1 - quality);
    const dir = between(this.firstLine, this.thirdLine, 45 + spray);
    const lr = (launch * Math.PI) / 180;
    const v = scale(add(scale(dir, Math.cos(lr)), v3(0, Math.sin(lr), 0)), this.M(exit));
    const spin = scale(backspinAxis(dir), launch > 10 ? 220 : -120);
    const from = add(this.home, v3(0, this.M(0.9), 0));
    this.ball.launch(from, v, spin);
    this.impact(clamp01(quality * 1.2), 0.85, 600);
    if (quality > 0.85) { this.fx('Bsb_justmeet02', from); this.cue('SE_TR_Common_Sports_Training_GoodLong'); }
    this.batter.play('bbl_r_runR', this.time);
    const cls = this.classify(from, v, spin, launch, exit);
    const res = cls.result;
    const landing = predictLanding(from, v, spin, v3(), this.ball.params, this.upm, 0).point;
    const chaser = this.nearestFielder(landing);
    this.fx('Bsb_ballpoint01', landing);
    const total = clamp(cls.hang, 1, 5);
    for (let t = 0; t < total; t += this.dt) {
      const bp = this.ball.pos;
      this.cameraFollow(add(add(sub(this.home, scale(this.cf, this.M(12))), v3(0, this.M(8), 0)), scale(sub(bp, this.home), 0.35)), bp, 2.5, 50);
      if (chaser) chaser.moveTowards(landing, this.dt, 1, 'bbl_A0_runR', 'bbl_A0_waitR', this.time);
      this.advanceRunners(this.dt);
      yield;
    }
    this.ball.stop();
    const names = { homeRun: 'HOME RUN!', foul: 'Foul', doublePlay: 'Queimada dupla!', single: 'Rebatida simples', double: 'Rebatida dupla', triple: 'Rebatida tripla!' };
    let msg = names[res] || (launch > 15 ? 'Eliminado (bola alta)' : 'Eliminado');
    if (res === PitchResult.HomeRun) this.fx('Bsb_ballglow01', landing);
    if (res === PitchResult.Out && chaser) chaser.play('bbl_c_recerveR', this.time);
    const runs = this.applyResult(res);
    if (runs > 0) msg += `\n+${runs} ${runs === 1 ? 'corrida' : 'corridas'}`;
    if (res === PitchResult.HomeRun || res === PitchResult.Triple || res === PitchResult.Double) this.batter.setExpression('smile');
    this.emit('play', { result: res, runs, quality: Math.round(quality * 100) / 100, exit: Math.round(exit) });
    yield this.banner(msg, res === PitchResult.HomeRun ? 2.2 : 1.4);
    this.batter.setExpression('neutral');
    yield* this.afterPlay();
  }

  /** Classifica a rebatida simulando o voo contra o muro real e os defensores. {result, hang} */
  classify(from, v, spin, launch, exitMS) {
    const s = { pos: { ...from }, vel: { ...v }, spin: { ...spin } };
    const dt = 1 / 120;
    let hang = 0;
    while (hang < 12) {
      step(s, v3(), this.ball.params, this.upm, dt);
      hang += dt;
      const fl = flat(sub(s.pos, this.home));
      const ang = this.fieldAngle(fl);
      if (ang >= -1 && ang <= 91 && flatLen(fl) >= this.fenceAt(clamp(ang, 0, 90)))
        return { result: s.pos.y > this.M(3) ? PitchResult.HomeRun : PitchResult.Double, hang }; // por cima ou no muro
      if (s.pos.y <= 0) break;
    }
    const land = flat(sub(s.pos, this.home));
    const a = this.fieldAngle(land);
    if (a < 0 || a > 90 || flatLen(land) < this.M(2)) return { result: PitchResult.Foul, hang };
    const distM = flatLen(land) / this.upm;
    const fielderSpeed = 7 * this.upm, reach = this.M(2.5);
    let bestMargin = Infinity;
    for (const [fa, fd] of FIELD_POS) {
      const need = flatLen(sub(land, this.fieldPoint(fa, this.M(fd)))) - reach;
      bestMargin = Math.min(bestMargin, need - fielderSpeed * Math.max(0, hang - 0.35));
    }
    const def = this.aiOf(this.slotOfTeam(this.game.fieldingTeam));
    const defSkill = def ? def.skill : 0.5;
    if (launch > 12) {
      if (bestMargin < this.M(1) * defSkill) {           // bola alta/linha apanhada
        if (distM > 70 && this.game.outs < 2) this.game.markSacrificeFly();
        return { result: PitchResult.Out, hang };
      }
    } else {
      for (let i = 0; i < 4; i++) {                       // rasteira: infielders cortam bolas fracas ou na direção deles
        if (Math.abs(a - FIELD_POS[i][0]) < 6 + 6 * defSkill && exitMS < 44) {
          const dp = (this.game.bases & 1) && this.game.outs < 2 && exitMS < 36 && this.rng.chance(0.4 + 0.3 * defSkill);
          return { result: dp ? PitchResult.DoublePlay : PitchResult.Out, hang };
        }
      }
      if (exitMS < 24) return { result: PitchResult.Out, hang };
    }
    if (distM < 62) return { result: PitchResult.Single, hang };
    if (distM < 88 || bestMargin < this.M(10)) return { result: PitchResult.Double, hang };
    return { result: PitchResult.Triple, hang };
  }

  nearestFielder(p) {
    let best = null, d = Infinity;
    for (const f of this.fielders) { const k = flatLen(sub(f.pos, p)); if (k < d) { d = k; best = f; } }
    return best;
  }

  applyResult(r) {
    const runs = this.game.apply(r);
    this.updateRunners();
    this.updateHud();
    return runs;
  }

  *afterPlay() {
    this.ball.stop();
    this.ball.visible = false;
    this.fielders.forEach((f, i) => { f.pos = { ...this.fielderHome[i] }; });
    this.batter.play('bbl_b_waitR', this.time);
    yield 0.4;
  }

  updateRunners() {
    const team = this.game.battingTeam, slot = this.players[this.slotOfTeam(team)];
    for (let b = 0; b < 3; b++) {
      const occupied = ((this.game.bases >> b) & 1) !== 0;
      if (occupied && !this.runners[b]) {
        this.runners[b] = this.spawnActor(slot, this.basePos(b), sub(this.basePos((b + 1) % 4), this.basePos(b)), team);
        this.runners[b].play('bbl_A0_waitR', this.time);
      } else if (!occupied && this.runners[b]) { this.removeActor(this.runners[b]); this.runners[b] = null; }
      else if (occupied) this.runners[b].pos = { ...this.basePos(b) };
    }
  }

  advanceRunners(dt) {
    for (let b = 0; b < 3; b++) if (this.runners[b]) this.runners[b].moveTowards(this.basePos(Math.min(b + 1, 3)), dt, 0.8, 'bbl_r_runR', 'bbl_A0_waitR', this.time);
  }

  updateHud() {
    const g = this.game;
    const bases = `${g.bases & 2 ? '#' : 'o'}\n${g.bases & 4 ? '#' : 'o'}   ${g.bases & 1 ? '#' : 'o'}`;
    this.score(`${this.name(this.players[0])} ${g.runs[0]}  x  ${g.runs[1]} ${this.name(this.players[this.slotOfTeam(1)])}\n${g.halfText}\nB ${g.balls}  S ${g.strikes}  O ${g.outs}\n${bases}`);
    this.pane('bblVsGame_00', 'T_scoreL_00', g.runs[0]);
    this.pane('bblVsGame_00', 'T_scoreR_00', g.runs[1]);
    this.pane('bblVsGame_00', 'T_game_00', g.inning + 1);
    const id = this.sport.hud ? this.sport.hud.bblVsGame_00 : null;
    if (id) {
      const vis = {};
      for (let i = 0; i < 3; i++) vis['P_ballOn_0' + i] = g.balls > i;
      for (let i = 0; i < 2; i++) vis['P_strikeOn_0' + i] = g.strikes > i;
      for (let i = 0; i < 2; i++) vis['P_outOn_0' + i] = g.outs > i;
      for (let i = 0; i < 3; i++) vis['P_runnerOn_0' + (i + 1)] = ((g.bases >> i) & 1) !== 0;
      this.emit('visible', { layout: id, panes: vis });
    }
  }

  buildResult() {
    const r = this.newResult(), g = this.game;
    this.addPlayer(r, this.players[0], g.runs[0], `${g.runs[0]} corridas, ${g.hits[0]} rebatidas`);
    this.addPlayer(r, this.players[this.slotOfTeam(1)], g.runs[1], `${g.runs[1]} corridas, ${g.hits[1]} rebatidas`);
    r.winner = g.winner;
    r.humanWon = g.winner === 0;
    r.records.push({ field: 'BsbRenzokuBest', value: g.bestConsecutiveHits(0), mode: 'higher' });
    return r;
  }

  extraState() {
    const g = this.game;
    return { r: g.runs.slice(), i: g.inning, bt: g.bottom ? 1 : 0, c: [g.balls, g.strikes, g.outs], ba: g.bases, pt: this.pitchType };
  }
}
