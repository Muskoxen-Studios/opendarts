import { segmentValue, type BoardEvent, type BoardStatus, type Coords, type Segment } from '@darts/schema';
import { normalizeThrow, ThrowShapeError } from '../adapters/autodarts.ts';
import type { EventSink, Source } from './types.ts';

export interface AutodartsOptions {
  baseUrl: string;
  /** Forward the 30/s motion channel. Debugging only -- it is very noisy. */
  debugMotion?: boolean;
  /** Consider the board offline after this long without a `stats` frame. */
  heartbeatTimeoutMs?: number;
}

/**
 * Live source: the Autodarts Board Manager over its local websocket.
 *
 * Transport behaviour here is CONFIRMED against a real board (see
 * recon/FINDINGS.md), even though the throw payload inside `state` is not:
 *   - `/api/events` needs no auth and no subscribe frame; the server pushes
 *   - `motion_state` arrives at ~30/s and is dropped unless explicitly enabled
 *   - `state` is EDGE-TRIGGERED: it went completely silent for 45s on an idle
 *     board, so it must never be treated as a liveness signal
 *   - `stats` arrives at ~1/s and is the heartbeat we actually trust
 */
export function autodartsSource(opts: AutodartsOptions): Source {
  const wsUrl = opts.baseUrl.replace(/^http/, 'ws') + '/api/events';
  const heartbeatTimeout = opts.heartbeatTimeoutMs ?? 10_000;

  let socket: WebSocket | null = null;
  let closed = false;
  let backoff = 500;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let online = false;
  /** Number of darts already emitted for the current visit to the board. */
  let emittedThrows = 0;
  let currentEmit: EventSink | null = null;
  let manualSeq = 0;
  /**
   * Set when *we* zeroed the board's throw counter, so the shrinking
   * `throws[]` that follows is re-baselined silently instead of being read as
   * a takeout. See `noteCounterReset`.
   */
  let counterResetPending = false;

  const connect = (emit: EventSink): void => {
    if (closed) return;
    const ws = new WebSocket(wsUrl);
    socket = ws;

    ws.onopen = () => {
      backoff = 500;
      online = true;
      emit({ type: 'board.connected' });
    };

    ws.onmessage = (ev: MessageEvent) => {
      let frame: { type?: string; data?: unknown };
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      handleFrame(frame, emit);
    };

    ws.onerror = () => {
      // onclose always follows; reconnection is handled there.
    };

    ws.onclose = () => {
      if (online) {
        online = false;
        emit({ type: 'board.disconnected', reason: 'socket closed' });
      }
      socket = null;
      if (closed) return;
      // Exponential backoff, unlike the stock UI's flat 1s retry.
      setTimeout(() => connect(emit), backoff);
      backoff = Math.min(backoff * 2, 15_000);
    };
  };

  const armHeartbeat = (emit: EventSink): void => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (online) {
        online = false;
        emit({ type: 'board.disconnected', reason: 'no heartbeat' });
      }
    }, heartbeatTimeout);
  };

  const handleFrame = (frame: { type?: string; data?: unknown }, emit: EventSink): void => {
    switch (frame.type) {
      case 'stats': {
        const data = frame.data as { fps?: number } | undefined;
        if (!online) {
          online = true;
          emit({ type: 'board.connected' });
        }
        emit({ type: 'board.heartbeat', fps: data?.fps });
        armHeartbeat(emit);
        return;
      }

      case 'motion_state': {
        // 30 frames a second of camera telemetry. Dropped by default.
        if (!opts.debugMotion) return;
        return;
      }

      case 'state': {
        const data = frame.data as
          | { status?: string; running?: boolean; throws?: unknown[]; event?: string }
          | undefined;
        if (!data) return;

        if (data.status) {
          emit({
            type: 'board.status',
            status: data.status as BoardStatus,
            running: Boolean(data.running),
          });
        }

        if (data.status === 'Takeout in progress') emit({ type: 'takeout.started' });

        const throws = Array.isArray(data.throws) ? data.throws : [];

        // The board appears to report the whole set of darts currently in the
        // board rather than just the newest one, so only emit what we have not
        // already seen. If the array shrinks, the darts were pulled out.
        // TODO(payload): confirm whether throws[] is cumulative for the turn.
        if (throws.length < emittedThrows) {
          emittedThrows = throws.length;
          // A reset we asked for is not a takeout: nobody pulled a dart out,
          // so the turn in progress must survive it.
          if (counterResetPending) {
            counterResetPending = false;
          } else {
            emit({ type: 'takeout.completed' });
          }
        }

        for (let i = emittedThrows; i < throws.length; i++) {
          try {
            const dart = normalizeThrow(throws[i]);
            emit({ type: 'throw.detected', throw: dart });
          } catch (err) {
            if (err instanceof ThrowShapeError) {
              // Loud, but do not take the bridge down: the operator needs the
              // raw frame in the logs in order to fix the adapter.
              console.error('[bridge] throw payload did not match expectations');
              console.error(err.message);
            } else {
              throw err;
            }
          }
        }
        emittedThrows = throws.length;
        return;
      }

      default:
        return;
    }
  };

  return {
    name: 'autodarts',
    start(emit) {
      closed = false;
      currentEmit = emit;
      connect(emit);
      armHeartbeat(emit);
    },
    stop() {
      closed = true;
      currentEmit = null;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      socket?.close();
      socket = null;
    },
    /**
     * The camera occasionally misses a dart outright, leaving nothing in
     * `throws[]` to correct. This lets an operator hand-enter the dart it
     * missed, same as the simulator, without waiting for the board to agree.
     *
     * `emittedThrows` is bumped along with it so the count stays in step: the
     * board's own array only ever grows by darts *it* saw, so a manual entry
     * would otherwise make the next real dart look like a repeat.
     */
    /**
     * The operator pressed Reset: the board's own throw counter is about to go
     * back to zero with the darts still in the board.
     *
     * Reset is a detection control -- it is pressed mid-visit when the board
     * has miscounted -- so it must not end the player's turn. Without this the
     * shrinking `throws[]` reads exactly like a takeout and the scoreboard
     * hands over. One reset arms one silent shrink; anything else is a real
     * takeout.
     */
    noteCounterReset() {
      counterResetPending = true;
    },

    inject(segment: Segment, coords?: Coords | null) {
      if (!currentEmit) return;
      const ts = new Date().toISOString();
      emittedThrows += 1;
      currentEmit({
        type: 'throw.detected',
        throw: {
          id: `ad-manual-${ts}-${manualSeq++}`,
          ts,
          segment,
          value: segmentValue(segment),
          coords: coords ?? null,
          source: 'manual',
        },
      });
    },
  };
}

/** Exported for tests: recompute a dart's value from its segment. */
export { segmentValue };
