// Golfe (RPGolScene), porte de Activities/Golf/GolfActivity.cs. Cada buraco é uma cena glf_course_* com tee e pinos
// do .pmp e a colisão por flag do KCL (tee/fairway/rough/banca/green/água/fora). Voo com arrasto, backspin e efeito
// lateral, vento por buraco, rolamento por superfície, copo, penalidade de água/fora (+1) e limite de 10 tacadas.
// Joga quem está mais longe do pino. Controle: < > mira, ^ v taco, gesto "swing": força = velocidade, inclinação =
// hook/slice. O mundo de cada buraco vem de options.loadWorld(curso) (a tela carrega a cena; os testes só a colisão).
import { SportActivity } from '../common/SportActivity.js';
import { v3, add, sub, scale, flat, flatLen, norm, dot, turnRight, rightOf, clamp, clamp01, UP } from '../common/vec3.js';
import { BALLS, backspinAxis, solveSpeed, step } from '../common/BallFlight.js';
import { BallBody, planeWorld, meshWorld } from '../common/BallBody.js';
import { GolfScorecard } from './GolfScorecard.js';
import { CLUBS, club, clubIndex, suggestClub, surfacePowerFactor, puttSpeed, surfaceBall } from './GolfClubs.js';
import { CollisionWorld } from '../../engine/scene/CollisionWorld.js';

const CUP_RADIUS = 0.6;       // u: copo de 10,8 cm; aceita a bola com metade dentro
const GREEN_RADIUS_M = 16;

const SURFACE_NAME = { tee: 'Tee', fairway: 'Fairway', green: 'Green', bunker: 'Banca', deepRough: 'Rough alto', rough: 'Rough' };

export class GolfActivity extends SportActivity {
  /** Só a colisão de um curso (sem modelos): para testes e para o anfitrião sem tela. */
  static async courseWorld(store, course) {
    const scene = await store.json('Scenes/' + course.scene);
    return meshWorld(await CollisionWorld.load(store, scene.collision.map((c) => c.glb)));
  }

  constructor(o) {
    super(o);
    this.loadWorld = o.loadWorld || (async () => planeWorld(0, 'fairway'));
    const all = this.sport.courses || [];
    const ids = this.session.options.golfHoles || [];
    this.holes = ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
    if (!this.holes.length && all.length) this.holes.push(all[0]);
    this.card = new GolfScorecard(this.holes.map((h) => h.par), this.players.length, 10);
    this.ball = new BallBody({ params: BALLS.golf, world: planeWorld(0, 'fairway'), radius: 0.5, upm: this.upm, restSpeed: 0.8 });
    // o rough logo em volta do copo conta como green (a malha dos cursos marca a franja como rough)
    this.ball.surfaceParams = (s) => surfaceBall(BALLS.golf, s === 'rough' && flatLen(sub(this.ball.pos, this.pin)) < this.M(GREEN_RADIUS_M) * 0.6 ? 'green' : s);
    this.ball.onBounce = (point, n, speed, s) => this.onBounce(point, speed, s);
    this.ball.interceptor = (b, prev) => this.cupCheck(b);
    this.balls.push(this.ball);
    this.ballPos = this.players.map(() => v3());
    this.pin = v3();
    this.wind = v3();
    this.holed = false;
    this.holeIndex = 0;
    this.course = null;
    this.aimLine = null;
    this.clubKind = 'driver';
    this.gestureKind = 'swing';
  }

  *run() {
    this.title('Golfe');
    this.showLayout('golf_00');
    this.players.forEach((slot, p) => this.spawnActor(slot, v3(), v3(0, 0, -1), p));
    this.cue('SE_TR_Common_Sports_Game_Start');
    for (let h = 0; h < this.holes.length; h++) yield* this.playHole(h);
    this.cue('SE_TR_Common_Sports_Game_End');
    yield* this.showCard(this.holes.length - 1, 3);
    this.finish(this.buildResult());
  }

  /** Espera uma Promise dentro do gerador. */
  *await(promise) {
    let done = false, value, error;
    promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
    yield () => done;
    if (error) throw error;
    return value;
  }

  *playHole(h) {
    const hole = this.holes[h];
    this.holeIndex = h;
    this.course = hole;
    this.emit('course', { id: hole.id, scene: hole.scene });
    this.world = yield* this.await(this.loadWorld(hole));
    this.ball.world = this.world;
    const pins = hole.pins || [];
    const pin = pins.length ? pins[(h + (this.session.seed || 0)) % pins.length] : null;
    this.pin = pin ? v3(pin[0], pin[1], pin[2]) : add(v3(...hole.tee), scale(v3(...hole.teeForward), this.M(hole.distanceMeters)));
    const g = this.world.ground(this.pin.x, this.pin.z, this.pin.y + 50);
    if (g) this.pin.y = g.y;
    const windMS = this.rng.next() * 6;
    const windDir = this.rng.next() * Math.PI * 2;
    this.wind = v3(Math.sin(windDir) * this.M(windMS), 0, Math.cos(windDir) * this.M(windMS));
    this.ball.wind = this.wind;
    const tee = v3(hole.tee[0], hole.tee[1], hole.tee[2]);
    const tg = this.world.ground(tee.x, tee.z, tee.y + 50);
    if (tg) tee.y = tg.y;
    this.ballPos = this.players.map(() => add(tee, v3(0, 0.6, 0)));
    this.pane('golf_00', 'T_holeNum_00', h + 1);
    const fwd = v3(hole.teeForward[0], 0, hole.teeForward[2]);
    this.cameraSet(add(add(tee, v3(0, this.M(30), 0)), scale(fwd, -this.M(15))), this.pin, 50);
    yield this.banner(`Buraco ${h + 1}  •  Par ${hole.par}  •  ${Math.round(hole.distanceMeters)} m\nVento ${windMS.toFixed(1)} m/s`, 2.2);
    while (!this.card.holeComplete(h)) yield* this.playShot(h, this.nextPlayer(h));
    yield* this.showCard(h, 2.2);
  }

  /** Quem está mais longe do pino (e não terminou) joga. */
  nextPlayer(h) {
    let best = -1, far = -1;
    this.ballPos.forEach((b, p) => {
      if (this.card.isHoled(p, h)) return;
      const d = flatLen(sub(b, this.pin));
      if (d > far) { far = d; best = p; }
    });
    return best;
  }

  surfaceAt(p) {
    const g = this.world.ground(p.x, p.z, p.y + 30);
    if (!g) return 'outOfBounds';
    if (g.surface === 'rough' && flatLen(sub(p, this.pin)) < this.M(GREEN_RADIUS_M) * 0.6) return 'green';
    return g.surface;
  }

  *playShot(h, p) {
    const slot = this.players[p], actor = this.actors[p];
    const start = { ...this.ballPos[p] };
    const surface = this.surfaceAt(start);
    this.ball.hold(start);
    this.ball.visible = true;
    const distM = flatLen(sub(this.pin, start)) / this.upm;
    const onTee = this.card.strokesOf(p, h) === 0;
    this.clubKind = suggestClub(distM, surface, onTee);
    const toPin = norm(flat(sub(this.pin, start)));
    let aimYaw = 0;
    actor.pos = sub(start, scale(rightOf(toPin), 3.5));
    actor.face(toPin);
    actor.attach('wrist_r', club(this.clubKind).model);
    actor.play(this.clubKind === 'putter' ? 'glf_p_wait_m_R' : 'glf_w_wait_m_R', this.time);
    this.updateHud(h, p, distM, surface);
    let g;
    if (slot.human) {
      this.hint('< > mirar  ^ v taco  gesto de tacada (arrastar e soltar, Espaço, câmera)');
      let clubTimer = 0;
      g = yield* this.waitGesture('swing', p, (dt) => {
        const c = this.controlsOf(p);
        aimYaw += c.move.x * 40 * dt;
        clubTimer -= dt;
        if (Math.abs(c.move.y) > 0.6 && clubTimer <= 0) {
          const k = clamp(clubIndex(this.clubKind) + (c.move.y > 0 ? -1 : 1), 0, CLUBS.length - 1);
          this.clubKind = CLUBS[k].kind;
          clubTimer = 0.25;
          actor.attach('wrist_r', club(this.clubKind).model);
          this.updateHud(h, p, distM, surface);
        }
        const dir = turnRight(toPin, aimYaw);
        this.aimLine = this.trajectory(start, dir, surface, 1);
        actor.face(dir);
        const putt = this.clubKind === 'putter';
        this.cameraFollow(add(sub(start, scale(dir, this.M(putt ? 5 : 9))), v3(0, this.M(putt ? 2.5 : 4), 0)), add(start, scale(dir, this.M(Math.min(distM, putt ? 10 : 60)))), 6, 50);
        this.meter(c.charge, c.charge > 0);
        return true;
      });
    } else {
      yield 0.8;
      const cpu = this.cpuShot(p, start, distM, surface);
      this.clubKind = cpu.club;
      aimYaw = cpu.aimYaw;
      g = cpu.gesture;
      actor.attach('wrist_r', club(this.clubKind).model);
      const dir = turnRight(toPin, aimYaw);
      this.aimLine = this.trajectory(start, dir, surface, 1);
      this.cameraSet(add(sub(start, scale(dir, this.M(9))), v3(0, this.M(4), 0)), add(start, scale(dir, this.M(40))), 50);
      yield 0.8;
    }
    this.hint('');
    this.meter(0, false);
    this.aimLine = null;
    if (!g) return;

    // tacada
    const c = club(this.clubKind);
    const power = clamp(g.power, 0, 1.3);
    const over = Math.max(0, power - 1);                  // além de 100% = descontrole
    const dev = clamp(90 - g.angle, -45, 45);             // gesto inclinado para a direita = slice
    const errDeg = dev * 0.08 + (over > 0 ? (this.rng.next() * 2 - 1) * c.maxErrorDeg * over * 3 : 0);
    const aimDir = turnRight(toPin, aimYaw + errDeg);
    const putt = c.kind === 'putter';
    actor.play(putt ? (power < 0.4 ? 'glf_p_swing_l' : power < 0.8 ? 'glf_p_swing_m' : 'glf_p_swing_h') : (power < 0.4 ? 'glf_w_swing_l_R' : power < 0.8 ? 'glf_w_swing_m_R' : 'glf_w_swing_h_R'), this.time);
    yield 0.35;
    this.sfx('whoosh', 0.4 + 0.4 * power);
    this.impact(clamp01(power), putt ? 0.3 : 0.8, putt ? 500 : 900);
    this.card.addStroke(p, h);
    this.fx(onTee ? 'Gol_tee_shot' : surface === 'bunker' ? 'Gol_bunker_shot01' : surface === 'rough' || surface === 'deepRough' ? 'Gol_rough_shot_leaf' : 'Gol_fairway_shot', start);
    this.holed = false;
    const speedMS = Math.min(power, 1.15) * c.maxSpeedMS * surfacePowerFactor(surface, c.kind);
    if (putt) this.ball.roll(start, scale(aimDir, this.M(speedMS)));
    else {
      const l = (c.launchDeg * Math.PI) / 180;
      const v = scale(add(scale(aimDir, Math.cos(l)), v3(0, Math.sin(l), 0)), this.M(speedMS));
      // backspin + efeito lateral: spin para cima curva para a esquerda, então o slice (dev > 0) usa -up
      const spin = add(scale(backspinAxis(aimDir), c.backspin * (0.5 + 0.5 * power)), scale(UP, -dev * c.sideSpinPerDeg));
      this.ball.launch(add(start, v3(0, 0.2, 0)), v, spin);
      this.fx('Gol_balltail', start);
    }
    yield* this.followBall();
    actor.attach('wrist_r', null);
    yield* this.resolveLie(h, p, start);
  }

  *followBall() {
    let t = 0;
    while (this.ball.simulating && t < 25 && !this.holed) {
      t += this.dt;
      const bp = this.ball.pos, v = this.ball.vel;
      const back = flatLen(v) > 1 ? norm(flat(v)) : norm(flat(sub(this.pin, bp)));
      const r = this.ball.rolling;
      this.cameraFollow(add(sub(bp, scale(back, this.M(r ? 6 : 14))), v3(0, this.M(r ? 3 : 6), 0)), bp, r ? 4 : 2.5, 50);
      if (bp.y < this.pin.y - this.M(300)) break;
      yield;
    }
    this.ball.stop();
  }

  *resolveLie(h, p, previous) {
    const actor = this.actors[p];
    const bp = { ...this.ball.pos };
    if (this.holed) {
      this.card.hole(p, h);
      const s = this.card.strokesOf(p, h), par = this.card.par[h];
      this.ballPos[p] = { ...this.pin };
      this.ball.visible = false;
      this.cue(s <= par ? 'SE_TR_Common_Sports_Training_GoodLong' : 'SE_TR_Common_Sports_Decide');
      const up10 = add(this.pin, v3(0, 10, 0));
      if (s === 1) this.fx('Gol_matohit_pinlight', this.pin);
      else if (s - par <= -3) this.fx('Gol_2d_albat', up10);
      else if (s - par === -2) this.fx('Gol_2d_eagle', up10);
      else if (s - par === -1) this.fx('Gol_2d_birdie', up10);
      this.fx('Gol_mapobj_hole_green', this.pin);
      actor.setExpression(s <= par ? 'smile' : 'neutral');
      this.emit('holed', { player: p, strokes: s, par });
      yield this.banner(`${this.name(this.players[p])}: ${GolfScorecard.resultName(s, par)}`, 2);
      actor.setExpression('neutral');
      return;
    }
    const surface = this.surfaceAt(bp);
    if (surface === 'water' || surface === 'outOfBounds' || bp.y < this.pin.y - this.M(200)) {
      if (surface === 'water') this.fx('Gol_ikepocha', bp);
      const capped = this.card.addStroke(p, h, 0);        // penalidade: 1 tacada, volta para onde estava
      this.ballPos[p] = previous;
      yield this.banner(surface === 'water' ? 'Água! +1 tacada' : 'Fora dos limites! +1 tacada', 1.6);
      if (capped) yield* this.pickUp(h, p);
      return;
    }
    this.ballPos[p] = bp;
    const left = flatLen(sub(this.pin, bp)) / this.upm;
    const where = { green: 'No green', bunker: 'Na banca', fairway: 'No fairway', rough: 'No rough', deepRough: 'No rough' }[surface] || '';
    if (this.card.strokesOf(p, h) >= this.card.maxStrokesPerHole) { yield* this.pickUp(h, p); return; }
    yield this.banner(`${where}${where ? ' - ' : ''}${left < 10 ? left.toFixed(1) : left.toFixed(0)} m do buraco`, 1.2);
  }

  *pickUp(h, p) {
    if (!this.card.isHoled(p, h)) this.card.hole(p, h);
    this.ballPos[p] = { ...this.pin };
    yield this.banner(`${this.name(this.players[p])} recolhe a bola (limite de tacadas)`, 1.5);
  }

  cupCheck(b) {
    const d = sub(b.pos, this.pin);
    const fl = flatLen(d);
    if (fl < CUP_RADIUS && d.y < 1.2 && d.y > -2 && flatLen(b.vel) < this.M(1.8)) {
      this.holed = true;
      b.stop();
      b.pos = add(this.pin, v3(0, -0.6, 0));
      this.impact(0.3, 0.9, 1200);
      return true;
    }
    // bate na bandeira: devolve para perto do copo
    if (fl < 0.5 && d.y > 1.2 && d.y < 25) b.vel = v3(-b.vel.x * 0.2, b.vel.y, -b.vel.z * 0.2);
    return false;
  }

  onBounce(point, speed, s) {
    if (speed < this.M(1)) return;
    this.fx(s === 'bunker' ? 'Gol_bunker_fall' : s === 'rough' || s === 'deepRough' ? 'Gol_rough_bound' : s === 'water' ? 'Gol_ikepocha' : 'Gol_fairway_bound', point);
    this.impact(clamp01(speed / this.M(20)) * 0.5, s === 'bunker' ? 0.1 : 0.4, 260);
  }

  /** Linha de mira (40 pontos): voo previsto sem vento, ou o caminho do putt no chão. */
  trajectory(start, dir, surface, power) {
    const c = club(this.clubKind);
    const pts = [];
    if (c.kind === 'putter') {
      const dist = this.M(Math.min(flatLen(sub(this.pin, start)) / this.upm, 30));
      for (let i = 0; i < 40; i++) {
        const q = add(start, scale(dir, (dist * i) / 39));
        const g = this.world ? this.world.ground(q.x, q.z, q.y + 20) : null;
        pts.push(v3(q.x, (g ? g.y : q.y) + 0.3, q.z));
      }
      return pts;
    }
    const speed = this.M(c.maxSpeedMS * power * surfacePowerFactor(surface, c.kind));
    const l = (c.launchDeg * Math.PI) / 180;
    const s = { pos: { ...start }, vel: scale(add(scale(dir, Math.cos(l)), v3(0, Math.sin(l), 0)), speed), spin: scale(backspinAxis(dir), c.backspin) };
    for (let i = 0; i < 40; i++) {
      pts.push({ ...s.pos });
      for (let k = 0; k < 6; k++) step(s, v3(), BALLS.golf, this.upm, 0.12 / 6);
      if (s.pos.y < start.y - 5 && s.vel.y < 0) { while (pts.length < 40) pts.push({ ...s.pos }); break; }
    }
    return pts;
  }

  /** CPU: taco do caddie, força pela simulação do voo (carry até o pino menos o rolamento), erro e correção de vento. */
  cpuShot(p, start, distM, surface) {
    const ai = this.aiOf(p);
    const kind = suggestClub(distM, surface, false);
    const c = club(kind);
    let power;
    if (kind === 'putter') power = puttSpeed(distM * 1.04, surfaceBall(BALLS.golf, surface).rolling) / c.maxSpeedMS;
    else {
      const carry = distM * (kind === 'wedge' ? 0.93 : 0.86);
      const dh = this.pin.y - start.y;
      const launch = solveSpeed(this.M(carry), c.launchDeg, c.backspin * 0.9, BALLS.golf, this.upm, dh) / this.upm;
      power = launch / (c.maxSpeedMS * surfacePowerFactor(surface, kind));
    }
    power = clamp(power * (1 + this.err(p, 0.12)), 0.05, 1);
    let aimYaw = this.err(p, kind === 'putter' ? 3 : 7);
    const toPin = norm(flat(sub(this.pin, start)));
    aimYaw -= dot(rightOf(toPin), scale(this.wind, 1 / this.upm)) * 0.6 * ai.skill; // vento para a direita: mira à esquerda
    return { club: kind, aimYaw, gesture: { power, angle: 90 + this.err(p, 8), dirX: 0, dirY: 1, hand: 'R', spin: 0, source: 'cpu' } };
  }

  updateHud(h, p, distM, surface) {
    const c = club(this.clubKind);
    const lines = [
      `Buraco ${h + 1}/${this.holes.length}  Par ${this.card.par[h]}`,
      `Vez de ${this.name(this.players[p])}  •  tacada ${this.card.strokesOf(p, h) + 1}`,
      `${c.label}  •  ${distM.toFixed(0)} m  •  ${SURFACE_NAME[surface] || 'Rough'}`,
      `Vento ${(Math.hypot(this.wind.x, this.wind.z) / this.upm).toFixed(1)} m/s`,
      ...this.players.map((s, i) => `${this.name(s)}: ${GolfScorecard.toParText(this.card.toPar(i))} (${this.card.total(i)})`),
    ];
    this.score(lines.join('\n'));
    this.pane('golf_00', 'T_club_00', c.label);
    this.pane('golf_00', 'T_distance_00', distM.toFixed(0));
  }

  *showCard(lastHole, secs) {
    const lines = ['Súmula'];
    this.players.forEach((s, p) => {
      const holes = [];
      for (let h = 0; h <= lastHole; h++) holes.push(this.card.strokesOf(p, h));
      lines.push(`${this.name(s)}: ${holes.join(' ')}  = ${this.card.total(p)} (${GolfScorecard.toParText(this.card.toPar(p))})`);
    });
    this.showLayout('glfScorecard_00');
    this.score(lines.join('\n'));
    yield secs;
    this.showLayout('glfScorecard_00', false);
  }

  buildResult() {
    const r = this.newResult();
    const best = this.card.leader();
    let tie = false;
    this.players.forEach((s, p) => {
      this.addPlayer(r, s, this.card.total(p), `${this.card.total(p)} tacadas (${GolfScorecard.toParText(this.card.toPar(p))})`);
      if (p !== best && this.card.total(p) === this.card.total(best)) tie = true;
    });
    r.winner = tie ? -1 : best;
    r.humanWon = !tie && !!this.players[best].human;
    const key = this.holes.map((h) => h.id).join('-');
    r.records.push({ field: 'GolStandardBest', variant: key, value: this.card.toPar(0), mode: 'lower' });
    let aces = 0;
    for (let h = 0; h < this.card.holes; h++) if (this.card.strokesOf(0, h) === 1) aces++;
    if (aces) r.records.push({ field: 'GolAceCount', value: aces, mode: 'add' });
    r.lines.push(`Par do percurso: ${this.card.par.reduce((a, b) => a + b, 0)}`);
    return r;
  }

  extraState() {
    return {
      hole: this.course ? this.course.id : null,
      pin: [Math.round(this.pin.x), Math.round(this.pin.y * 10) / 10, Math.round(this.pin.z)],
      club: this.clubKind,
      wind: [Math.round(this.wind.x * 10) / 10, Math.round(this.wind.z * 10) / 10],
      card: this.players.map((_, p) => this.card.strokes[p].slice()),
      aim: this.aimLine ? this.aimLine.filter((_, i) => i % 4 === 0).map((q) => [Math.round(q.x), Math.round(q.y), Math.round(q.z)]) : 0,
    };
  }
}
