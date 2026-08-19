import { BoardEventSchema, type BoardEvent } from '@darts/schema';

/**
 * Client for the bridge's event websocket.
 *
 * Every frame is validated against our own schema before it reaches game
 * logic. If the bridge is ever wrong, it fails here rather than silently
 * corrupting a match.
 */
export interface BridgeClientOptions {
  /**
   * Called whenever the connection is (re-)established.
   *
   * The server owns the persisted source configuration, so it has to push it
   * to the bridge on every connect -- otherwise a bridge restart would silently
   * revert to whatever its environment said.
   */
  onConnect?: () => void;
}

export function connectToBridge(
  url: string,
  onEvent: (e: BoardEvent) => void,
  options: BridgeClientOptions = {},
): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const connect = (): void => {
    if (closed) return;
    const ws = new WebSocket(url);
    socket = ws;

    ws.onopen = () => {
      backoff = 500;
      console.log(`[server] connected to bridge at ${url}`);
      options.onConnect?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const parsed = BoardEventSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn('[server] discarded malformed bridge event:', parsed.error.message);
        return;
      }
      onEvent(parsed.data);
    };

    ws.onclose = () => {
      socket = null;
      if (closed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };

    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
  };

  connect();
  return () => {
    closed = true;
    socket?.close();
  };
}
