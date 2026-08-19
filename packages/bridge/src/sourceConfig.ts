import { z } from 'zod';
import { autodartsSource } from './sources/autodarts.ts';
import { replaySource } from './sources/replay.ts';
import { simulatorSource } from './sources/simulator.ts';
import type { Source } from './sources/types.ts';

/**
 * Where the bridge gets its darts from. Switchable at runtime so a board can be
 * swapped for the simulator without redeploying anything.
 */
export const SourceConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('simulator') }),
  z.object({
    kind: z.literal('autodarts'),
    url: z.string().url(),
    debugMotion: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('replay'),
    file: z.string().min(1),
    speed: z.number().positive().max(100).default(1),
    loop: z.boolean().default(false),
  }),
]);

export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export function buildSource(config: SourceConfig): Source {
  switch (config.kind) {
    case 'autodarts':
      return autodartsSource({ baseUrl: config.url, debugMotion: config.debugMotion });
    case 'replay':
      return replaySource({ file: config.file, speed: config.speed, loop: config.loop });
    case 'simulator':
      return simulatorSource();
  }
}

/** The starting configuration, taken from the environment. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SourceConfig {
  const kind = (env.SOURCE ?? 'simulator').toLowerCase();
  if (kind === 'autodarts') {
    return {
      kind: 'autodarts',
      url: env.BOARD_URL ?? 'http://192.168.120.40:3180',
      debugMotion: env.DEBUG_MOTION === '1',
    };
  }
  if (kind === 'replay') {
    return {
      kind: 'replay',
      file: env.REPLAY_FILE ?? 'recon/captures/live.ndjson',
      speed: Number(env.REPLAY_SPEED ?? 1),
      loop: env.REPLAY_LOOP === '1',
    };
  }
  return { kind: 'simulator' };
}

/** Human-readable one-liner for logs and the settings screen. */
export function describeSource(config: SourceConfig): string {
  switch (config.kind) {
    case 'autodarts':
      return `autodarts (${config.url})`;
    case 'replay':
      return `replay (${config.file} at ${config.speed}x)`;
    case 'simulator':
      return 'simulator';
  }
}
