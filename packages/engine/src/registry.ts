import { conquestEngine } from './conquest.ts';
import { countUpEngine } from './countUp.ts';
import { aroundTheClockEngine } from './aroundTheClock.ts';
import { randomCheckoutEngine } from './randomCheckout.ts';
import { roundTheWorldEngine } from './roundTheWorld.ts';
import { segmentTrainingEngine } from './segmentTraining.ts';
import { bobs27Engine } from './bobs27.ts';
import { training121Engine } from './training121.ts';
import type { GameConfig, GameType } from '@darts/schema';
import { cricketEngine } from './cricket.ts';
import { evenOddEngine } from './evenOdd.ts';
import { golfEngine } from './golf.ts';
import { gotchaEngine } from './gotcha.ts';
import { minefieldEngine } from './minefield.ts';
import { killerEngine } from './killer.ts';
import { shanghaiEngine } from './shanghai.ts';
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
  countup: countUpEngine as unknown as AnyEngine,
  aroundtheclock: aroundTheClockEngine as unknown as AnyEngine,
  randomcheckout: randomCheckoutEngine as unknown as AnyEngine,
  roundtheworld: roundTheWorldEngine as unknown as AnyEngine,
  segmenttraining: segmentTrainingEngine as unknown as AnyEngine,
  bobs27: bobs27Engine as unknown as AnyEngine,
  '121': training121Engine as unknown as AnyEngine,
  conquest: conquestEngine as unknown as AnyEngine,
  x01: x01Engine as unknown as AnyEngine,
  cricket: cricketEngine as unknown as AnyEngine,
  gotcha: gotchaEngine as unknown as AnyEngine,
  golf: golfEngine as unknown as AnyEngine,
  shanghai: shanghaiEngine as unknown as AnyEngine,
  killer: killerEngine as unknown as AnyEngine,
  evenodd: evenOddEngine as unknown as AnyEngine,
  minefield: minefieldEngine as unknown as AnyEngine,
};

export function engineFor(gameType: GameType): AnyEngine {
  const e = engines[gameType];
  if (!e) throw new Error(`unknown game type: ${gameType}`);
  return e;
}

export const GAME_TYPES = Object.keys(engines) as GameType[];
