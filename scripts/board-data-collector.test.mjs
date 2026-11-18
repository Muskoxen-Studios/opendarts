import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startFakeBoard } from '../packages/fakeboard/src/index.ts';
import { autodartsSource } from '../packages/bridge/src/sources/autodarts.ts';
import { createBoardDataCollector } from './board-data-collector.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for collector event');
}

test('retries an offline board, reconnects, and atomically saves all three camera bytes with board position', async () => {
  const port = await freePort();
  const outputDir = await mkdtemp(join(tmpdir(), 'darts-captures-'));
  const events = [];
  const rawSource = autodartsSource({ baseUrl: `http://127.0.0.1:${port}`, pollIntervalMs: 100, heartbeatTimeoutMs: 500 });
  const source = { ...rawSource, start: (emit) => rawSource.start((event) => { events.push(event); emit(event); }) };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const collector = createBoardDataCollector({
    source,
    outputDir,
    now: () => new Date('2026-10-01T12:00:00.000Z'),
    logger: { info() {}, warn() {}, error() {} },
    snapshot: async (camera) => ({ bytes: Buffer.concat([png, Buffer.from(`camera-${camera}`)]), contentType: 'image/png' }),
    stateSnapshot: async () => ({ connected: true, throws: [] }),
  });
  let fake;
  try {
    await collector.start();
    fake = await startFakeBoard({ port, autoStart: true });
    await until(() => events.some((event) => event.type === 'board.connected'));
    fake.disconnect(150);
    await until(() => events.filter((event) => event.type === 'board.connected').length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await fetch(`${fake.url}/sim/throw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ segment: 'T20' }) });
    await until(() => events.some((event) => event.type === 'throw.detected'));
    let folders = [];
    await until(async () => {
      folders = (await readdir(outputDir)).filter((name) => !name.startsWith('.partial-'));
      for (const name of folders) {
        try {
          if (JSON.parse(await readFile(join(outputDir, name, 'manifest.json'), 'utf8')).type === 'throw') return true;
        } catch { /* Atomic directory publication has not completed yet. */ }
      }
      return false;
    });
    const records = await Promise.all(folders.map(async (name) => ({ folder: join(outputDir, name),
      manifest: JSON.parse(await readFile(join(outputDir, name, 'manifest.json'), 'utf8')) })));
    const baseline = records.find((record) => record.manifest.type === 'empty-board-baseline');
    const record = records.find((item) => item.manifest.type === 'throw');
    assert.ok(baseline);
    assert.ok(record);
    assert.equal(record.manifest.baselineForThrow, baseline.manifest.captureId);
    const manifest = record.manifest;
    assert.equal(manifest.provenance.source, 'board');
    assert.equal(manifest.provenance.adapter, 'autodarts');
    assert.equal(manifest.reportedThrow.segment.number, 20);
    assert.ok(manifest.reportedThrow.coords);
    assert.equal(manifest.coordinateSpace.units, 'mm');
    assert.equal(manifest.reportedOccupancyBefore.throws.length, 0);
    assert.equal(manifest.status, 'complete');
    assert.deepEqual(manifest.cameras.map((camera) => camera.camera), [0, 1, 2]);
    for (const camera of manifest.cameras) {
      assert.deepEqual((await readFile(join(record.folder, camera.file))).subarray(0, 8), png);
    }
  } finally {
    await collector.stop();
    await fake?.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});
