import type { GameConfig, GameType } from '@darts/schema';
import { cricketEngine } from './cricket.ts';
import { golfEngine } from './golf.ts';
import { gotchaEngine } from './gotcha.ts';
import type { GameEngine } from './types.ts';
import { x01Engine } from './x01.ts';

/**
 * Engine registry.
 *
 * Adding a game is one new file plus one entry here. The state type is erased
 * to `unknown` at this boundary; every cast lives in match.ts and nowhere else.
 */
export type AnyEngine = GameEngine<GameConfig, unknown>;

export const engines: Record<GameType, AnyEngine> = {
  x01: x01Engine as unknown as AnyEngine,
  cricket: cricketEngine as unknown as AnyEngine,
  gotcha: gotchaEngine as unknown as AnyEngine,
  golf: golfEngine as unknown as AnyEngine,
};

export function engineFor(gameType: GameType): AnyEngine {
  const e = engines[gameType];
  if (!e) throw new Error(`unknown game type: ${gameType}`);
  return e;
}

export const GAME_TYPES = Object.keys(engines) as GameType[];
