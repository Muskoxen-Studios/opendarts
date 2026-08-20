/**
 * The periodic channels, at the rates measured on the real board (FINDINGS §1).
 *
 * Frame bodies are shaped after recon/captures/live-ws-*.ndjson. Only `stats`
 * matters to the bridge — it is the heartbeat — but emitting the noisy channels
 * too is the point: it proves the bridge really does drop 30 frames a second of
 * camera telemetry instead of treating any of it as a dart.
 */

export const CAM_IDS = ['0', '1', '2'] as const;
export const RESOLUTION = '1280x720';
export const FPS = 30;

export type Broadcast = (type: string, data: unknown) => void;

export interface FrameOptions {
  /**
   * Emit the 30/s motion channel. Off by default: it is 30 timers-worth of
   * garbage per second and every test run would pay for it. Turn on with
   * FAKE_MOTION=1 when exercising the bridge's motion suppression by hand.
   */
  motion?: boolean;
}

function camState(backgroundPixels: number) {
  return {
    backgroundPixels,
    boardPixels: 0,
    dartBackgroundPixels: 0,
    dartPixels: 0,
    takeoutBackgroundPixels: 0,
    takeoutPixels: 0,
    isStable: true,
    isHand: false,
    isDart: false,
    isTakeout: false,
  };
}

export function statsFrame() {
  return { fps: FPS, resolution: RESOLUTION };
}

export function camStatsFrame(id: string) {
  return { id, fps: FPS, resolution: RESOLUTION };
}

export function motionStateFrame(frame: number) {
  return {
    darts: 0,
    camStates: CAM_IDS.map((_, i) => camState((frame * 7 + i * 53) % 300)),
    class: 0,
    timings: { copy: 0, diff: 181400, count: 0, takeout: 0, state: 0, ret: 0, total: 1058700 },
    isWaiting: false,
    isStable: true,
    isDart: false,
    isHand: false,
    isTakeoutPartial: false,
    isTakeoutFull: false,
    frameCounts: { stable: 3, dart: 0, hand: 0, takeout: 0, wait: 0 },
    frameFlags: { dart: false, hand: false, takeout: false },
  };
}

/** Starts the periodic emitters. Returns a stop function. */
export function startPeriodicFrames(broadcast: Broadcast, opts: FrameOptions = {}): () => void {
  const timers: NodeJS.Timeout[] = [];

  timers.push(setInterval(() => broadcast('stats', statsFrame()), 1000));

  // 3/s overall: one frame per camera per second.
  for (const id of CAM_IDS) {
    timers.push(setInterval(() => broadcast('cam_stats', camStatsFrame(id)), 1000));
  }

  if (opts.motion) {
    let frame = 0;
    timers.push(
      setInterval(() => broadcast('motion_state', motionStateFrame(frame++)), 1000 / FPS),
    );
  }

  // Without this the fake board keeps the Node event loop alive forever, which
  // would hang a test run that forgot to close it.
  for (const t of timers) t.unref?.();

  return () => {
    for (const t of timers) clearInterval(t);
  };
}
