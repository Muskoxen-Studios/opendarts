import { describeFetchError } from './fetchError.ts';

/**
 * The Board Manager's local control API.
 *
 * Along with `adapters/autodarts.ts` this is one of only two files that know
 * Autodarts paths. Everything here is CONFIRMED against a real board
 * (recon/FINDINGS.md §2): the paths, the methods, the fact that none of it
 * needs authentication, and (§3) the shape of `throws[]` in `/api/state`.
 *
 * These are the board's own controls, exposed as they are rather than dressed
 * up as game commands: "start" starts detection, it does not start a match.
 */
export const BOARD_ACTIONS = {
  start: { method: 'PUT', path: '/api/start', label: 'start detection' },
  stop: { method: 'PUT', path: '/api/stop', label: 'stop detection' },
  reset: { method: 'POST', path: '/api/reset', label: 'reset the throw counter' },
  calibrate: {
    method: 'POST',
    path: '/api/config/calibration/auto',
    label: 'auto-calibrate',
  },
} as const;

export type BoardAction = keyof typeof BOARD_ACTIONS;

export function isBoardAction(value: string): value is BoardAction {
  return Object.hasOwn(BOARD_ACTIONS, value);
}

/**
 * The raw shape of `GET /api/state`, confirmed against a real board
 * (recon/FINDINGS.md §3). `throws` is cumulative for the current visit to the
 * board and is absent -- not `[]` -- once a takeout has finished.
 */
export interface RawBoardThrow {
  segment: { name: string; bed: string; number?: number; multiplier?: number };
  coords?: { x: number; y: number };
}

export interface RawBoardState {
  connected: boolean;
  running: boolean;
  status: string;
  event: string;
  numThrows: number;
  throws?: RawBoardThrow[];
}

export interface BoardCommandResult {
  ok: boolean;
  /** The board's own state after the command, when it returned one. */
  state?: unknown;
  error?: string;
}

// Matches the deadline `describeFetchError` names in its timeout message.
const TIMEOUT_MS = 4000;

/**
 * Run one control command against the board.
 *
 * Failures come back as `{ ok: false, error }` rather than as a thrown error:
 * a board that is unplugged is an ordinary thing for this endpoint to find, and
 * the caller is a row of buttons that needs a message to show.
 */
export async function boardCommand(
  baseUrl: string,
  action: BoardAction,
): Promise<BoardCommandResult> {
  const base = baseUrl.replace(/\/$/, '');
  const { method, path, label } = BOARD_ACTIONS[action];
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `board refused to ${label} (${res.status})` };
    return { ok: true, state: await res.json().catch(() => null) };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, base) };
  }
}

/**
 * A snapshot of the board: `{connected, running, status, event, numThrows}`.
 *
 * Polled by the UI for its indicator. Deliberately separate from the websocket
 * `state` channel, which is edge-triggered (FINDINGS §1) and so cannot answer
 * "what is the board doing right now" for a screen that just opened.
 */
export async function boardState(baseUrl: string): Promise<BoardCommandResult & { state?: RawBoardState }> {
  const base = baseUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `board returned ${res.status} for /api/state` };
    return { ok: true, state: (await res.json()) as RawBoardState };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, base) };
  }
}
