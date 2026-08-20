import { afterEach, describe, expect, it } from 'vitest';
import { startFakeBoard, type RunningFakeBoard } from '@darts/fakeboard';
import { boardCommand, boardState, isBoardAction } from './boardControl.ts';

/**
 * The board's control API, against a stand-in board.
 *
 * Unlike the throw payload, everything exercised here is CONFIRMED against real
 * hardware (FINDINGS §2), so a passing test means something: these are the real
 * paths and the real methods. What the fake proves is that we call them
 * correctly and report the answer honestly -- including when there is nothing
 * at the other end.
 */

let fake: RunningFakeBoard | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
});

async function board(): Promise<RunningFakeBoard> {
  fake = await startFakeBoard({ port: 0 });
  return fake;
}

/**
 * An address nothing is listening on: a fake board is started to claim a free
 * port and then closed again, which is more reliable than picking a number and
 * hoping. Ports 0-1023 and fetch's own blocked list are not usable here.
 */
async function deadUrl(): Promise<string> {
  const b = await startFakeBoard({ port: 0 });
  const url = b.url;
  await b.close();
  return url;
}

describe('board controls', () => {
  it('starts and stops detection', async () => {
    const b = await board();
    expect(b.board.running).toBe(false);

    const started = await boardCommand(b.url, 'start');
    expect(started.ok).toBe(true);
    expect(b.board.running).toBe(true);
    expect(started.state).toMatchObject({ running: true, status: 'Throw' });

    const stopped = await boardCommand(b.url, 'stop');
    expect(stopped.ok).toBe(true);
    expect(b.board.running).toBe(false);
    expect(stopped.state).toMatchObject({ running: false, status: 'Stopped' });
  });

  it('resets the throw counter without stopping detection', async () => {
    const b = await board();
    await boardCommand(b.url, 'start');
    b.board.throwDart({ number: 20, ring: 'TRIPLE' });
    expect(b.board.snapshot().numThrows).toBe(1);

    const reset = await boardCommand(b.url, 'reset');
    expect(reset.ok).toBe(true);
    expect(b.board.snapshot().numThrows).toBe(0);
    // The distinction that makes reset useful mid-match: darts go, detection stays.
    expect(b.board.running).toBe(true);
  });

  it('runs auto-calibration', async () => {
    const b = await board();
    await boardCommand(b.url, 'start');
    const result = await boardCommand(b.url, 'calibrate');
    expect(result.ok).toBe(true);
    // Calibration returns to armed on a running board.
    expect(result.state).toMatchObject({ event: 'Calibrated', running: true });
  });

  it('reads the board state for the indicator', async () => {
    const b = await board();
    await boardCommand(b.url, 'start');
    const state = await boardState(b.url);
    expect(state.ok).toBe(true);
    expect(state.state).toMatchObject({ connected: true, running: true, numThrows: 0 });
  });

  it('tolerates a trailing slash on the board url', async () => {
    const b = await board();
    const result = await boardCommand(`${b.url}/`, 'start');
    expect(result.ok).toBe(true);
  });

  it('reports an unreachable board as a message, not an exception', async () => {
    const result = await boardCommand(await deadUrl(), 'start');
    expect(result.ok).toBe(false);
    // The point of unwrapping the cause: "refused the connection" tells the
    // operator the address is right and the Board Manager is not running,
    // which bare "fetch failed" does not.
    expect(result.error).toContain('refused the connection');
  });

  it('reports an unreachable board when reading state too', async () => {
    const result = await boardState(await deadUrl());
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('reports a board that answers with an error status', async () => {
    const b = await board();
    // /api/img is a real path that this board refuses: it has no cameras.
    const result = await boardState(`${b.url}/api/img`);
    expect(result.ok).toBe(false);
  });

  it('only recognises the four documented actions', () => {
    expect(isBoardAction('start')).toBe(true);
    expect(isBoardAction('calibrate')).toBe(true);
    // No pass-through of arbitrary paths: an unknown action must never become
    // an arbitrary request against the board.
    expect(isBoardAction('config')).toBe(false);
    expect(isBoardAction('../config')).toBe(false);
  });
});
