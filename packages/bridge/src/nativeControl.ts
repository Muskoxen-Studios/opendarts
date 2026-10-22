import { BoardStatusSchema } from '@darts/schema';
import { z } from 'zod';
import type { BoardAction, BoardCommandResult } from './boardControl.ts';
import { describeFetchError } from './fetchError.ts';

export const NATIVE_DEFAULT_URL = 'http://127.0.0.1:8091';
export const NATIVE_ACTIONS = ['start', 'stop', 'reset'] as const;

// Only fields useful to the common board controls cross this boundary. Detector
// diagnostics remain available separately through the native-only state proxy.
const StateSchema = z.object({
  connected: z.boolean().default(true),
  running: z.boolean(),
  status: BoardStatusSchema,
  numThrows: z.number().int().nonnegative().optional(),
  occupancy: z.number().int().nonnegative().optional(),
}).transform(({ occupancy, ...state }) => ({
  ...state,
  // The shared UI labels this count "in board": physical occupancy is the
  // native equivalent, and unlike a detection counter it survives reset.
  ...(state.numThrows === undefined && occupancy !== undefined ? { numThrows: occupancy } : {}),
}));
export const NativeSimThrowSchema = z.object({
  x_mm: z.number().finite(),
  y_mm: z.number().finite(),
}).strict();
export const NativeSimTakeoutSchema = z.object({ count: z.number().int().positive().optional() }).strict();
export const NativeSimResetSchema = z.object({}).strict();

export async function nativeRequest(baseUrl: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    signal: AbortSignal.timeout(4000),
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

export async function nativeBoardState(baseUrl: string): Promise<BoardCommandResult> {
  try {
    const response = await nativeRequest(baseUrl, '/state');
    if (!response.ok) return { ok: false, error: `detector returned ${response.status} for /state` };
    return { ok: true, state: StateSchema.parse(await response.json()) };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, baseUrl) };
  }
}

export async function nativeBoardCommand(baseUrl: string, action: BoardAction): Promise<BoardCommandResult> {
  if (action === 'calibrate') return { ok: false, error: 'native detector does not support auto-calibration' };
  try {
    const response = await nativeRequest(baseUrl, `/control/${action}`, 'POST');
    if (!response.ok) return { ok: false, error: `detector refused to ${action} (${response.status})` };
    // The contract does not promise a command response body (204 is valid).
    await response.body?.cancel();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, baseUrl) };
  }
}

export async function nativeHealth(baseUrl: string): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const started = Date.now();
  try {
    const response = await nativeRequest(baseUrl, '/health');
    await response.body?.cancel();
    return response.ok
      ? { ok: true, latencyMs: Date.now() - started }
      : { ok: false, error: `detector returned ${response.status} for /health` };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, baseUrl) };
  }
}
