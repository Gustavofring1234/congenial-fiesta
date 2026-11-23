// Boxe (RPBoxScene), porte de Activities/Boxing/BoxingActivity.cs, no ringue MainGame (box_ring, 7,4 m). Soco pelo
// gesto "strike": a mão vem do lado do gesto (ou da mão vista pela câmera), para cima = uppercut, lateral = cruzado
// (hook), o resto = direto (jab fraco / straight forte); força = velocidade. Para baixo (ou guarda) = guarda alta,
// < > = esquiva. A guarda segura diretos e cruzados, o uppercut passa por dentro; a esquiva evita diretos e uppercuts
// (o cruzado pega quem esquiva para o lado dele); golpe no contra-ataque vale ×1,4.
import { SportActivity } from '../common/SportActivity.js';
import { v3, add, sub, scale, lerp, clamp, clamp01 } from '../common/vec3.js';
import { BoxingBout, MAX_HEALTH, BoutEnd } from './BoxingBout.js';

const WINDUP = { jab: 0.12, straight: 0.18, hook: 0.24, upper: 0.26 };
const RECOVERY = { jab: 0.18, straight: 0.28, hook: 0.36, upper: 0.36 };
const DAMAGE = { jab: 5, straight: 8, hook: 10, upper: 11 };
const ANIM = {
  jab: ['box_punch_jab_L', 'box_punch_jab_R'], straight: ['box_punch_straight_l_R', 'box_punch_straight_r_R'],
  hook: ['box_punch_hook_l_R', 'box_punch_hook_r_R'], upper: ['box_punch_upper_l_R', 'box_punch_upper_r_R'],
};

export class BoxingActivity extends SportActivity {
  constructor(o) {
    super(o);
    this.bout = new BoxingBout(clamp(this.session.options.boxingRounds || 3, 1, 5), this.session.options.boxingRoundSeconds || 60, this.rng);
    this.ringHalf = (this.sport.geometry && this.sport.geometry.ringHalfSize) || 36.9;
    this.f = [];
    this.gestureKind = 'strike';
  }

  slot(i) { return i === 0 ? this.players[0] : this.players[Math.min(1, this.players.length - 1)]; }

  *run() {
    const bout = this.bout;
    this.title('Boxe');
    this.showLayout('boxGauge_00');
    for (let i = 0; i < 2; i++) {
      const home = v3(0, 0, i === 0 ? this.M(0.85) : -this.M(0.85));
      const a = this.spawnActor(this.slot(i), home, v3(0, 0, i === 0 ? -1 : 1), i);
      a.attach('wrist_l', 'box_glove_L');
      a.attach('wrist_r', 'box_glove_R');
      a.play('box_wait1R', this.time);
      this.f.push({ index: i, p: i === 0 ? 0 : Math.min(1, this.players.length - 1), actor: a, slot: this.slot(i), stance: 'idle', until: 0, punch: 'jab', right: true, power: 0, next: 0, home });
    }
    this.sfx('crowd', 0.5);
    this.cue('SE_TR_Common_Sports_Game_Start');
    while (!bout.isOver) {
      const round = bout.round;
      this.resetFighters();
      yield this.banner(`Round ${round}`, 1.4);
      yield this.banner('Lute!', 0.6);
      this.emit('bell', { round });
      while (!bout.isOver && bout.round === round) {
        this.control(this.f[0], this.f[1]);
        this.control(this.f[1], this.f[0]);
        this.updateFighter(this.f[0], this.f[1]);
        this.updateFighter(this.f[1], this.f[0]);
        this.updateCamera();
        this.updateHud();
        if (bout.downFighter >= 0) yield* this.knockdown();
        else bout.tick(this.dt);
        yield;
      }
      if (!bout.isOver) yield this.banner(`Fim do round ${round}`, 1.6);
    }
    this.cue('SE_TR_Common_Sports_Game_End');
    yield this.banner(this.endText(), 2.8);
    this.finish(this.buildResult());
  }

  resetFighters() {
    for (const fi of this.f) {
      fi.actor.pos = { ...fi.home };
      fi.stance = 'idle';
      fi.actor.play('box_wait1R', this.time);
      fi.next = this.time + 1;
    }
  }

  control(me, foe) {
    if (this.isHuman(me.p) && me.slot.human) this.humanControl(me); else this.cpuControl(me, foe);
  }

  humanControl(me) {
    if (me.stance === 'down' || me.stance === 'stunned') { this.clearGesture(me.p); return; }
    const busy = me.stance === 'windup' || me.stance === 'recover';
    this.gestureKind = 'strike';
    if (!busy) {
      const g = this.takeGesture(me.p);
      if (g) {
        const type = g.dirY > 0.75 ? 'upper' : Math.abs(g.dirX) > 0.8 ? 'hook' : g.power < 0.6 ? 'jab' : 'straight';
        const right = g.source === 'camera' ? g.hand === 'R' : g.dirX >= 0;
        this.startPunch(me, type, right, g.power);
        return;
      }
    }
    if (busy) return;
    const c = this.controlsOf(me.p);
    this.setDefense(me, c.guard || c.move.y < -0.5 ? 'guard' : c.move.x < -0.5 ? 'weaveLeft' : c.move.x > 0.5 ? 'weaveRight' : 'idle');
  }

  setDefense(fi, s) {
    if (fi.stance === s) return;
    fi.stance = s;
    if (s === 'guard') fi.actor.play('box_c_shadowR', this.time);
    else if (s === 'weaveLeft' || s === 'weaveRight') { fi.actor.play('box_c_weaveR', this.time); this.fx('Box_afterimage02', add(fi.actor.pos, v3(0, this.M(1.2), 0))); }
    else fi.actor.play('box_wait1R', this.time);
  }

  cpuControl(me, foe) {
    if (me.stance === 'down' || me.stance === 'stunned' || me.stance === 'windup' || me.stance === 'recover') return;
    if (this.time < me.next) return;
    const ai = me.slot.ai;
    const rng = this.rng;
    me.next = this.time + Math.max(0.12, ai.reaction + rng.next() * 0.35);
    const healthRatio = this.bout.health[me.index] / MAX_HEALTH;
    // lê o golpe do adversário com chance pela habilidade
    if (foe.stance === 'windup' && rng.chance(0.25 + 0.6 * ai.skill)) {
      if (foe.punch === 'upper') this.setDefense(me, rng.chance(0.5) ? 'weaveLeft' : 'weaveRight');
      else if (foe.punch === 'hook') this.setDefense(me, 'guard');
      else this.setDefense(me, rng.chance(0.5) ? 'guard' : rng.chance(0.5) ? 'weaveLeft' : 'weaveRight');
      return;
    }
    // contra-ataque quando o adversário se recupera
    const opening = foe.stance === 'recover' || foe.stance === 'stunned';
    const attack = (opening ? 0.75 : 0.3) * (0.5 + ai.aggression) * (healthRatio < 0.3 ? 0.7 : 1);
    if (rng.chance(attack)) {
      const r = rng.next();
      const t = foe.stance === 'guard' ? (r < 0.6 ? 'upper' : 'hook') : r < 0.35 ? 'jab' : r < 0.65 ? 'straight' : r < 0.85 ? 'hook' : 'upper';
      this.startPunch(me, t, rng.chance(0.5 + ai.sideBias * 0.2), 0.6 + 0.6 * ai.power);
      return;
    }
    this.setDefense(me, rng.chance(0.25 + (1 - healthRatio) * 0.4) ? 'guard' : 'idle');
  }

  startPunch(me, type, right, power) {
    me.stance = 'windup';
    me.punch = type;
    me.right = right;
    me.power = clamp(power, 0.2, 1.5);
    me.until = this.time + WINDUP[type];
    me.actor.play(ANIM[type][right ? 1 : 0], this.time);
    this.bout.throwPunch(me.index);
    this.sfx('whoosh', 0.35 + 0.3 * me.power);
    const color = me.index === 0 ? 'blue' : 'red';
    this.fx(type === 'jab' ? `Box_glovetail01_${color}` : `Box_glovetail02_${color}`, add(me.actor.pos, v3(0, this.M(1.3), 0)));
  }

  updateFighter(me, foe) {
    const dt = this.dt;
    const offset = me.stance === 'weaveLeft' ? scale(me.actor.right, -this.M(0.35)) : me.stance === 'weaveRight' ? scale(me.actor.right, this.M(0.35)) : v3();
    if (me.stance !== 'down') me.actor.pos = lerp(me.actor.pos, add(me.home, offset), 1 - Math.exp(-14 * dt));
    if (me.stance === 'windup' && this.time >= me.until) {
      this.resolve(me, foe);
      if (me.stance === 'windup') { me.stance = 'recover'; me.until = this.time + RECOVERY[me.punch]; }
    } else if ((me.stance === 'recover' || me.stance === 'stunned') && this.time >= me.until) {
      me.stance = 'idle';
      me.actor.play('box_wait1R', this.time);
    }
    if (this.bout.health[me.index] < 30 && this.rng.chance(dt * 0.5)) this.fx('Box_sweat_1time01', add(me.actor.pos, v3(0, this.M(1.6), 0)));
  }

  resolve(atk, def) {
    const head = add(def.actor.pos, v3(0, this.M(1.5), 0));
    const weaving = def.stance === 'weaveLeft' || def.stance === 'weaveRight';
    if (weaving) {
      // esquiva evita diretos e uppercuts; o cruzado pega quem esquiva para o lado de onde ele vem
      const hookSide = atk.punch === 'hook' && (def.stance === 'weaveLeft') === atk.right;
      if (!hookSide) {
        this.emit('banner', { text: def.index === 0 ? 'Esquivou!' : 'Ele esquivou', seconds: 0.6 });
        atk.stance = 'recover';
        atk.until = this.time + RECOVERY[atk.punch] + 0.15;  // golpe no vazio desequilibra
        this.emit('punch', { attacker: atk.index, punch: atk.punch, outcome: 'dodge' });
        return;
      }
    }
    const power = atk.power * (atk.slot.ai && !atk.slot.human ? 0.8 + 0.4 * atk.slot.ai.power : 1);
    let dmg = DAMAGE[atk.punch] * (0.6 + 0.6 * power);
    const color = def.index === 0 ? 'blue' : 'red';
    if (def.stance === 'guard' && atk.punch !== 'upper') {
      dmg *= 0.15;
      this.fx(`Box_guard01_${color}`, head);
      this.impact(0.35, 0.2, 140);
      atk.stance = 'recover';
      atk.until = this.time + RECOVERY[atk.punch] + 0.1;
      this.bout.land(atk.index, dmg);
      this.emit('punch', { attacker: atk.index, punch: atk.punch, outcome: 'blocked', damage: Math.round(dmg * 10) / 10 });
      return;
    }
    const counter = def.stance === 'windup' || def.stance === 'recover';
    if (counter) dmg *= 1.4;
    if (def.stance === 'guard') dmg *= 0.8;      // uppercut por dentro da guarda
    const level = dmg > 13 ? 4 : dmg > 10 ? 3 : dmg > 6 ? 2 : 1;
    this.fx(`Box_hit0${level}_${atk.index === 0 ? 'blue' : 'red'}`, head);
    this.impact(clamp01(dmg / 16), 0.3, 110);
    if (counter) this.emit('banner', { text: 'Contra-ataque!', seconds: 0.7 });
    const down = this.bout.land(atk.index, dmg);
    def.actor.setExpression('angry');
    this.emit('punch', { attacker: atk.index, punch: atk.punch, outcome: counter ? 'counter' : 'hit', damage: Math.round(dmg * 10) / 10 });
    // golpe forte atordoa e interrompe o golpe do defensor
    if (down) { def.stance = 'down'; def.actor.play('box_down1R', this.time); }
    else if (dmg > 9 || counter) { def.stance = 'stunned'; def.until = this.time + 0.35 + dmg * 0.02; }
  }

  *knockdown() {
    const bout = this.bout, who = bout.downFighter, fi = this.f[who];
    fi.stance = 'down';
    fi.actor.play('box_down1R', this.time);
    fi.actor.setExpression('sad');
    this.fx('Box_indistinct01', add(fi.actor.pos, v3(0, this.M(1), 0)));
    yield this.banner(who === 0 ? `${this.name(fi.slot)} caiu!` : 'Derrubou!', 1);
    const getUp = bout.resolveCount();
    for (let c = 1; c <= Math.min(getUp, 10); c++) {
      this.emit('banner', { text: String(c), seconds: 0.7 });
      this.sfx('click', 0.8);
      yield 0.65;
    }
    if (bout.isOver) { yield this.banner(bout.end === BoutEnd.TKO ? 'Nocaute técnico' : 'K.O.!', 1.6); return; }
    fi.stance = 'idle';
    fi.actor.play('box_wait1R', this.time);
    fi.actor.setExpression('neutral');
    yield this.banner(who === 0 ? 'Levantou! Continue' : 'Ele levantou', 1);
  }

  updateCamera() {
    const me = this.f[0].actor, foe = this.f[1].actor;
    this.cameraFollow(add(me.pos, v3(0, this.M(2.1), this.M(2.6))), add(foe.pos, v3(0, this.M(1.3), 0)), 8, 52);
  }

  updateHud() {
    const b = this.bout;
    const bar = (hp) => { const n = clamp(Math.ceil(hp / 10), 0, 10); return '|'.repeat(n) + '.'.repeat(10 - n) + ' ' + Math.ceil(hp); };
    this.score(`Round ${b.round}/${b.rounds}   ${Math.ceil(b.timeLeft)} s\n${this.name(this.f[0].slot)}  ${bar(b.health[0])}\n${this.name(this.f[1].slot)}  ${bar(b.health[1])}\nGolpes: ${b.landed[0]}/${b.thrown[0]}`);
    this.hint(this.f[0].slot.human ? 'Gesto = soco (lado = mão, para cima = uppercut, lateral = cruzado)   v guarda   < > esquiva' : '');
    this.pane('boxGauge_00', 'T_round_00', b.round);
  }

  endText() {
    const b = this.bout, w = b.winner === 0;
    if (b.end === BoutEnd.KO) return w ? 'Vitória por K.O.!' : 'Derrota por K.O.';
    if (b.end === BoutEnd.TKO) return w ? 'Vitória por nocaute técnico!' : 'Derrota por nocaute técnico';
    if (b.end === BoutEnd.Draw) return 'Empate';
    return w ? 'Vitória por pontos!' : 'Derrota por pontos';
  }

  buildResult() {
    const r = this.newResult(), b = this.bout;
    this.addPlayer(r, this.f[0].slot, Math.round(b.damageDealt[0]), `${b.landed[0]} golpes, ${b.knockdowns[1]} quedas causadas`);
    this.addPlayer(r, this.f[1].slot, Math.round(b.damageDealt[1]), `${b.landed[1]} golpes, ${b.knockdowns[0]} quedas causadas`);
    r.winner = b.winner;
    r.humanWon = b.winner === 0;
    r.lines.push(this.endText());
    return r;
  }

  extraState() {
    const b = this.bout;
    return { hp: b.health.map((h) => Math.round(h)), rc: b.recoverable.map((h) => Math.round(h)), rd: b.round, tl: Math.ceil(b.timeLeft), st: this.f.map((f) => f.stance) };
  }
}
