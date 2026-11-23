// Tacos do RPGolScene (modelos glf_club_WD/IR/SW/PT), porte de Activities/Golf/GolfClubs.cs. Rapidez, ângulo de saída
// e backspin calibrados com BallFlight: carry do driver ≈ 206 m, ferro ≈ 144 m, wedge ≈ 88 m (tests/sports/stage5).
import { GRAVITY } from '../common/BallFlight.js';

export const CLUBS = Object.freeze([
  { kind: 'driver', label: 'Driver (1W)', model: 'glf_club_WD', launchDeg: 12, backspin: 280, maxSpeedMS: 74, sideSpinPerDeg: 9, maxErrorDeg: 9 },
  { kind: 'iron', label: 'Ferro (7I)', model: 'glf_club_IR', launchDeg: 20, backspin: 420, maxSpeedMS: 46, sideSpinPerDeg: 7, maxErrorDeg: 6 },
  { kind: 'wedge', label: 'Wedge (SW)', model: 'glf_club_SW', launchDeg: 38, backspin: 520, maxSpeedMS: 33, sideSpinPerDeg: 5, maxErrorDeg: 4 },
  { kind: 'putter', label: 'Putter (PT)', model: 'glf_club_PT', launchDeg: 0, backspin: 0, maxSpeedMS: 9, sideSpinPerDeg: 0, maxErrorDeg: 2 },
]);

export const clubIndex = (kind) => CLUBS.findIndex((c) => c.kind === kind);
export const club = (kind) => CLUBS[clubIndex(kind)];

/** Escolha automática pela distância (m) e superfície, como o caddie do jogo. */
export function suggestClub(distanceM, surface, onTee) {
  if (surface === 'green') return 'putter';
  if (surface === 'bunker') return distanceM > 110 ? 'iron' : 'wedge';
  if (distanceM > 165 && (onTee || surface === 'fairway')) return 'driver';
  if (distanceM > 85) return 'iron';
  if (distanceM > 22) return 'wedge';
  return 'putter';
}

/** Perda de força na areia e no rough. */
export function surfacePowerFactor(surface, kind) {
  if (kind === 'putter') return 1;
  switch (surface) {
    case 'rough': return 0.88;
    case 'deepRough': return 0.7;
    case 'bunker': return kind === 'wedge' ? 0.75 : 0.55;
    default: return 1;
  }
}

/** Rapidez (m/s) para o putt rolar d metros com resistência r (fração de g). */
export const puttSpeed = (distanceM, rolling) => Math.sqrt(2 * rolling * GRAVITY * Math.max(0.05, distanceM));

/** Quique/rolamento por superfície (a bola de golfe muda de comportamento no green, na areia, na água...). */
export function surfaceBall(base, surface) {
  const p = { ...base };
  switch (surface) {
    case 'green': Object.assign(p, { restitution: 0.25, friction: 0.3, rolling: 0.065 }); break;
    case 'fairway': case 'tee': Object.assign(p, { restitution: 0.35, friction: 0.35, rolling: 0.11 }); break;
    case 'rough': Object.assign(p, { restitution: 0.22, friction: 0.55, rolling: 0.3 }); break;
    case 'deepRough': Object.assign(p, { restitution: 0.12, friction: 0.7, rolling: 0.6 }); break;
    case 'bunker': Object.assign(p, { restitution: 0.05, friction: 0.9, rolling: 1.5 }); break;
    case 'water': Object.assign(p, { restitution: 0, friction: 1, rolling: 5 }); break;
    default: break;
  }
  return p;
}
