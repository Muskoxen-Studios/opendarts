#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autodartsSource, boardCalibrationSnapshot, boardCameraSnapshot, boardState, normalizeReportedOccupancy } from '../packages/bridge/src/index.ts';
import { createBoardDataCollector } from './board-data-collector.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
function envFileValue(contents, name) {
  const line = contents.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${name}=`));
  if (!line) return undefined;
  return line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
}

let fileEnv = '';
try { fileEnv = await readFile(resolve(root, '.env'), 'utf8'); } catch { /* Environment variables may provide configuration. */ }
const boardUrl = process.env.BOARD_URL ?? envFileValue(fileEnv, 'BOARD_URL');
if (!boardUrl) throw new Error('Set BOARD_URL in the environment or repository .env file.');
const outputDir = resolve(process.env.BOARD_CAPTURE_DIR ?? resolve(root, 'data/board-captures'));
const source = autodartsSource({ baseUrl: boardUrl });
const collector = createBoardDataCollector({
  source,
  boardUrl,
  outputDir,
  snapshot: (camera) => boardCameraSnapshot(boardUrl, camera),
  calibrationSnapshot: () => boardCalibrationSnapshot(boardUrl),
  stateSnapshot: async () => {
    const result = await boardState(boardUrl);
    if (!result.ok || !result.state) throw new Error(result.error ?? 'board state unavailable');
    return normalizeReportedOccupancy(result.state);
  },
});

await collector.start();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log(`[collector] ${signal}, stopping`);
    void collector.stop().then(() => process.exit(0));
  });
}
