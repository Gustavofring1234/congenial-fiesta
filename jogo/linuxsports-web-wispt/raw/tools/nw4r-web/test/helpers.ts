import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Raiz do projeto do jogo (dados reais). Os testes com dados reais são pulados se não existirem. */
export const GAME_ROOT = resolve(__dirname, '../../..');
export const hasGameData = existsSync(join(GAME_ROOT, 'src/core/shared'));

export function findFiles(ext: string, limit = Infinity): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      if (out.length >= limit) return;
      if (n === 'tools' || n === 'models_glb' || n === 'node_modules') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.toLowerCase().endsWith(ext)) out.push(p);
    }
  };
  if (hasGameData) walk(GAME_ROOT);
  return out;
}

export const read = (p: string) => new Uint8Array(readFileSync(p));
