import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CAMERAS = [0, 1, 2];
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Store board-reported position/labels and simultaneous camera stills. */
export function createBoardDataCollector({ source, snapshot, stateSnapshot, boardUrl, outputDir,
  calibrationSnapshot,
  pollIntervalMs = 5000, now = () => new Date(), logger = console }) {
  const seen = new Set();
  const pending = new Set();
  let stopped = false;
  let baselineId = null;
  let baselinePending = false;
  let calibration = { id: null, path: null, lastReadAt: null, lastAttemptAt: null, error: 'not yet read' };
  let calibrationPolling = false;
  let calibrationTimer = null;

  const pollCalibration = async () => {
    if (!calibrationSnapshot || calibrationPolling || stopped) return;
    calibrationPolling = true;
    try {
      const value = await calibrationSnapshot();
      const readAt = now().toISOString();
      const json = `${JSON.stringify(value, null, 2)}\n`;
      const id = createHash('sha256').update(json).digest('hex');
      const relativePath = `_calibrations/${id}.json`;
      const directory = join(outputDir, '_calibrations');
      const destination = join(outputDir, relativePath);
      await mkdir(directory, { recursive: true });
      try { await stat(destination); }
      catch {
        const temporary = join(directory, `.partial-${id}-${randomUUID()}`);
        try {
          await writeFile(temporary, json, { flag: 'wx' });
          await rename(temporary, destination);
        } catch (error) {
          await rm(temporary, { force: true });
          // Another poll may have published the same content hash first.
          try { await stat(destination); } catch { throw error; }
        }
      }
      const changed = calibration.id !== id;
      calibration = { id, path: relativePath, lastReadAt: readAt, lastAttemptAt: readAt, error: null };
      if (changed) logger.info(`[collector] calibration snapshot ${id} path=${destination} readAt=${readAt}`);
    } catch (error) {
      calibration = { ...calibration, lastAttemptAt: now().toISOString(),
        error: error instanceof Error ? error.message : String(error) };
      logger.warn(`[collector] calibration read unavailable at ${calibration.lastAttemptAt}: ${calibration.error}`);
    } finally { calibrationPolling = false; }
  };

  const track = (promise) => {
    const task = promise.catch((error) => logger.error('[collector] capture failed', error));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const persist = async ({ type, startedAt, reportedThrow = null, occupancyBefore = null, occupancyBeforePromise = null,
    baselineReason = null, baselineForThrow = null }) => {
    const calibrationAtCapture = { ...calibration };
    const captureId = `${now().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`;
    const staging = join(outputDir, `.partial-${captureId}`);
    const destination = join(outputDir, captureId);
    await mkdir(staging, { recursive: false });
    const cameraWork = CAMERAS.map(async (camera) => {
      const requestedAt = now().toISOString();
      try {
        const image = await snapshot(camera);
        const extension = EXTENSIONS[image.contentType];
        if (!extension || !Buffer.isBuffer(image.bytes) || image.bytes.length === 0) {
          throw new Error('snapshot did not return a supported non-empty image');
        }
        const file = `camera-${camera}.${extension}`;
        await writeFile(join(staging, file), image.bytes, { flag: 'wx' });
        return { camera, file, contentType: image.contentType, bytes: image.bytes.length,
          requestedAt, receivedAt: image.receivedAt ?? now().toISOString(), error: null };
      } catch (error) {
        return { camera, file: null, contentType: null, bytes: 0, requestedAt, receivedAt: now().toISOString(),
          error: error instanceof Error ? error.message : String(error) };
      }
    });
    const [cameras, capturedBefore] = await Promise.all([
      Promise.all(cameraWork), occupancyBeforePromise ?? Promise.resolve(occupancyBefore),
    ]);
    occupancyBefore = capturedBefore;
    let occupancyAfter = null;
    try { if (stateSnapshot) occupancyAfter = await stateSnapshot(); } catch { /* Keep the images and record the unavailable observation. */ }
    const manifest = {
      format: 'darts-board-capture-v1', captureId, type,
      captureStartedAt: startedAt, captureFinishedAt: now().toISOString(),
      provenance: { source: 'board', adapter: 'autodarts', detector: null, boardUrl: boardUrl ?? null },
      calibration: calibrationAtCapture,
      coordinateSpace: { units: 'mm', x: 'right', y: 'up', origin: 'bull' },
      baselineReason, baselineForThrow,
      reportedThrow: reportedThrow ? {
        id: reportedThrow.id, ts: reportedThrow.ts, segment: reportedThrow.segment,
        value: reportedThrow.value, coords: reportedThrow.coords,
      } : null,
      reportedOccupancyBefore: occupancyBefore,
      reportedOccupancyAfter: occupancyAfter,
      sceneChangedDuringCapture: occupancyBefore && occupancyAfter ? (
        occupancyBefore.connected !== occupancyAfter.connected || occupancyBefore.status !== occupancyAfter.status ||
        JSON.stringify(occupancyBefore.throws) !== JSON.stringify(occupancyAfter.throws)) : null,
      cameras,
      status: cameras.every((camera) => camera.file) ? 'complete' : 'partial',
    };
    try {
      await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
      await rename(staging, destination);
      const segment = reportedThrow ? `segment=${reportedThrow.segment.number}/${reportedThrow.segment.ring} coords=${JSON.stringify(reportedThrow.coords)}` : '';
      const cameraCount = cameras.filter((camera) => camera.file).length;
      const details = cameras.filter((camera) => camera.error).map((camera) => `cam${camera.camera}: ${camera.error}`).join('; ');
      const line = `[collector] ${manifest.status} ${type} ${segment} cameras=${cameraCount}/3 path=${destination}`;
      if (manifest.status === 'partial') logger.error(`${line}; ${details}`);
      else logger.info(line);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return manifest;
  };

  const captureThrow = async (event) => {
    const dart = event.throw;
    if (seen.has(dart.id)) return;
    seen.add(dart.id);
    if (seen.size > 4096) seen.delete(seen.values().next().value);
    const startedAt = now().toISOString();
    const occupancyBeforePromise = stateSnapshot ? stateSnapshot().catch(() => null) : Promise.resolve(null);
    const manifest = await persist({ type: 'throw', startedAt, reportedThrow: dart, occupancyBeforePromise,
      baselineForThrow: baselineId });
    return manifest;
  };

  const captureBaseline = async (reason) => {
    if (!stateSnapshot || stopped || baselinePending) return;
    baselinePending = true;
    try {
      let occupancy;
      try { occupancy = await stateSnapshot(); } catch { return; }
      if (occupancy?.connected !== true || occupancy.running !== true || occupancy.status !== 'Throw' || occupancy.throws?.length !== 0) return;
      const manifest = await persist({ type: 'empty-board-baseline', startedAt: now().toISOString(),
        occupancyBefore: occupancy, baselineReason: reason });
      if (manifest.status === 'complete' && manifest.reportedOccupancyAfter?.connected === true &&
          manifest.reportedOccupancyAfter.running === true && manifest.reportedOccupancyAfter.status === 'Throw' &&
          manifest.reportedOccupancyAfter.throws?.length === 0 && !manifest.sceneChangedDuringCapture) {
        baselineId = manifest.captureId;
      }
    } finally { baselinePending = false; }
  };

  let lastBoardOnline = null;
  let polling = false;
  let pollTimer = null;
  const pollBoard = async () => {
    if (!stateSnapshot || polling || stopped) return;
    polling = true;
    let online = false;
    try {
      const state = await stateSnapshot();
      online = state?.connected === true;
      if (online && lastBoardOnline !== true) void pollCalibration();
      if (online && (lastBoardOnline !== true || (!baselineId && state.running === true && state.throws?.length === 0))) {
        track(captureBaseline('board-ready'));
      }
      if (state?.running !== true) baselineId = null;
    } catch { /* A failed state poll is an offline observation. */ }
    if (lastBoardOnline !== online) {
      logger.info(online ? '[collector] board online' : '[collector] board offline; polling for reconnection');
      lastBoardOnline = online;
    }
    if (!online) baselineId = null;
    polling = false;
  };

  const onEvent = (event) => {
    if (stopped) return;
    if (event.type === 'throw.detected') track(captureThrow(event));
    else if (event.type === 'board.connected') void pollBoard();
    else if (event.type === 'takeout.completed') track(captureBaseline('takeout-completed'));
    else if (event.type === 'takeout.started') baselineId = null;
    else if (event.type === 'board.disconnected') {
      baselineId = null;
      logger.warn(`[collector] board offline: ${event.reason ?? 'connection lost'}`);
    }
  };

  return {
    async start() {
      await mkdir(outputDir, { recursive: true });
      await source.start(onEvent);
      void pollCalibration();
      calibrationTimer = setInterval(() => void pollCalibration(), 60_000);
      void pollBoard();
      pollTimer = setInterval(() => void pollBoard(), pollIntervalMs);
      logger.info(`[collector] listening; output=${outputDir}`);
    },
    async stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (calibrationTimer) clearInterval(calibrationTimer);
      await source.stop();
      await Promise.allSettled([...pending]);
    },
  };
}
