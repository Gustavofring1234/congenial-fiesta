// Etapa 5: regras puras, física, IA, partidas completas CPU contra CPU, recordes, sincronização da sala e a máquina
// de estados. Roda em Node com o pacote vendor do WEBC (só a colisão BVH do golfe precisa do three.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, mod, json } from './helpers.mjs';

const { store } = await setup();
const { BowlingScore, isSplit, ALL_PINS } = await mod('activities/bowling/BowlingScore.js');
const { BowlingLane } = await mod('activities/bowling/BowlingPhysics.js');
const { TennisScore, TennisEvent } = await mod('activities/tennis/TennisScore.js');
const { TennisCourt } = await mod('activities/tennis/TennisCourt.js');
const { GolfScorecard } = await mod('activities/golf/GolfScorecard.js');
const { CLUBS, suggestClub } = await mod('activities/golf/GolfClubs.js');
const { BaseballGame, PitchResult } = await mod('activities/baseball/BaseballGame.js');
const { plateCrossing, solvePitch } = await mod('activities/baseball/PitchMath.js');
const { BoxingBout, BoutEnd } = await mod('activities/boxing/BoxingBout.js');
const BF = await mod('activities/common/BallFlight.js');
const { BallBody, planeWorld } = await mod('activities/common/BallBody.js');
const AI = await mod('activities/common/AiProfile.js');
const { aiProfile } = await mod('entities/MiiOpponentBuilder.js');
const { SeededRandom } = await mod('activities/common/rng.js');
const { normalizeGesture } = await mod('activities/common/SportActivity.js');
const { GameplayData } = await mod('core/GameplayData.js');
const { RecordStore, memoryStorage } = await mod('core/RecordStore.js');
const { RoomSync, diffSnapshot, applyDelta, interpolate } = await mod('core/RoomSync.js');
const { SportsStateMachine, State } = await mod('core/SportsStateMachine.js');
const { createActivity } = await mod('index.js');
const { GolfActivity } = await mod('activities/golf/GolfActivity.js');
const { MiiEditor, MII_FIELDS, defaultMiiInfo } = await mod('core/MiiEditor.js');
const { CharacterStore } = await mod('core/CharacterStore.js');

const data = await GameplayData.load(store);
const profiles = (await json('Mii/profiles.json')).profiles;
const cpu = (i, skill = 0.6) => ({ profileId: profiles[i].id, name: profiles[i].name, human: false, ai: AI.aiFromMii(profiles[i], skill), info: profiles[i] });
const session = (sport, players, options = {}, seed = 7) => ({ sport, players, options, seed, localIndex: 0 });

// ── dados ────────────────────────────────────────────────────────
test('gameplay_data.json para a web: referencial do Wii (sem espelho), cursos batem com os .pmp', async () => {
  assert.equal(data.json.target, 'web');
  assert.equal(data.unitsPerMeter, 10);
  assert.deepEqual(data.sport('baseball').geometry.firstBaseLine, [1, 0, 0]);
  assert.equal(data.golfCourses.length, 14);
  for (const c of data.golfCourses.slice(0, 4)) {
    const sc = await json('Scenes/' + c.scene);
    const tee = sc.objects.find((o) => o.typeId === 0);
    assert.deepEqual(c.tee.map((v) => Math.round(v)), tee.position.map((v) => Math.round(v)), c.id);
  }
  assert.equal(data.sport('bowling').geometry.npcLaneX.length, 7);
  assert.ok(data.recordFields.includes('BowStandardBest') && data.recordFields.includes('SkillLevel'));
  for (const s of ['tennis', 'baseball', 'bowling', 'golf', 'boxing']) assert.ok(data.available(s), s);
});

// ── regras ───────────────────────────────────────────────────────
test('boliche: 300, todos spares, canaletas, split 7-10 e marcas', () => {
  const p = new BowlingScore();
  for (let i = 0; i < 12; i++) p.roll(0);
  assert.ok(p.isGameOver); assert.equal(p.total, 300); assert.equal(p.frameMarks(9), 'XXX');
  const s = new BowlingScore();
  for (let i = 0; i < 21; i++) s.roll(i % 2 === 0 ? 0b1111100000 : 0);
  assert.equal(s.total, 150); assert.equal(s.frameMarks(0), '5/');
  const g = new BowlingScore();
  for (let i = 0; i < 20; i++) g.roll(g.standingMask);
  assert.equal(g.total, 0); assert.equal(g.frameMarks(3), '--');
  assert.ok(isSplit((1 << 6) | (1 << 9)));   // 7-10
  assert.ok(!isSplit((1 << 1) | (1 << 4)));  // 2-5 juntos
  const o = new BowlingScore().roll((1 << 6) | (1 << 9));
  assert.ok(o.split && o.pins === 8);
});

test('tênis: iguais, vantagem, game, partida com 2 de vantagem, rodízio nas duplas e dupla falta', () => {
  const t = new TennisScore(3, 2, 0);
  for (let i = 0; i < 3; i++) { t.pointTo(0); t.pointTo(1); }
  assert.equal(t.pointText(0), 'Iguais');
  assert.equal(t.pointTo(0), TennisEvent.Advantage);
  assert.equal(t.pointTo(1), TennisEvent.Deuce);
  t.pointTo(0);
  assert.equal(t.pointTo(0), TennisEvent.Game);
  assert.equal(t.servingTeam, 1);
  const win = (team) => { for (let i = 0; i < 4; i++) t.pointTo(team); };
  win(1); win(0); win(1);                  // 2-2
  assert.ok(!t.isMatchOver);
  win(0);                                  // 3-2: falta a vantagem de 2
  assert.ok(!t.isMatchOver);
  win(0);
  assert.equal(t.winner, 0);
  const f = new TennisScore(1);
  assert.equal(f.fault(), false); assert.equal(f.fault(), true); assert.equal(f.points[1], 1);
});

test('quadra de tênis: saque cruzado no referencial do Wii e rebatida que passa a rede', () => {
  const c = new TennisCourt(data.sport('tennis').geometry);
  const sp = c.servePosition(0, 0);
  assert.ok(sp.x > 0, 'deuce: o time 0 (olhando -Z) saca da direita, +X');
  const box = c.serviceBoxCenter(1, 0);
  assert.ok(box.x < 0 && box.z < 0, 'caixa cruzada no outro lado');
  assert.ok(c.inServiceBox(box, 1, 0) && !c.inServiceBox({ x: -box.x, y: 0, z: box.z }, 1, 0));
  const from = { x: 0, y: 10, z: 110 }, aim = { x: -20, y: 0, z: -90 };
  const v = c.solveShot(from, aim, 300, 120, BF.BALLS.tennis, 0.35);
  const ax = BF.backspinAxis(v), spin = { x: -120 * ax.x, y: -120 * ax.y, z: -120 * ax.z };   // topspin 120
  assert.ok(c.clearsNet(from, v, spin, BF.BALLS.tennis, 0.35));
  const land = BF.predictLanding(from, v, spin, { x: 0, y: 0, z: 0 }, BF.BALLS.tennis, 10, 0.35).point;
  assert.ok(Math.abs(land.z - aim.z) < 25 && Math.abs(land.x - aim.x) < 10);
});

test('golfe: súmula, limite de tacadas, nomes e taco do caddie', () => {
  const g = new GolfScorecard([4, 3], 2, 10);
  g.addStroke(0, 0); g.addStroke(0, 0); g.addStroke(0, 0); g.hole(0, 0);
  assert.equal(g.toPar(0), -1); assert.equal(GolfScorecard.toParText(g.toPar(0)), '-1');
  for (let i = 0; i < 9; i++) assert.equal(g.addStroke(1, 0), false);
  assert.equal(g.addStroke(1, 0, 1), true); assert.equal(g.strokesOf(1, 0), 10);
  assert.ok(g.holeComplete(0));
  assert.equal(GolfScorecard.resultName(1, 3), 'Hole in one!');
  assert.equal(GolfScorecard.resultName(3, 5), 'Eagle');
  assert.equal(suggestClub(300, 'tee', true), 'driver');
  assert.equal(suggestClub(5, 'green', false), 'putter');
  assert.equal(suggestClub(60, 'bunker', false), 'wedge');
});

test('beisebol: walk forçado, grand slam, queimada dupla, sacrifício, walk-off e entradas extras limitadas', () => {
  const b = new BaseballGame(1);
  for (let k = 0; k < 3; k++) for (let i = 0; i < 4; i++) b.apply(PitchResult.Ball);
  assert.equal(b.bases, 7);
  assert.equal(b.apply(PitchResult.HomeRun), 4);
  b.apply(PitchResult.Single);
  b.apply(PitchResult.DoublePlay);
  assert.equal(b.outs, 2); assert.equal(b.bases, 0);
  b.apply(PitchResult.Triple);
  b.markSacrificeFly();
  assert.equal(b.apply(PitchResult.Out), 0, 'sacrifício só com menos de 2 eliminações');
  assert.ok(b.bottom);
  b.apply(PitchResult.HomeRun); b.apply(PitchResult.HomeRun); b.apply(PitchResult.HomeRun); b.apply(PitchResult.HomeRun);
  assert.ok(!b.isGameOver);
  b.apply(PitchResult.HomeRun);
  assert.ok(b.isGameOver, 'walk-off'); assert.equal(b.winner, 1);
  const e = new BaseballGame(1);
  for (let half = 0; half < 8; half++) for (let o = 0; o < 9; o++) if (!e.isGameOver) e.apply(PitchResult.CalledStrike);
  assert.ok(e.isGameOver); assert.equal(e.winner, -1); assert.equal(e.inning, 3);
});

test('boxe: quedas, nocaute técnico, decisão e contagem reproduzível pela semente', () => {
  const b = new BoxingBout(3, 60, 5);
  let downs = 0;
  while (!b.isOver && downs < 3) { if (b.land(0, 40)) { downs++; if (!b.isOver) b.resolveCount(); } }
  assert.ok(b.isOver);
  assert.ok(b.end === BoutEnd.TKO || b.end === BoutEnd.KO);
  assert.equal(b.winner, 0);
  const d = new BoxingBout(1, 5, 1);
  d.land(1, 12); d.land(0, 3);
  while (!d.isOver) d.tick(0.5);
  assert.equal(d.end, BoutEnd.Decision); assert.equal(d.winner, 1);
  const run = (s) => { const x = new BoxingBout(3, 60, s); x.land(0, 100); return x.resolveCount(); };
  assert.equal(run(42), run(42));
});

// ── física ───────────────────────────────────────────────────────
test('voo da bola: carry dos tacos calibrado (206/144/88 m) e backspin sustenta', () => {
  const carry = (c, spin = c.backspin) => {
    const l = (c.launchDeg * Math.PI) / 180, v = c.maxSpeedMS * 10;
    const dir = { x: 0, y: 0, z: -1 };
    const ax = BF.backspinAxis(dir);
    return -BF.predictLanding({ x: 0, y: 0, z: 0 }, { x: 0, y: Math.sin(l) * v, z: -Math.cos(l) * v }, { x: ax.x * spin, y: 0, z: ax.z * spin }, { x: 0, y: 0, z: 0 }, BF.BALLS.golf, 10, 0).point.z / 10;
  };
  const [dr, ir, we] = CLUBS;
  assert.ok(Math.abs(carry(dr) - 206) < 4, `driver ${carry(dr)}`);
  assert.ok(Math.abs(carry(ir) - 144) < 4, `ferro ${carry(ir)}`);
  assert.ok(Math.abs(carry(we) - 88) < 4, `wedge ${carry(we)}`);
  assert.ok(carry(dr) > carry(dr, 0) + 10, 'sem backspin cai antes');
  const v = BF.solveSpeed(1500, 12, 280, BF.BALLS.golf, 10);
  assert.ok(Math.abs(-BF.predictLanding({ x: 0, y: 0, z: 0 }, { x: 0, y: Math.sin(0.2094) * v, z: -Math.cos(0.2094) * v }, { x: 280, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, BF.BALLS.golf, 10, 0).point.z - 1500) < 20);
});

test('arremesso: mira iterativa cruza a base no alvo com qualquer spin', () => {
  const cf = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }, home = { x: 0, y: 0, z: 0 };
  const rel = { x: cf.x * 184.4, y: 19, z: cf.z * 184.4 };
  for (const spin of [{ x: 0, y: 0, z: 0 }, { x: 0, y: -170, z: 0 }, { x: -120, y: 60, z: 120 }]) {
    const tgt = { x: 1.5, y: 8, z: -1.5 };
    const v = solvePitch(rel, tgt, 380, spin, home, cf, BF.BALLS.baseball, 10);
    const at = plateCrossing(rel, v, spin, home, cf, BF.BALLS.baseball, 10).point;
    assert.ok(Math.hypot(at.x - tgt.x, at.y - tgt.y, at.z - tgt.z) < 0.2);
  }
});

test('corpo da bola: quica no plano, rola e para; quique perde energia', () => {
  const b = new BallBody({ params: BF.BALLS.tennis, world: planeWorld(0), radius: 0.35, restSpeed: 2 });
  let bounces = 0;
  b.onBounce = () => bounces++;
  b.launch({ x: 0, y: 20, z: 0 }, { x: 0, y: 0, z: -40 });
  for (let i = 0; i < 60 * 30 && b.simulating; i++) b.update(1 / 60);
  assert.ok(bounces >= 3); assert.ok(b.atRest); assert.ok(Math.abs(b.pos.y - 0.35) < 0.05);
});

test('pista de boliche: bolso derruba 10, bola na canaleta não derruba nada', () => {
  const roll = (x, tx, spin = 0) => {
    const L = new BowlingLane(data.sport('bowling').geometry);
    L.resetPins(ALL_PINS);
    L.release(x, (Math.atan2(tx - x, 4 - L.headPinZ) * 180) / Math.PI, 8, spin);
    for (let t = 0, settle = 0; t < 10 && settle < 1.2; t += 1 / 60) { L.update(1 / 60); if (L.ball.done) settle = L.moving ? 0 : settle + 1 / 60; }
    return 10 - [...Array(10)].filter((_, i) => (L.standingMask() >> i) & 1).length;
  };
  assert.ok([0.5, 0.75, 1].map((tx) => roll(1.5, tx)).includes(10), 'algum arremesso no bolso 1-3 é strike');
  assert.equal(roll(9, 14), 0);
  assert.ok(roll(1.5, 0) >= 5);
});

// ── IA ───────────────────────────────────────────────────────────
test('perfil de IA igual ao do MiiOpponentBuilder e Elo da habilidade', () => {
  for (const p of profiles.slice(0, 10)) {
    const a = AI.aiFromMii(p, 0.7), b = aiProfile(p, 0.7);
    assert.ok(Math.abs(a.power - b.power) < 1e-9 && Math.abs(a.speed - b.speed) < 1e-9 && Math.abs(a.accuracy - b.accuracy) < 1e-9);
    assert.ok(a.reach >= 0.85 && a.reach <= 1.15);
  }
  assert.equal(AI.skillDelta(1000, 0.5, 0.5), 0);
  assert.equal(AI.skillDelta(0, 0, 1), 30);
  assert.ok(AI.skillDelta(0, 0.9, 1) > AI.skillDelta(0, 0.1, 1));
  assert.ok(AI.skillForOpponent(2000, 0) > AI.skillForOpponent(0, 0));
  const r1 = new SeededRandom(3), r2 = new SeededRandom(3);
  assert.equal(r1.gaussian(), r2.gaussian());
  const g = normalizeGesture({ force: 0.8, speed: 1.6, dir: { x: 1, y: 0 } });
  assert.equal(g.power, 1.3); assert.equal(g.angle, 0);
});

// ── partidas completas ───────────────────────────────────────────
const play = (sport, players, options, seed = 7, extra = {}) => {
  const a = createActivity(session(sport, players, options, seed), data, extra);
  const ev = [];
  a.on((e) => ev.push(e));
  const r = a.simulate({ maxSeconds: 4000 });
  return { a, r, ev };
};

test('boliche CPU x CPU: 10 quadros, resultado e recordes; mesma semente = mesma partida', () => {
  const { r, a } = play('bowling', [cpu(0, 0.9), cpu(1, 0.3)], { bowlingFrames: 10 });
  assert.ok(r && !r.aborted); assert.equal(r.players.length, 2);
  assert.ok(a.scores.every((s) => s.isGameOver));
  assert.ok(r.players[0].score > 30 && r.players[0].score <= 300);
  assert.ok(r.records.some((x) => x.field === 'BowStandardBest'));
  const again = play('bowling', [cpu(0, 0.9), cpu(1, 0.3)], { bowlingFrames: 10 });
  assert.deepEqual(again.r.players.map((p) => p.score), r.players.map((p) => p.score));
});

test('tênis CPU x CPU (simples e duplas) termina com vencedor e trocas de bola', () => {
  for (const doubles of [false, true]) {
    const ps = doubles ? [cpu(0), cpu(1), cpu(2), cpu(3)] : [cpu(0), cpu(1)];
    const { r, ev, a } = play('tennis', ps, { tennisGames: 1, tennisDoubles: doubles });
    assert.ok(r.winner === 0 || r.winner === 1);
    assert.ok(ev.filter((e) => e.type === 'hit').length > a.scoreRules.pointsPlayed, 'houve troca de bola');
  }
});

test('beisebol CPU x CPU: 3 entradas com placar coerente', () => {
  const { r, a, ev } = play('baseball', [cpu(0), cpu(1)], { baseballInnings: 3 }, 12);
  assert.ok(a.game.isGameOver);
  assert.equal(r.players[0].score, a.game.runs[0]);
  assert.ok(ev.some((e) => e.type === 'pitch'));
  assert.ok(r.records.some((x) => x.field === 'BsbRenzokuBest'));
});

test('boxe CPU x CPU: o mais forte vence com mais frequência', () => {
  let strongWins = 0;
  for (let s = 1; s <= 6; s++) { const { r } = play('boxing', [cpu(0, 0.95), cpu(1, 0.15)], { boxingRounds: 3 }, s); if (r.winner === 0) strongWins++; }
  assert.ok(strongWins >= 4, `venceu ${strongWins}/6`);
});

test('golfe CPU x CPU num curso real (colisão BVH do fc3): termina, sem bola perdida no chão', async () => {
  const a = createActivity(session('golf', [cpu(0, 0.8), cpu(1, 0.8)], { golfHoles: ['fc3'] }, 3), data, { loadWorld: (c) => GolfActivity.courseWorld(store, c) });
  a.start();
  for (let i = 0; i < 60 * 900 && !a.finished; i++) { a.update(1 / 60); if (i % 300 === 0) await new Promise((r) => setTimeout(r, 0)); }
  assert.ok(a.finished, 'partida terminou');
  for (let p = 0; p < 2; p++) { assert.ok(a.card.isHoled(p, 0)); assert.ok(a.card.strokesOf(p, 0) >= 1 && a.card.strokesOf(p, 0) <= 10); }
});

test('jogador humano: gesto local entra na partida (boliche) e a mira acompanha os controles', () => {
  const me = { profileId: 'vrm', name: 'Eu', human: true, local: true, ai: AI.aiFromMii(profiles[5], 0.6) };
  const a = createActivity(session('bowling', [me], { bowlingFrames: 1 }), data);
  a.start();
  for (let i = 0; i < 200; i++) a.update(1 / 60);
  assert.equal(a.gestureKind, 'throw');
  a.setControls(0, { move: { x: 1, y: 0 }, aim: { x: 0.2, y: 0 } });
  for (let i = 0; i < 30; i++) a.update(1 / 60);
  assert.ok(a.aim.visible && a.aim.x > 1.5);
  for (let k = 0; k < 2 && !a.finished; k++) {
    a.pushGesture(0, { force: 0.8, speed: 1, dir: { x: 0, y: 1 }, source: 'teste' });
    for (let i = 0; i < 60 * 15 && !a.finished && a.scores[0].rolls.length === k; i++) a.update(1 / 60);
    for (let i = 0; i < 60 * 4 && !a.finished; i++) { a.update(1 / 60); if (a.gestureKind === 'throw' && a.pending.size === 0 && a.aim.visible) break; }
  }
  assert.ok(a.scores[0].rolls.length >= 1);
});

// ── recordes ─────────────────────────────────────────────────────
test('recordes: maior/menor/soma, campos do RPSportsPlayerData e habilidade por Elo', () => {
  const R = new RecordStore({ fields: data.recordFields, storage: memoryStorage(), indexedDB: null });
  assert.equal(R.submit('ana', { field: 'BowStandardBest', value: 120, mode: 'higher' }), true);
  assert.equal(R.submit('ana', { field: 'BowStandardBest', value: 100, mode: 'higher' }), false);
  assert.equal(R.get('ana', 'BowStandardBest'), 120);
  assert.equal(R.submit('ana', { field: 'GolStandardBest', variant: 'fc1', value: 2, mode: 'lower' }), true);
  assert.equal(R.submit('ana', { field: 'GolStandardBest', variant: 'fc1', value: -1, mode: 'lower' }), true);
  R.submit('ana', { field: 'GolAceCount', value: 1, mode: 'add' }); R.submit('ana', { field: 'GolAceCount', value: 1, mode: 'add' });
  assert.equal(R.get('ana', 'GolAceCount'), 2);
  assert.equal(R.submit('ana', { field: 'CampoInventado', value: 1 }), false);
  const sess = { sport: 'boxing', players: [{ human: true }, { human: false, ai: { skill: 0.5 } }] };
  const out = R.submitResult('ana', { winner: 0, humanWon: true, records: [] }, sess);
  assert.ok(out.skillDelta > 0); assert.equal(R.skill('ana', 'boxing'), out.skill);
  assert.equal(R.get('ana', 'StandardPlayCount'), 1);
  assert.ok(R.all('ana')['BowStandardBest'] === 120);
});

// ── sala ─────────────────────────────────────────────────────────
test('sala: delta contra o quadro-chave e interpolação pelo relógio', () => {
  const k = { a: [[1, 0, 0, 0, 0, 'w', 0]], b: [[0, 0, 0, 0, 0, 0]], h: ['x', ''] };
  const s = { a: [[1, 10, 0, 0, 1, 'w', 0]], b: [[0, 4, 0, 0, 0, 0]], h: ['x', ''] };
  const d = diffSnapshot(k, s);
  assert.ok(!('h' in d));
  assert.deepEqual(applyDelta(k, d), s);
  const mid = interpolate(k, s, 0.5);
  assert.equal(mid.a[0][1], 5); assert.equal(mid.b[0][1], 2); assert.equal(mid.a[0][4], 0.5);
});

test('sala: anfitrião autoritativo publica "sp" sem quebrar o estado e recebe os gestos do convidado', () => {
  let clock = 1000;
  const fakeSala = (id) => ({ eu: { id }, remotos: new Map(), meuEstado: () => ({ p: [1, 2, 3], r: 0, e: 'parado', emo: 'neutra', g: null, c: 0 }) });
  const salaA = fakeSala('A'), salaB = fakeSala('B');
  const host = new RoomSync({ sala: salaA, clock: () => clock }).attach();
  const guest = new RoomSync({ sala: salaB, clock: () => clock }).attach();
  // cada lado vê o outro como Remoto (receber(j) com j.estado)
  const remote = (id, sala) => ({ id, receber(j) { return j; } });
  salaA.remotos.set('B', remote('B', salaA)); salaB.remotos.set('A', remote('A', salaB));
  host.update(); guest.update();
  const human = { profileId: 'x', name: 'Convidado', human: true, remote: 'B', ai: AI.aiFromMii(profiles[2], 0.6) };
  const act = createActivity(session('bowling', [cpu(0), human], { bowlingFrames: 1 }), data);
  host.host({ sport: 'bowling', options: {}, seed: 7 });
  let opened = null;
  guest.onLobby = (lb, peer, matchId) => { opened = { lb, peer, matchId }; };
  const trade = () => {
    const ea = salaA.meuEstado(), eb = salaB.meuEstado();
    assert.deepEqual(ea.p, [1, 2, 3], 'campos originais preservados');
    salaB.remotos.get('A').receber({ estado: ea, nome: 'Anfitrião' });
    salaA.remotos.get('B').receber({ estado: eb, nome: 'Convidado' });
  };
  trade();
  assert.ok(opened && opened.lb.sport === 'bowling');
  let joined = null;
  host.onJoin = (peer, name) => { joined = peer; host.admit(peer, name, 1); };
  guest.join(opened.peer, opened.matchId);
  trade();
  assert.equal(joined, 'B');
  host.startMatch(act);
  act.start();
  for (let f = 0; f < 120; f++) { act.update(1 / 60); clock += 1 / 60; if (f % 7 === 0) { host.update(); trade(); } }
  assert.ok(salaA.meuEstado().sp.k || salaA.meuEstado().sp.d);
  clock += 0.5;
  const view = guest.view();
  assert.ok(view && view.k === 'bowling' && Array.isArray(view.a));
  // o convidado faz um gesto: chega na partida do anfitrião no índice dele
  guest.sendGesture({ power: 0.9, angle: 90, dirX: 0, dirY: 1, hand: 'R' });
  trade();
  assert.ok(act.pending.has(1) || act.scores[1].rolls.length > 0 || act.current !== 1);
});

// ── máquina de estados ───────────────────────────────────────────
test('máquina de estados: Boot -> menus -> partida -> resultado -> recordes, com pausa e saída', async () => {
  const R = new RecordStore({ fields: data.recordFields, storage: memoryStorage(), indexedDB: null });
  const chars = new CharacterStore({ storage: memoryStorage(), indexedDB: null });
  const m = new SportsStateMachine({ data, records: R, profiles, player: 'p1', playerName: 'P1', characters: chars, createActivity: (s) => createActivity(s, data), seed: () => 9 });
  const seen = [];
  m.on((st) => seen.push(st));
  m.go(State.Boot);
  m.menu.items[0].select();
  assert.equal(m.state, State.MainMenu);
  m.menu.items.find((i) => i.id === 'play').select();
  assert.equal(m.state, State.SportSelect);
  assert.equal(m.menu.items.length, 5);
  m.menu.items.find((i) => i.id === 'bowling').select();
  assert.equal(m.state, State.Options);
  m.menu.items.find((i) => i.id === 'frames').adjust(-1);
  assert.equal(m.options.bowlingFrames, 5);
  m.menu.items.find((i) => i.id === 'start').select();
  // antes de toda partida: qual personagem usar
  assert.equal(m.state, State.CharacterChoice);
  assert.deepEqual(m.menu.items.map((i) => i.id), ['saved', 'create']);
  m.menu.items.find((i) => i.id === 'create').select();
  assert.equal(m.state, State.CharacterCreator);
  m.menu.items.find((i) => i.id === 'hair.type').adjust(1);
  m.menu.items.find((i) => i.id === 'name').onInput('Teste');
  m.menu.items.find((i) => i.id === 'confirm').select();
  await new Promise((r) => setTimeout(r, 0));   // salvar o Mii é assíncrono
  assert.equal(m.state, State.Playing);
  assert.equal(m.session.players[0].miiInfo.name, 'Teste');
  m.session.players[0].human = false;  // a CPU joga por você
  m.update(1 / 60);
  m.back();
  assert.equal(m.state, State.Paused);
  m.menu.items.find((i) => i.id === 'continue').select();
  for (let i = 0; i < 60 * 3000 && m.state === State.Playing; i++) m.update(1 / 60);
  assert.equal(m.state, State.Results);
  assert.ok(m.menu.lines.length >= 2);
  assert.equal(R.get('p1', 'StandardPlayCount'), 1);
  m.menu.items.find((i) => i.id === 'records').select();
  assert.equal(m.state, State.Records);
  assert.ok(m.recordLines().some((l) => /Partidas: 1/.test(l)));
  // sair da partida pela pausa volta para a seleção sem gravar
  m.go(State.SportSelect); m.menu.items.find((i) => i.id === 'boxing').select(); m.menu.items.find((i) => i.id === 'start').select();
  assert.equal(m.state, State.CharacterChoice);
  m.menu.items.find((i) => i.id === 'keep').select();          // o personagem da partida anterior
  assert.equal(m.state, State.Playing);
  m.back(); m.menu.items.find((i) => i.id === 'quit').select();
  assert.equal(m.state, State.SportSelect);
  assert.equal(R.get('p1', 'StandardPlayCount'), 1);
  assert.ok(seen.includes(State.Paused) && seen.includes(State.Records));
});

// ── personagem antes da partida ─────────────────────────────────
test('editor estilo Wii: faixas das peças, passos circulares, nome e cópia para guardar', () => {
  const e = new MiiEditor(defaultMiiInfo(1, 'Ana'));
  assert.equal(e.info.sex, 1);
  e.set('hair.type', 71); e.step('hair.type', 1);
  assert.equal(e.get('hair.type'), 0, 'cabelo dá a volta (72 peças)');
  e.set('height', 127); e.step('height', 1);
  assert.equal(e.get('height'), 127, 'altura tem limite');
  assert.equal(e.valueText('glass.type'), 'Sem óculos');
  assert.ok(e.setName('NomeMuitoComprido!'));
  assert.equal(e.info.name.length, 10);
  for (const f of MII_FIELDS) { e.set(f.id, f.max + 5); assert.equal(e.get(f.id), f.max, f.id); }
  e.randomize(new SeededRandom(4).next.bind(new SeededRandom(4)));
  const info = e.toInfo();
  assert.ok(info.name && info.hair && info.faceline && info.beard);
  assert.ok(AI.aiFromMii({ id: 'x', info }, 0.5).power > 0);
});

test('personagens salvos: Mii criado, .vrm importado (assinatura glTF), lista do WEBC e escolha na máquina', async () => {
  const webc = { listar: async () => [{ id: 'p1', nome: 'VRoid da Loja', tipo: 'vrm', criado: 1 }, { id: 'p2', nome: 'Live2D', tipo: 'live2d' }], ler: async () => ({ roupaAtual: 'r1', roupas: [{ id: 'r1', blob: new Blob(['glTF']) }] }) };
  const S = new CharacterStore({ storage: memoryStorage(), indexedDB: null, webc });
  const mii = await S.saveMii(defaultMiiInfo(0, 'Leo'));
  const vrm = await S.importVrm(new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])]), 'meu.vrm');
  await assert.rejects(S.importVrm(new Blob(['nada'])), /vrm/);
  const list = await S.list();
  assert.deepEqual(list.map((e) => e.kind).sort(), ['mii', 'vrm', 'vrm']);
  assert.ok(list.some((e) => e.source === 'webc' && e.name === 'VRoid da Loja'));
  assert.ok(!list.some((e) => e.name === 'Live2D'), 'só os .vrm do WEBC');
  assert.equal((await S.vrmBlob(vrm)).size, 8);
  assert.equal(await (await S.vrmBlob(list.find((e) => e.source === 'webc'))).text(), 'glTF');
  // na máquina: Opções -> Começar -> salvos -> escolhe o Mii -> partida
  const R = new RecordStore({ fields: data.recordFields, storage: memoryStorage(), indexedDB: null });
  const m = new SportsStateMachine({ data, records: R, profiles, characters: S, createActivity: (s) => createActivity(s, data), seed: () => 3 });
  m.go(State.SportSelect); m.menu.items.find((i) => i.id === 'tennis').select(); m.menu.items.find((i) => i.id === 'start').select();
  m.menu.items.find((i) => i.id === 'saved').select();
  assert.equal(m.state, State.SavedCharacters);
  for (let i = 0; i < 20 && m.savedList === null; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(m.menu.items.some((i) => i.id === 'import' && i.file));
  m.menu.items.find((i) => i.id === 'char:' + mii.key).select();
  assert.equal(m.state, State.Playing);
  assert.equal(m.session.players[0].name, 'Leo');
  assert.equal(m.session.players[0].character.kind, 'mii');
  m.activity.abort();
  // importar direto da tela entra na partida com o .vrm
  m.go(State.SportSelect); m.menu.items.find((i) => i.id === 'bowling').select(); m.menu.items.find((i) => i.id === 'start').select();
  m.menu.items.find((i) => i.id === 'saved').select();
  await m.importVrm(new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46])]));
  assert.equal(m.state, State.Playing);
  assert.equal(m.session.players[0].character.kind, 'vrm');
});
