// Ponto de entrada da Etapa 5: os 5 esportes do Linux Sports (física, regras e IA portadas do projeto Unity) jogáveis
// no WEBC (three.js 0.180), sozinho contra a CPU ou em sala.
//
//   registerWebcGames()   registra tênis, beisebol, boliche, golfe e boxe em C.minijogos (js/minijogos.js do WEBC):
//                         criar(ctx) devolve {atualizar(dt), estado(), parar(), dica()} e chama ctx.fim(resultado).
//   createSportsGame(o)   o mesmo jogo para qualquer página (demo/jogar.html): cena, câmera, renderer e um elemento.
//
// Dentro do WEBC os módulos leem os globais do pacote vendor (lib/runtime.js). Partidas em sala usam a Sala do WEBC
// quando a página a expõe em C.salaAtiva (ou pela opção getSala); sem sala, tudo funciona sozinho.
import { runtime } from './lib/runtime.js';
import { defaultStore } from './engine/assets/AssetStore.js';
import { AnimationLibrary } from './engine/animation/AnimationLibrary.js';
import { EffectLibrary } from './engine/particles/Nw4rParticles.js';
import { SportsAudioManager } from './engine/audio/SportsAudioManager.js';
import { SportsInputBridge } from './engine/input/SportsInputBridge.js';
import { MiiOpponentBuilder } from './entities/MiiOpponentBuilder.js';
import { WebcAvatarAdapter } from './entities/WebcAvatarAdapter.js';
import { TextManager, webcLanguage } from './ui/TextManager.js';
import { SportsHud } from './ui/SportsHud.js';
import { SportsMenu } from './ui/SportsMenu.js';
import { GameplayData, SPORTS, SPORT_NAME_FALLBACK } from './core/GameplayData.js';
import { RecordStore } from './core/RecordStore.js';
import { RoomSync } from './core/RoomSync.js';
import { CharacterStore, loadVrm } from './core/CharacterStore.js';
import { SportsStateMachine, State } from './core/SportsStateMachine.js';
import { ActivityStage } from './activities/common/ActivityStage.js';
import { normalizeGesture } from './activities/common/SportActivity.js';
import { BowlingActivity } from './activities/bowling/BowlingActivity.js';
import { GolfActivity } from './activities/golf/GolfActivity.js';
import { TennisActivity } from './activities/tennis/TennisActivity.js';
import { BaseballActivity } from './activities/baseball/BaseballActivity.js';
import { BoxingActivity } from './activities/boxing/BoxingActivity.js';

export const ACTIVITIES = Object.freeze({ tennis: TennisActivity, baseball: BaseballActivity, bowling: BowlingActivity, golf: GolfActivity, boxing: BoxingActivity });

/** Cria a partida de uma sessão (sem tela: world/loadWorld vêm de quem desenha). */
export function createActivity(session, data, { world = null, loadWorld = null } = {}) {
  const A = ACTIVITIES[session.sport];
  if (!A) throw new Error('modalidade desconhecida: ' + session.sport);
  return new A({ session, data, world, loadWorld });
}

const HINTS = {
  tennis: 'Gesto de raquete na hora certa (adiantado = cruzado). Saque: gesto lança, gesto bate.',
  baseball: 'Rebata com o gesto quando a bola chegar. Arremesso: direcional escolhe o tipo, gesto arremessa.',
  bowling: '< > posição, mira com o ponteiro, gesto de arremesso (o lado do gesto dá efeito).',
  golf: '< > mira, ^ v taco, gesto de tacada (força = velocidade; inclinação = efeito).',
  boxing: 'Gesto = soco (lado = mão, para cima = uppercut, lateral = cruzado), v/Shift guarda, < > esquiva.',
};

/**
 * Jogo completo numa página: menus (máquina de estados), partida 3D, HUD, recordes e sala.
 * @param {object} o
 * @param {THREE.Scene} o.scene
 * @param {THREE.PerspectiveCamera} o.camera
 * @param {THREE.WebGLRenderer} [o.renderer]
 * @param {HTMLElement} o.element      onde o HUD/menu aparecem e o ponteiro é lido
 * @param {string} [o.sport]           começa direto nesta modalidade (WEBC); sem ela, abre o menu (Boot)
 * @param {object|Function} [o.options] opções da partida (DEFAULT_OPTIONS) ou (data) => opções
 * @param {object} [o.vrm]             avatar .vrm do jogador (WEBC)
 * @param {object} [o.captura]         {ouvir(f)} da captura de movimento do WEBC
 * @param {object} [o.sala]            Sala do WEBC (partida em sala)
 * @param {string} [o.player]          perfil dos recordes
 * @param {Function} [o.onResult]      (resultado, resumo) no fim da partida
 * @param {boolean} [o.menus=true]     false: sem menus (o WEBC tem os dele); o fim vai para onResult
 * @param {string} [o.startState]      estado inicial do menu (padrão Boot; a página JOGOS do WEBC abre no MainMenu)
 */
export function createSportsGame(o) {
  const store = o.store || defaultStore();
  const app = document.createElement('div');
  app.className = 'sp-app';
  o.element.append(app);
  const g = {
    state: 'carregando', error: null, machine: null, activity: null, stage: null, hud: null, menu: null, room: null,
    ready: null, guestView: null, input: null, audio: null,
  };
  const libs = { anims: new AnimationLibrary(store), fx: new EffectLibrary(store), mii: new MiiOpponentBuilder(store), audio: new SportsAudioManager(), avatar: null };
  g.audio = libs.audio;
  const palcoAvatar = o.vrm ? (() => { try { return new WebcAvatarAdapter(o.vrm); } catch (e) { return null; } })() : null;
  g.hud = new SportsHud(app, { store });
  let stageReady = null;
  const pending = { activity: null };

  const newStage = () => {
    if (g.stage) g.stage.dispose();
    g.hud.clear();
    g.stage = new ActivityStage({ scene: o.scene, camera: o.camera, renderer: o.renderer || null, data: g.data, store, libs, hud: g.hud });
    return g.stage;
  };

  // o personagem do jogador local: Mii (montado pelo stage) ou .vrm (carregado aqui antes de a partida andar)
  let loadedVrm = { key: null, adapter: null };
  const prepareCharacter = async (slot) => {
    const ch = slot && slot.character;
    libs.avatar = null;
    if (!ch || ch.kind !== 'vrm') return;
    if (ch.source === 'palco') { libs.avatar = palcoAvatar; return; }
    if (loadedVrm.key !== ch.key) {
      const vrm = await loadVrm(await g.characters.vrmBlob(ch), runtime);
      loadedVrm = { key: ch.key, adapter: new WebcAvatarAdapter(vrm) };
    }
    libs.avatar = loadedVrm.adapter;
  };

  // a partida só começa quando a cena e o personagem carregaram: até lá fica pausada (o gerador não avança)
  const makeActivity = (session) => {
    const stage = newStage();
    const act = createActivity(session, g.data, { loadWorld: stage.loadWorld });
    act.paused = true;
    stage.bind(act);
    g.activity = act;
    stageReady = Promise.all([stage.prepare(session.sport), prepareCharacter(session.players[0]).catch((e) => {
      // .vrm que não abre: joga com um Mii no lugar e avisa
      session.players[0].character = null;
      g.hud.banner('O avatar .vrm não abriu: jogando com um Mii', 2.5);
      console.warn(e);
    })]).then(([world]) => {
      if (world) { act.world = world; for (const b of act.balls) if (session.sport !== 'tennis' && session.sport !== 'baseball') b.world = world; }
      act.paused = false;
      g.state = 'jogando';
    }).catch((e) => { g.error = e; console.error(e); act.paused = false; });
    return act;
  };

  g.ready = (async () => {
    g.data = await GameplayData.load(store);
    const [text, profiles] = await Promise.all([
      TextManager.load(webcLanguage(), store).catch(() => null),
      store.json('Mii/profiles.json').then((j) => j.profiles).catch(() => []),
    ]);
    if (text) text.followWebc();
    g.records = new RecordStore({ fields: g.data.recordFields });
    await g.records.ready();
    g.characters = o.characters || new CharacterStore({ webc: CharacterStore.webcApi() });
    try { await libs.audio.load(store); } catch (e) { /* áudio opcional */ }
    if (o.sala) { g.room = new RoomSync({ sala: o.sala }).attach(); }
    g.machine = new SportsStateMachine({
      data: g.data, records: g.records, text, profiles, room: g.room,
      player: o.player || 'visitante', playerName: o.playerName || 'Você', characters: g.characters,
      extraCharacters: palcoAvatar ? [{ key: 'palco', kind: 'vrm', name: 'Meu avatar atual', source: 'palco' }] : [],
      createActivity: makeActivity,
    });
    if (o.options) Object.assign(g.machine.options, typeof o.options === 'function' ? o.options(g.data) : o.options);
    g.machine.on((st) => {
      g.state = st === State.Playing ? (g.activity && g.activity.paused ? 'carregando' : 'jogando') : st;
      if (st === State.Results && o.onResult) o.onResult(g.machine.lastResult, g.machine.lastSubmit, g.machine);
      if (st === State.Results || st === State.SportSelect) g.hud.clear();
    });
    if (o.menus !== false) g.menu = new SportsMenu(app, g.machine, { store, builder: libs.mii });
    else g.machine.on((st) => { if (st !== State.Playing && st !== State.Paused && g.menu) g.menu.render(); });
    // entrada: ponteiro/teclado/gamepad/câmera -> partida (jogador local) ou menu
    g.input = new SportsInputBridge(o.element, { captura: o.captura || null, gestureKind: 'swing' });
    const local = () => (g.machine.session ? g.machine.session.localIndex || 0 : 0);
    for (const k of ['swing', 'throw', 'strike']) g.input.on(k, (d) => {
      const ge = normalizeGesture(d);
      if (g.room && g.room.role === 'guest') { g.room.sendGesture(ge); return; }
      if (g.activity && g.machine.state === State.Playing) g.activity.pushGesture(local(), ge);
      try { libs.audio.unlock(); } catch (e) { /* sem áudio */ }
    });
    g.input.on('confirm', () => {
      try { libs.audio.unlock(); } catch (e) { /* sem áudio */ }
      if (g.machine.state === State.Playing && g.activity) g.activity.pushConfirm(local());
      else if (g.menu) g.menu.confirm();
    });
    g.input.on('back', () => { if (g.menu) g.menu.back(); else g.machine.back(); });
    if (o.sport) { g.machine.newSession(o.sport); g.machine.buildPlayers(); g.machine.go(State.Playing); }
    else g.machine.go(o.startState || State.Boot);
    return g;
  })().catch((e) => { g.error = e; g.state = 'erro'; console.error(e); throw e; });

  g.update = (dt) => {
    if (!g.machine) return;
    const c = g.input ? g.input.poll() : null;
    const m = g.machine;
    if (c) {
      if (m.state === State.Playing && g.activity) {
        if (g.activity.gestureKind && g.input.gestureKind !== g.activity.gestureKind) g.input.gestureKind = g.activity.gestureKind;
        g.activity.setControls(m.session.localIndex || 0, c);
      } else if (g.menu) g.menu.pollMove(c.move, dt);
      if (g.room && g.room.role === 'guest') g.room.sendControls(c);
    }
    if (g.room) g.room.update();
    m.update(dt);
    if (g.stage) {
      const view = g.room && g.room.role === 'guest' ? g.room.view() : null;
      g.stage.update(dt, view);
    }
    g.hud.update(g.activity);
  };

  g.render = () => { if (g.stage) g.stage.render(); };

  /** Convidado: entra na partida aberta por outra pessoa da sala (RoomSync.openMatches()). */
  g.joinRoomMatch = async (match) => {
    if (!g.room) throw new Error('sem sala');
    const stage = newStage();
    await stage.prepare(match.lobby.sport);
    g.room.onEvent = (e) => stage.onEvent(e);
    g.room.join(match.peer, match.matchId);
    g.machine.state = State.Playing;
    g.machine.menu = null;
    if (g.menu) g.menu.render();
  };

  g.dispose = () => {
    if (g.activity && !g.activity.finished) g.activity.abort();
    if (g.input) g.input.dispose();
    if (g.room) g.room.detach();
    if (g.stage) g.stage.dispose();
    if (g.menu) g.menu.dispose();
    g.hud.dispose();
    try { libs.audio.dispose(); } catch (e) { /* já fechado */ }
    app.remove();
  };
  return g;
}

// ── WEBC: C.minijogos ────────────────────────────────────────────────────────────

const WEBC_DEFS = {
  tennis: { id: 'ls-tenis', cor: '#2c62c9', descricao: 'Linux Sports: quadra, raquete e contagem originais, simples ou duplas contra Miis com IA.',
    opcoes: [{ id: 'modo', rotulo: 'Modo', padrao: 'simples', valores: [{ v: 'simples', rotulo: 'Simples' }, { v: 'duplas', rotulo: 'Duplas' }] },
      { id: 'games', rotulo: 'Partida', padrao: 3, valores: [{ v: 1, rotulo: '1 game' }, { v: 3, rotulo: '3 games' }, { v: 5, rotulo: '5 games' }] }],
    options: (op) => ({ tennisDoubles: op.modo === 'duplas', tennisGames: +op.games || 3 }) },
  baseball: { id: 'ls-beisebol', cor: '#d9443b', descricao: 'Linux Sports: estádio com muro real, 5 arremessos com efeito Magnus, rebata e arremesse.',
    opcoes: [{ id: 'entradas', rotulo: 'Entradas', padrao: 3, valores: [{ v: 1, rotulo: '1 entrada' }, { v: 3, rotulo: '3 entradas' }, { v: 9, rotulo: '9 entradas' }] }],
    options: (op) => ({ baseballInnings: +op.entradas || 3 }) },
  bowling: { id: 'ls-boliche', cor: '#8a4dff', descricao: 'Linux Sports: pista e pinos originais, gancho no último terço, strike, spare e split.',
    opcoes: [{ id: 'cpus', rotulo: 'Adversários', padrao: 1, valores: [{ v: 0, rotulo: 'Sozinho' }, { v: 1, rotulo: '1 CPU' }, { v: 3, rotulo: '3 CPUs' }] },
      { id: 'quadros', rotulo: 'Quadros', padrao: 10, valores: [{ v: 3, rotulo: '3' }, { v: 5, rotulo: '5' }, { v: 10, rotulo: '10' }] }],
    options: (op) => ({ bowlingOpponents: +op.cpus, bowlingFrames: +op.quadros || 10 }) },
  golf: { id: 'ls-golfe', cor: '#2fa35a', descricao: 'Linux Sports: os 14 cursos originais com vento, backspin, banca, água e green.',
    opcoes: [{ id: 'buracos', rotulo: 'Percurso', padrao: 3, valores: [{ v: 3, rotulo: '3 buracos' }, { v: 9, rotulo: '9 buracos' }, { v: 14, rotulo: 'Todos (14)' }] }],
    options: (op, data) => ({ golfHoles: data.golfCourses.slice(0, +op.buracos || 3).map((c) => c.id), golfOpponents: 1 }) },
  boxing: { id: 'ls-boxe', cor: '#f08a24', descricao: 'Linux Sports: ringue original, guarda, esquiva, contra-ataque, quedas e K.O.',
    opcoes: [{ id: 'rounds', rotulo: 'Rounds', padrao: 3, valores: [{ v: 1, rotulo: '1 round' }, { v: 3, rotulo: '3 rounds' }, { v: 5, rotulo: '5 rounds' }] }],
    options: (op) => ({ boxingRounds: +op.rounds || 3 }) },
};

/** Registra os 5 esportes em C.minijogos. getSala/getAvatar/getCaptura: como a página do WEBC expõe cada um. */
export function registerWebcGames({ C = globalThis.C, getSala = () => (C && C.salaAtiva) || null, getAvatar = () => (C && C.palco && C.palco.vrm) || null, getCaptura = () => (C && C.captura) || null } = {}) {
  if (!C || !C.minijogos) throw new Error('C.minijogos não existe: carregue js/minijogos.js do WEBC antes');
  runtime.THREE; // falha cedo se o pacote vendor não foi carregado
  const nome = (s) => (C.t ? C.t(SPORT_NAME_FALLBACK[s]) : SPORT_NAME_FALLBACK[s]) + ' (Linux Sports)';
  for (const sport of SPORTS) {
    const def = WEBC_DEFS[sport];
    C.minijogos.registrar({
      id: def.id, nome: nome(sport), cor: def.cor, descricao: def.descricao, opcoes: def.opcoes,
      criar(ctx) {
        const N = C.esportesNucleo;
        let game = null, finished = false;
        game = createSportsGame({
          scene: ctx.cena, camera: ctx.camera, renderer: ctx.renderer || null, element: ctx.elemento, sport, menus: false,
          options: (data) => def.options(ctx.opcoes || {}, data),
          vrm: getAvatar(), captura: getCaptura(), sala: getSala(), player: N ? N.pessoa() : 'visitante',
          onResult: (r, sub) => {
            if (finished) return;
            finished = true;
            const lines = r.players.map((p, i) => `${i === r.winner ? '★ ' : ''}${p.name}: ${p.scoreText}`).concat(r.lines);
            if (sub && sub.skillDelta !== undefined) lines.push(`Habilidade (Linux Sports): ${sub.skill} (${sub.skillDelta >= 0 ? '+' : ''}${sub.skillDelta})`);
            for (const n of (sub && sub.newRecords) || []) lines.push(`Novo recorde: ${n.field} = ${n.value}`);
            const me = r.players[0];
            // o núcleo do WEBC guarda partidas/vitórias/melhor para o cartão da página JOGOS (sem forcaCPU: a
            // habilidade fica só no RecordStore do Linux Sports, para não contar duas vezes)
            ctx.fim({
              titulo: r.winner < 0 ? 'Empate' : r.humanWon ? 'Vitória!' : 'Derrota', vitoria: r.humanWon, empate: r.winner < 0, linhas: lines,
              recorde: me ? { valor: me.score, melhor: sport === 'golf' ? 'menor' : 'maior', rotulo: me.scoreText, variante: sport === 'golf' ? (ctx.opcoes.buracos || 3) : '-' } : null,
            });
          },
        });
        return {
          atualizar(dt) { game.update(dt); },
          estado() { return { esporte: sport, estado: game.state, erro: game.error ? String(game.error.message || game.error) : null, placar: game.activity ? game.activity.hud.score : '', fim: game.activity ? game.activity.finished : false }; },
          parar() { game.dispose(); },
          dica() { return HINTS[sport]; },
        };
      },
    });
  }
}

export { SportsStateMachine, State, GameplayData, RecordStore, RoomSync, ActivityStage };
