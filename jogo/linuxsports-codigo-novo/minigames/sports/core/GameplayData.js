// Dados de jogabilidade (assets/Gameplay/gameplay_data.json, gerado por tools/export_gameplay.py com NW4R_TARGET=web):
// escala 10 u = 1 m, geometria de cada modalidade no referencial do Wii/three.js (sem espelhar X), cursos de golfe
// (tee/pinos/par dos 14 cursos), muro do beisebol por ângulo, animações/efeitos/modelos/layouts por modalidade e os
// campos de recorde do RPSportsPlayerData. Porte de Core/Game/GameplayData.cs.
import { defaultStore } from '../engine/assets/AssetStore.js';

export const SPORTS = Object.freeze(['tennis', 'baseball', 'bowling', 'golf', 'boxing']);

/** IDs do common_message.bmg com o nome de cada modalidade (os mesmos do GameStateMachine.cs). */
export const SPORT_NAME_IDS = Object.freeze({ tennis: 77056, baseball: 77312, bowling: 77568, golf: 77824, boxing: 78080 });
export const SPORT_NAME_FALLBACK = Object.freeze({ tennis: 'Tênis', baseball: 'Beisebol', bowling: 'Boliche', golf: 'Golfe', boxing: 'Boxe' });

export class GameplayData {
  constructor(json) {
    if (!json || json.format !== 'linuxsports-gameplay') throw new Error('gameplay_data.json inválido');
    if (json.target && json.target !== 'web') throw new Error(`gameplay_data.json foi gerado para "${json.target}"; rode NW4R_TARGET=web python3 tools/export_gameplay.py`);
    this.json = json;
    this.unitsPerMeter = json.unitsPerMeter || 10;
    this.sports = json.sports || {};
    this.stateLayouts = json.stateLayouts || {};
    this.recordFields = (json.records || []).map((r) => r.field);
    this.avatarBodies = json.avatarBodies || {};
  }

  static async load(store = defaultStore()) {
    return new GameplayData(await store.json('Gameplay/gameplay_data.json'));
  }

  sport(key) {
    const s = this.sports[key];
    if (!s) throw new Error(`modalidade desconhecida: ${key}`);
    return s;
  }

  get golfCourses() { return (this.sports.golf && this.sports.golf.courses) || []; }

  /** Modalidade jogável com os dados exportados? */
  available(key) {
    const s = this.sports[key];
    if (!s) return false;
    return key === 'golf' ? this.golfCourses.length > 0 : s.scenes.length > 0 || !!s.commonScene;
  }

  /** Cena principal da partida (relativa a Scenes/). */
  mainScene(key) {
    const s = this.sport(key);
    if (key === 'bowling' || !s.scenes.length) return s.commonScene;
    return s.scenes[0] || s.commonScene;
  }

  /** Sidecar do modelo NW4R pelo nome curto (ex.: 'bwg_pin_166_10'). */
  model(key, name) { const s = this.sports[key]; return s && s.models ? s.models[name] || null : null; }

  /** Grupos de 3 buracos + "todos", como o seletor de percurso do C#. */
  courseSets() {
    const all = this.golfCourses.map((c) => c.id);
    const sets = [];
    for (let i = 0; i < all.length; i += 3) sets.push(all.slice(i, i + 3));
    sets.push(all);
    return sets;
  }

  par(ids) { return ids.reduce((t, id) => t + ((this.golfCourses.find((c) => c.id === id) || {}).par || 0), 0); }
}
