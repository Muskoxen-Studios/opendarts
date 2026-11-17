import { describeFetchError } from './fetchError.ts';
import { normalizeStatus, type RawThrow } from './adapters/autodarts.ts';

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
export type RawBoardThrow = RawThrow;

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
    const state = (await res.json()) as RawBoardState;
    return { ok: true, state: {
      ...state,
      status: normalizeStatus(state.status),
      numThrows: state.numThrows ?? state.throws?.length ?? 0,
    } };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, base) };
  }
}

/** Read only the calibration subtree from the board's system endpoint. */
export async function boardCalibrationSnapshot(baseUrl: string, fetcher: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}/api/system`;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    if (!res.ok) throw new Error(`board returned ${res.status} for /api/system`);
    const system: unknown = await res.json();
    if (!system || typeof system !== 'object' || !('calibration' in system) ||
        !system.calibration || typeof system.calibration !== 'object') {
      throw new Error('board /api/system response has no calibration object');
    }
    return structuredClone(system.calibration);
  } catch (err) {
    const message = err instanceof Error && err.message !== 'fetch failed'
      ? err.message : describeFetchError(err, base);
    throw new Error(message, { cause: err });
  }
}

/** Still-frame URL derived from the Board Manager UI's confirmed camera stream
 * URL by replacing `streams` with `img`. The exact still endpoint is inferred
 * from the captured UI bundle and remains unverified against current hardware. */
export async function boardCameraSnapshot(baseUrl: string, camera: 0 | 1 | 2, fetcher: typeof fetch = fetch) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/img/cams/${camera}`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  if (!response.ok) throw new Error(`camera ${camera} snapshot returned HTTP ${response.status}`);
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    await response.body?.cancel();
    throw new Error(`camera ${camera} snapshot returned non-image content (${contentType || 'unknown'})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const signatures = {
    'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9,
    'image/webp': bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
  };
  if (!bytes.length || !signatures[contentType as keyof typeof signatures]) {
    throw new Error(`camera ${camera} snapshot has an invalid ${contentType} image signature`);
  }
  return { bytes, contentType, receivedAt: new Date().toISOString() };
}
