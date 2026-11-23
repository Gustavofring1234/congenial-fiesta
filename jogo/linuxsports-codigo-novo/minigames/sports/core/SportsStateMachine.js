// Fluxo do jogo (porte de Core/Game/GameStateMachine.cs) sem motor gráfico:
//   Boot -> MainMenu -> SportSelect -> Options -> Lobby (só em sala) -> CharacterChoice -> Playing <-> Paused
//   -> Results -> Records
// CharacterChoice vem antes de TODA partida (inclusive "Jogar de novo"): usar um personagem salvo (SavedCharacters:
// Miis criados, .vrm importados e as personagens VRoid do WEBC, mais "importar .vrm do aparelho") ou montar um no
// editor estilo Wii (CharacterCreator, com pré-visualização 3D giratória).
// Cada estado expõe um MENU-MODELO ({title, subtitle, items:[{id, label, value?, enabled, select(), adjust(d)}],
// back()}) e os layouts NW4R do estado (gameplay_data.json -> stateLayouts). Quem desenha (ui/SportsMenu.js) só lê o
// modelo e chama select/adjust/back; os mesmos comandos vêm do teclado, do toque, do gamepad e dos gestos.
// Os nomes das modalidades vêm do common_message.bmg (IDs 77056..78080) pelo TextManager (pt/en/ja).
import { SPORTS, SPORT_NAME_IDS, SPORT_NAME_FALLBACK } from './GameplayData.js';
import { RECORD_LABELS } from './RecordStore.js';
import { aiFromMii, skillForOpponent } from '../activities/common/AiProfile.js';
import { SeededRandom } from '../activities/common/rng.js';
import { GolfScorecard } from '../activities/golf/GolfScorecard.js';
import { MiiEditor, MII_FIELDS, MAX_NAME, defaultMiiInfo } from './MiiEditor.js';

export const State = Object.freeze({
  Boot: 'Boot', MainMenu: 'MainMenu', SportSelect: 'SportSelect', Options: 'Options',
  CharacterChoice: 'CharacterChoice', SavedCharacters: 'SavedCharacters', CharacterCreator: 'CharacterCreator',
  Lobby: 'Lobby', Playing: 'Playing', Paused: 'Paused', Results: 'Results', Records: 'Records',
});

const STEP = (v, d, options) => { let i = options.indexOf(v); if (i < 0) i = 0; return options[Math.max(0, Math.min(options.length - 1, i + d))]; };

export const DEFAULT_OPTIONS = Object.freeze({
  tennisGames: 3, tennisDoubles: true, baseballInnings: 3, bowlingFrames: 10, bowlingOpponents: 1,
  golfHoles: [], golfOpponents: 1, boxingRounds: 3,
});

export class SportsStateMachine {
  /**
   * @param {object} o
   * @param {GameplayData} o.data
   * @param {RecordStore} o.records
   * @param {TextManager} [o.text]
   * @param {object[]} [o.profiles]   perfis Mii (Mii/profiles.json -> profiles)
   * @param {string} [o.player]       quem joga (perfil dos recordes; no WEBC: C.esportesNucleo.pessoa())
   * @param {string} [o.playerName]
   * @param {Function} [o.createActivity]  (session) => SportActivity (a tela monta a cena)
   * @param {object} [o.room]         RoomSync ligado (partidas em sala)
   * @param {Function} [o.seed]       () => semente
   * @param {CharacterStore} [o.characters]  personagens salvos (Miis criados, .vrm importados, VRoid do WEBC)
   * @param {object[]} [o.extraCharacters]   entradas fixas no topo da lista (ex.: o avatar que está no palco do WEBC)
   */
  constructor({ data, records, text = null, profiles = [], player = 'visitante', playerName = 'Você', createActivity = null, room = null, seed = null, characters = null, extraCharacters = [] } = {}) {
    this.data = data;
    this.records = records;
    this.text = text;
    this.profiles = profiles;
    this.player = player;
    this.playerName = playerName;
    this.character = null;              // entrada escolhida: {key, kind: 'mii'|'vrm', name, source, info?}
    this.characters = characters;
    this.extraCharacters = extraCharacters;
    this.savedList = null;              // lista carregada para SavedCharacters (null = carregando)
    this.editor = null;
    this.characterError = '';
    this.createActivity = createActivity;
    this.room = room;
    this.seedFn = seed || (() => (Date.now() & 0x7fffffff) || 1);
    this.state = null;
    this.prev = null;
    this.session = null;
    this.options = { ...DEFAULT_OPTIONS };
    this.activity = null;
    this.lastResult = null;
    this.lastSubmit = null;
    this.menu = null;
    this.listeners = new Set();
    this.courseSet = 0;
    this.lobbyGuests = [];              // [{peer, name}]
    this.recordsSport = 'bowling';
  }

  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  _changed() { for (const f of this.listeners) { try { f(this.state, this.menu, this); } catch (e) { console.error(e); } } }

  /** Texto do .bmg no idioma ativo; se o idioma ativo não tem tradução (pt/ja ainda não geradas), usa o texto em português. */
  t(file, id, fallback) {
    const m = this.text ? this.text.get(file, id) : null;
    if (!m || !m.text || (this.text.language !== 'en' && m.language !== this.text.language)) return fallback;
    return m.text.replace(/\n/g, ' ');
  }
  sportName(s) { return this.t('common_message', SPORT_NAME_IDS[s], SPORT_NAME_FALLBACK[s]); }
  layouts(state = this.state) { return (this.data && this.data.stateLayouts[state]) || []; }

  characterName() { return this.character ? this.character.name : 'nenhum'; }

  // ── transições ─────────────────────────────────────────────────
  go(next) {
    const prev = this.state;
    this.prev = prev;
    this.state = next;
    switch (next) {
      case State.Boot: this.menu = { title: 'Linux Sports', subtitle: 'Confirmar (Enter, toque, botão A ou gesto) para começar', items: [{ id: 'start', label: 'Começar', select: () => this.go(State.MainMenu) }], back: null }; break;
      case State.MainMenu: this._mainMenu(); break;
      case State.SportSelect: this._sportSelect(); break;
      case State.CharacterChoice: this._characterChoice(); break;
      case State.SavedCharacters: this._savedCharacters(); break;
      case State.CharacterCreator: this._characterCreator(); break;
      case State.Options: this._options(); break;
      case State.Lobby: this._lobby(); break;
      case State.Playing: if (prev === State.Paused) this._resume(); else this._start(); break;
      case State.Paused: this._pause(); break;
      case State.Results: this._results(); break;
      case State.Records: this._records(); break;
      default: throw new Error('estado desconhecido: ' + next);
    }
    this._changed();
    return this;
  }

  /** Esc/voltar: pausa no jogo, volta nos menus. */
  back() {
    if (this.state === State.Playing) { if (this.activity && !this.activity.finished) this.go(State.Paused); return; }
    if (this.menu && this.menu.back) this.menu.back();
  }

  _mainMenu() {
    this.menu = {
      title: 'Linux Sports', subtitle: `Jogador: ${this.playerName}`,
      items: [
        { id: 'play', label: 'Jogar', select: () => this.go(State.SportSelect) },
        { id: 'records', label: 'Recordes', select: () => this.go(State.Records) },
      ],
      back: () => this.go(State.Boot),
    };
  }

  _sportSelect() {
    this.menu = {
      title: 'Escolha a modalidade', subtitle: `Jogador: ${this.playerName}`,
      items: SPORTS.map((s) => ({
        id: s, label: () => `${this.sportName(s)}   (habilidade ${this.records.skill(this.player, s)})`,
        enabled: this.data.available(s), select: () => { this.newSession(s); this.go(State.Options); },
      })),
      back: () => this.go(State.MainMenu),
    };
  }

  newSession(sport) {
    this.session = { sport, players: [], options: {}, seed: this.seedFn(), localIndex: 0 };
    if (sport === 'golf' && !this.options.golfHoles.length) this.options.golfHoles = (this.data.courseSets()[0] || []).slice();
  }

  _options() {
    const s = this.session.sport, o = this.options;
    const items = [];
    const add = (id, label, adjust) => items.push({ id, label, adjust: (d) => { adjust(d); this._changed(); } });
    if (s === 'tennis') {
      add('games', () => `Games: ${o.tennisGames}`, (d) => { o.tennisGames = STEP(o.tennisGames, d, [1, 3, 5]); });
      add('doubles', () => (o.tennisDoubles ? 'Duplas (você + CPU)' : 'Simples'), () => { o.tennisDoubles = !o.tennisDoubles; });
    } else if (s === 'baseball') add('innings', () => `Entradas: ${o.baseballInnings}`, (d) => { o.baseballInnings = STEP(o.baseballInnings, d, [1, 3, 9]); });
    else if (s === 'bowling') {
      add('cpus', () => `Adversários CPU: ${o.bowlingOpponents}`, (d) => { o.bowlingOpponents = Math.max(0, Math.min(3, o.bowlingOpponents + d)); });
      add('frames', () => `Quadros: ${o.bowlingFrames}`, (d) => { o.bowlingFrames = STEP(o.bowlingFrames, d, [3, 5, 10]); });
    } else if (s === 'golf') {
      add('course', () => `Percurso: ${this.courseLabel()}`, (d) => { const sets = this.data.courseSets(); this.courseSet = (this.courseSet + d + sets.length) % sets.length; o.golfHoles = sets[this.courseSet].slice(); });
      add('cpus', () => `Adversários CPU: ${o.golfOpponents}`, (d) => { o.golfOpponents = Math.max(0, Math.min(3, o.golfOpponents + d)); });
    } else if (s === 'boxing') add('rounds', () => `Rounds: ${o.boxingRounds}`, (d) => { o.boxingRounds = STEP(o.boxingRounds, d, [1, 3, 5]); });
    items.push({ id: 'start', label: 'Começar', select: () => this.chooseThenPlay(State.Options) });
    if (this.room) items.push({ id: 'room', label: 'Abrir partida na sala', select: () => this.go(State.Lobby) });
    this.menu = { title: this.sportName(s), subtitle: '', items, focus: items.findIndex((i) => i.id === 'start'), back: () => this.go(State.SportSelect) };
  }

  courseLabel() {
    const ids = this.options.golfHoles, all = this.data.golfCourses;
    if (ids.length === all.length) return `todos os ${all.length} buracos (par ${this.data.par(ids)})`;
    return `${ids.join(', ')}  (par ${this.data.par(ids)})`;
  }

  /** Jogadores da partida: você (+ parceiro CPU nas duplas), adversários CPU pela sua habilidade, convidados da sala. */
  buildPlayers() {
    const s = this.session, o = this.options;
    s.options = {
      tennisGames: o.tennisGames, tennisDoubles: o.tennisDoubles, baseballInnings: o.baseballInnings,
      bowlingFrames: o.bowlingFrames, golfHoles: o.golfHoles.slice(), boxingRounds: o.boxingRounds,
    };
    s.seed = this.seedFn();
    const mySkill = this.records.skill(this.player, s.sport);
    const ch = this.character;
    const mii = ch && ch.kind === 'mii' ? ch.info : null;
    const me = mii ? { id: ch.key, name: mii.name, height: mii.height, build: mii.build, sex: mii.sex, info: mii } : { id: this.player, name: this.playerName, height: 64, build: 64, sex: 0 };
    s.players = [{ profileId: ch ? ch.key : this.player, name: mii ? mii.name : this.playerName, human: true, local: true, ai: aiFromMii(me, 0.6), info: me, character: ch, miiInfo: mii }];
    let cpus;
    if (s.sport === 'tennis') cpus = o.tennisDoubles ? 3 : 1;
    else if (s.sport === 'baseball' || s.sport === 'boxing') cpus = 1;
    else cpus = s.sport === 'golf' ? o.golfOpponents : o.bowlingOpponents;
    // convidados da sala ocupam os lugares (em duplas, o 2º do time 0 é o parceiro)
    const guests = this.lobbyGuests.slice(0, cpus);
    const rng = new SeededRandom(s.seed);
    const pool = this.profiles.slice();
    for (let i = 0; i < cpus; i++) {
      const g = guests[i];
      if (g) { s.players.push({ profileId: 'sala:' + g.peer, name: g.name, human: true, remote: g.peer, ai: aiFromMii({ id: g.peer, name: g.name, height: 64, build: 64 }, 0.6), info: null }); continue; }
      const prof = pool.length ? pool.splice(rng.int(pool.length), 1)[0] : { id: `cpu_${i}`, name: `CPU ${i + 1}`, height: 64, build: 64, sex: 0 };
      s.players.push({ profileId: prof.id, name: prof.name, human: false, ai: aiFromMii(prof, skillForOpponent(mySkill, i)), info: prof });
    }
    if (this.room && this.room.role === 'host') for (const [i, p] of s.players.entries()) if (p.remote) this.room.admit(p.remote, p.name, i);
    return s.players;
  }

  // ── personagem antes da partida ────────────────────────────────
  /** Toda partida passa pela escolha do personagem; `from` é para onde o Voltar leva. */
  chooseThenPlay(from) {
    this.choiceFrom = from;
    this.go(State.CharacterChoice);
  }

  /** Usa o personagem e começa a partida. */
  useCharacter(entry) {
    this.character = entry;
    this.buildPlayers();
    this.go(State.Playing);
  }

  _characterChoice() {
    const items = [];
    if (this.character) items.push({ id: 'keep', label: () => `Continuar com ${this.characterName()}`, select: () => this.useCharacter(this.character) });
    items.push(
      { id: 'saved', label: 'Usar um personagem baixado ou salvo', select: () => this.go(State.SavedCharacters) },
      { id: 'create', label: 'Montar um personagem (estilo Wii)', select: () => { this.editor = new MiiEditor(defaultMiiInfo(0, this.playerName !== 'Você' ? this.playerName.slice(0, MAX_NAME) : '')); this.go(State.CharacterCreator); } },
    );
    this.menu = {
      title: 'Qual personagem você quer usar?', subtitle: () => `${this.session ? this.sportName(this.session.sport) + ' — ' : ''}escolha antes de entrar na partida`,
      items, back: () => this.go(this.choiceFrom || State.Options),
    };
  }

  _savedCharacters() {
    this.savedList = null;
    this.characterError = '';
    const load = async () => {
      const list = this.characters ? await this.characters.list() : [];
      this.savedList = [...this.extraCharacters, ...list];
      if (this.state === State.SavedCharacters) { this._savedMenu(); this._changed(); }
    };
    load().catch((e) => { this.savedList = [...this.extraCharacters]; this.characterError = String(e.message || e); if (this.state === State.SavedCharacters) { this._savedMenu(); this._changed(); } });
    this._savedMenu();
  }

  _savedMenu() {
    const list = this.savedList;
    const kindText = (e) => (e.kind === 'mii' ? 'Mii' : e.source === 'webc' ? 'VRM do WEBC' : e.source === 'palco' ? 'avatar atual' : 'VRM');
    const items = list === null ? [{ id: 'loading', label: 'Procurando personagens salvos…', enabled: false }]
      : list.map((e) => ({ id: 'char:' + e.key, label: `${e.name}  (${kindText(e)})`, select: () => this.useCharacter(e) }));
    if (list && !list.length) items.push({ id: 'none', label: 'Nenhum personagem salvo ainda', enabled: false });
    items.push({ id: 'import', label: 'Importar arquivo .vrm do aparelho', file: '.vrm,model/gltf-binary', onFile: (file) => this.importVrm(file) });
    this.menu = {
      title: 'Personagens salvos', subtitle: () => this.characterError || 'Miis que você montou, avatares .vrm baixados (Loja/Sketchfab) ou importados',
      items, preview: null, back: () => this.go(State.CharacterChoice),
    };
  }

  /** Importa um .vrm escolhido no aparelho, guarda e já entra na partida com ele. */
  async importVrm(file) {
    if (!this.characters) throw new Error('sem armazenamento de personagens');
    try {
      const entry = await this.characters.importVrm(file);
      this.useCharacter(entry);
      return entry;
    } catch (e) {
      this.characterError = 'Não deu para importar: ' + (e.message || e);
      if (this.state === State.SavedCharacters) { this._savedMenu(); this._changed(); }
      return null;
    }
  }

  _characterCreator() {
    const ed = this.editor || (this.editor = new MiiEditor());
    const changed = () => this._changed();
    const items = [
      { id: 'name', label: 'Nome', text: () => ed.info.name, maxLength: MAX_NAME, onInput: (v) => ed.setName(v) },   // o nome não muda o 3D: sem redesenhar o menu enquanto digita
      ...MII_FIELDS.map((f) => ({ id: f.id, label: () => `${f.label}: ${ed.valueText(f.id)}`, adjust: (d) => { if (ed.step(f.id, d)) changed(); } })),
      { id: 'random', label: 'Aleatório', select: () => { ed.randomize(); changed(); } },
      { id: 'confirm', label: 'Confirmar e jogar', select: () => this.confirmCreator() },
    ];
    this.menu = {
      title: 'Monte o seu personagem', subtitle: 'Gire a pré-visualização arrastando; ‹ › muda cada peça',
      items, preview: { kind: 'mii', editor: ed }, focus: 1, wide: true, back: () => this.go(State.CharacterChoice),
    };
  }

  /** Salva o Mii do editor (IndexedDB/localStorage) e começa a partida com ele. */
  async confirmCreator() {
    const info = this.editor.toInfo();
    const entry = this.characters ? await this.characters.saveMii(info) : { key: 'mii-temp', kind: 'mii', name: info.name, info, source: 'local' };
    this.useCharacter(entry);
    return entry;
  }

  _lobby() {
    const room = this.room;
    if (room.role !== 'host') room.host({ sport: this.session.sport, options: this.options, seed: this.session.seed });
    room.onJoin = (peer, name) => {
      if (!this.lobbyGuests.some((g) => g.peer === peer)) this.lobbyGuests.push({ peer, name: name || 'Convidado' });
      if (this.state === State.Lobby) { this._lobby(); this._changed(); }
    };
    this.menu = {
      title: `${this.sportName(this.session.sport)} — sala`,
      subtitle: () => (this.lobbyGuests.length ? `Na partida: ${this.lobbyGuests.map((g) => g.name).join(', ')}` : 'Esperando alguém da sala entrar (os lugares vazios ficam com a CPU)'),
      items: [{ id: 'start', label: 'Começar', select: () => this.chooseThenPlay(State.Lobby) }],
      back: () => { this.lobbyGuests = []; room.role = null; room.outgoing = null; this.go(State.Options); },
    };
  }

  // ── partida ────────────────────────────────────────────────────
  _start() {
    if (!this.session.players.length) this.buildPlayers();
    this.menu = null;
    this.activity = this.createActivity ? this.createActivity(this.session) : null;
    if (!this.activity) throw new Error('createActivity não definido');
    this.activity.onFinish = (r) => this._finished(r);
    if (this.room && this.room.role === 'host') this.room.startMatch(this.activity);
    if (!this.activity._co && !this.activity.finished) this.activity.start();
  }

  _pause() {
    if (this.activity) this.activity.paused = true;
    this.menu = {
      title: 'Pausa', subtitle: '',
      items: [
        { id: 'continue', label: 'Continuar', select: () => this.go(State.Playing) },
        { id: 'quit', label: 'Sair da partida', select: () => { if (this.activity) this.activity.paused = false; this.activity.abort(); } },
      ],
      back: () => this.go(State.Playing),
    };
  }

  _resume() { if (this.activity) this.activity.paused = false; this.menu = null; }

  _finished(r) {
    this.lastResult = r;
    this.lastSubmit = null;
    if (this.room && this.room.role === 'host') this.room.endMatch();
    if (!r.aborted) this.lastSubmit = this.records.submitResult(this.player, r, this.session);
    this.go(r.aborted ? State.SportSelect : State.Results);
  }

  /** Avança a partida (quem tem o laço de quadros chama a cada quadro). */
  update(dt) { if (this.state === State.Playing && this.activity) this.activity.update(dt); }

  _results() {
    const r = this.lastResult, sub = this.lastSubmit || { newRecords: [], skillDelta: 0, skill: 0 };
    const lines = r.players.map((p, i) => `${i === r.winner ? '★ ' : '  '}${p.name}: ${p.scoreText}`);
    lines.push(...r.lines);
    if (r.players.length && this.session.players.some((p) => !p.human)) lines.push(`Habilidade ${sub.skillDelta >= 0 ? '+' : ''}${sub.skillDelta} = ${sub.skill}`);
    if (sub.newRecords.length) { lines.push('NOVO RECORDE!'); for (const n of sub.newRecords) lines.push(`${RECORD_LABELS[n.field] || n.field}: ${n.field === 'GolStandardBest' ? GolfScorecard.toParText(n.value) : n.value}`); }
    this.menu = {
      title: `${r.winner < 0 ? 'Empate' : r.humanWon ? 'Vitória!' : 'Derrota'} — ${this.sportName(r.sport)}`, subtitle: '', lines,
      newRecord: sub.newRecords.length > 0,
      items: [
        { id: 'again', label: 'Jogar de novo', select: () => this.chooseThenPlay(State.Results) },
        { id: 'other', label: 'Outra modalidade', select: () => this.go(State.SportSelect) },
        { id: 'records', label: 'Recordes', select: () => this.go(State.Records) },
        { id: 'main', label: 'Menu principal', select: () => this.go(State.MainMenu) },
      ],
      back: () => this.go(State.MainMenu),
    };
  }

  recordLines() {
    const me = this.player, R = this.records, L = [];
    const line = (label, field, variant = '', fmt = (v) => v) => { if (R.has(me, field, variant)) L.push(`${label}: ${fmt(R.get(me, field, variant))}`); };
    line('Boliche — melhor pontuação', 'BowStandardBest');
    line('Boliche — jogos perfeitos', 'BowPerfectCount');
    line('Golfe — hole in one', 'GolAceCount');
    for (const set of this.data.courseSets()) line(`Golfe ${set.join('-')}`, 'GolStandardBest', set.join('-'), GolfScorecard.toParText);
    line('Beisebol — rebatidas seguidas', 'BsbRenzokuBest');
    line('Tênis — vitórias', 'TnsSuccess');
    line('Partidas', 'StandardPlayCount');
    for (const s of SPORTS) L.push(`Habilidade (${this.sportName(s)}): ${R.skill(me, s)}`);
    return L;
  }

  _records() {
    this.menu = {
      title: `Recordes — ${this.playerName}`, subtitle: '', lines: () => this.recordLines(),
      items: [{ id: 'back', label: 'Voltar', select: () => this.go(State.MainMenu) }],
      back: () => this.go(State.MainMenu),
    };
  }
}

/** Texto de um rótulo do menu (string ou função). */
export const labelOf = (v) => (typeof v === 'function' ? v() : v || '');
