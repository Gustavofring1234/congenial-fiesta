// Perfil de IA de um adversário (porte de AiProfile.cs + AiProfileMii.cs) e pontos de habilidade como Elo
// (SkillRating.cs). O .rcd do Mii não guarda habilidade: dá corpo (altura/peso 0..127, sexo) e identidade. Daí saem
// alcance/velocidade (altura), potência/resistência (peso) e um estilo estável por perfil (agressividade, lado
// preferido) tirado do hash FNV-1a de "nome|id" — o mesmo stableHash do MiiOpponentBuilder (Etapa 3).
import { stableHash } from '../../entities/MiiOpponentBuilder.js';
import { clamp01 } from './vec3.js';

export { stableHash };

/**
 * @param {number} height01 altura 0..1
 * @param {number} build01  peso 0..1
 * @param {boolean} female
 * @param {number} hash     inteiro estável por perfil
 * @param {number} skill01  força pedida 0..1
 */
export function createAiProfile(height01, build01, female, hash, skill01) {
  const s = clamp01(skill01);
  const u1 = (hash & 0xff) / 255, u2 = ((hash >> 8) & 0xff) / 255, u3 = ((hash >> 16) & 0xff) / 255;
  return {
    seed: hash,
    skill: s,
    reach: 0.85 + 0.3 * clamp01(height01),
    speed: clamp01(0.35 + 0.45 * s + 0.25 * (1 - Math.abs(build01 - 0.4)) - 0.1 * clamp01(build01 - 0.6)),
    power: clamp01(0.3 + 0.4 * s + 0.3 * clamp01(build01) + (female ? -0.03 : 0.03)),
    stamina: clamp01(0.5 + 0.3 * s + 0.2 * (1 - Math.abs(build01 - 0.5) * 2)),
    accuracy: clamp01(0.25 + 0.7 * s + 0.05 * (u1 - 0.5)),
    reaction: 0.45 - 0.33 * s + 0.04 * u2,
    aggression: clamp01(0.3 + 0.4 * u3 + 0.2 * s),
    sideBias: u1 * 2 - 1,
  };
}

/** Perfil a partir de um Mii (entrada de Mii/profiles.json ou o objeto info). */
export function aiFromMii(profile, skill01) {
  const info = profile ? profile.info || profile : null;
  const id = profile ? profile.id ?? (info && info.id) ?? '' : '';
  const h = info ? info.height / 127 : 0.5;
  const b = info ? info.build / 127 : 0.5;
  return createAiProfile(h, b, !!info && info.sex === 1, stableHash(`${(info && info.name) || ''}|${id}`), skill01);
}

/** Força 0..1 de um adversário a partir dos pontos de habilidade do jogador (0..2000), ±0,1 entre adversários. */
export function skillForOpponent(playerSkillPoints, opponentIndex) {
  const base = clamp01(playerSkillPoints / SKILL_MAX);
  const spread = ((((opponentIndex * 37) % 11) - 5) / 50);
  return clamp01(0.15 + 0.8 * base + spread);
}

/** Erro gaussiano escalado pela imprecisão do perfil (rng: SeededRandom). */
export function aiError(ai, rng, scale) {
  return rng.gaussian() * scale * (1 - (ai ? ai.accuracy : 0.5) * 0.9);
}

// ── pontos de habilidade (SkillLevel do RPSportsPlayerData), Elo contra a força da CPU ──
export const SKILL_MAX = 2000;
export const SKILL_K = 60;

/** Variação: força do adversário 0..1 vira 0..2000; resultado 1 = vitória, 0,5 = empate, 0 = derrota. */
export function skillDelta(current, opponentStrength01, outcome01) {
  const opp = clamp01(opponentStrength01) * SKILL_MAX;
  const expected = 1 / (1 + 10 ** ((opp - current) / 400));
  const v = SKILL_K * (clamp01(outcome01) - expected);
  return Math.sign(v) * Math.round(Math.abs(v)); // arredonda para longe do zero, como MidpointRounding.AwayFromZero
}
