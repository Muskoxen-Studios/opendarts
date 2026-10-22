#!/usr/bin/env node
// Requires Node 24+, Python 3, and the repository's installed workspace dependencies.
// Deliberately standalone: node scripts/test-native.mjs (not part of npm test).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
const events = [];
let temporary;
let socket;
let interrupted;
const deadline = Date.now() + 180_000;
const watchdog = setTimeout(() => { interrupted = 'overall 180-second timeout'; }, 180_000);
const onSignal = (signal) => { interrupted = signal; };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

function alive() {
  assert.ok(!interrupted, interrupted);
  assert.ok(Date.now() < deadline, 'overall 180-second timeout');
  for (const child of children) {
    assert.ok(!child.failure && child.process.exitCode === null && child.process.signalCode === null,
      `${child.name} exited unexpectedly: ${child.failure ?? child.process.exitCode ?? child.process.signalCode}`);
  }
}

async function poll(label, check, timeout = 20_000) {
  const until = Math.min(deadline, Date.now() + timeout);
  let last;
  while (Date.now() < until) {
    alive();
    try {
      const value = await check();
      if (value) return value;
      last = 'condition not met';
    } catch (error) { last = error.message; }
    await sleep(150);
  }
  throw new Error(`${label} timed out: ${last}`);
}

async function reservePorts() {
  const reservations = [];
  try {
    for (let i = 0; i < 3; i++) {
      const reservation = createServer();
      reservations.push(reservation);
      await new Promise((accept, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', accept);
      });
    }
    return reservations.map((reservation) => reservation.address().port);
  } finally {
    await Promise.all(reservations.map((reservation) => new Promise((accept) => reservation.close(accept))));
  }
}

function launch(name, command, args, env = {}) {
  const process = spawn(command, args, {
    cwd: root, env: { ...globalThis.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = { name, process, logs: '', failure: null };
  children.push(child);
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('data', (data) => { child.logs = (child.logs + data.toString()).slice(-48_000); });
  }
  process.on('error', (error) => { child.failure = error.message; });
  child.exited = new Promise((accept) => process.once('close', accept));
}

async function request(base, path, method = 'GET', body, status = 200) {
  alive();
  const response = await fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(5000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function cleanup() {
  socket?.close();
  for (const child of [...children].reverse()) {
    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGTERM');
  }
  await Promise.all(children.map(async (child) => {
    if (await Promise.race([child.exited.then(() => true), sleep(3000).then(() => false)])) return;
    child.process.kill('SIGKILL');
    assert.ok(await Promise.race([child.exited.then(() => true), sleep(3000).then(() => false)]),
      `${child.name} did not exit after SIGKILL`);
  }));
  if (temporary) await rm(temporary, { recursive: true, force: true });
}

try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required; Python 3 must be on PATH');

  temporary = await mkdtemp(join(tmpdir(), 'darts-native-smoke-'));
  const [detectorPort, bridgePort, serverPort] = await reservePorts();
  const detector = `http://127.0.0.1:${detectorPort}`;
  const bridge = `http://127.0.0.1:${bridgePort}`;
  const server = `http://127.0.0.1:${serverPort}`;
  launch('detector (Python 3 required)', 'python3', ['-B', 'services/detector/main.py', '--source', 'synthetic', '--port', String(detectorPort)]);
  await poll('detector health', async () => (await request(detector, '/health')).ok);
  launch('bridge', process.execPath, ['packages/bridge/src/main.ts'], {
    SOURCE: 'native', DETECTOR_URL: detector, BRIDGE_PORT: String(bridgePort),
  });
  await poll('bridge native health', async () => (await request(bridge, '/health')).source === 'native');
  socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/events`);
  let websocketError;
  socket.addEventListener('message', ({ data }) => {
    try { events.push(JSON.parse(String(data))); } catch (error) { websocketError = error; }
  });
  socket.addEventListener('error', () => { websocketError = new Error('bridge observer websocket failed'); });
  await poll('bridge observer connected', () => {
    if (websocketError) throw websocketError;
    return events.some((event) => event.type === 'board.connected');
  });
  launch('server', process.execPath, ['packages/server/src/main.ts'], {
    HOST: '127.0.0.1', PORT: String(serverPort), DB_FILE: join(temporary, 'smoke.db'),
    BRIDGE_HTTP: bridge, BRIDGE_WS: `ws://127.0.0.1:${bridgePort}/events`, WEB_ROOT: '',
  });
  await poll('server connected to board', async () => (await request(server, '/api/state')).boardOnline);
  assert.equal((await request(server, '/api/native/health')).ok, true);
  const nativeTest = await request(server, '/api/bridge/test', 'POST', { kind: 'native', url: detector });
  assert.equal(nativeTest.ok, true, `native test must use /health, not /api/ping: ${JSON.stringify(nativeTest)}`);
  assert.equal((await request(server, '/api/bridge/source')).config.kind, 'native');
  await request(bridge, '/inject', 'POST', { segment: { number: 20, ring: 'TRIPLE' } }, 409);
  await request(server, '/api/simulate', 'POST', { segment: { number: 20, ring: 'TRIPLE' } }, 409);
  await request(server, '/api/native/events', 'GET', undefined, 404);
  await request(server, '/api/native/control/reset', 'POST', {}, 404);
  const first = await request(server, '/api/profiles', 'POST', { name: 'Native smoke A' }, 201);
  const second = await request(server, '/api/profiles', 'POST', { name: 'Native smoke B' }, 201);
  await request(server, '/api/matches', 'POST', {
    config: { gameType: 'x01', startScore: 501, inMode: 'straight', outMode: 'straight', legsToWin: 1, setsToWin: 1 },
    playerIds: [first.id, second.id],
  }, 201);
  const state = () => request(server, '/api/native/state');
  const view = async () => (await request(server, '/api/state')).view;
  const scored = () => events.filter((event) => event.type === 'throw.detected');
  const scoringEvents = () => events.filter((event) => ['throw.detected', 'takeout.started', 'takeout.completed'].includes(event.type));
  async function baseline(occupancy, status) {
    return poll(`stable image baseline occupancy=${occupancy}`, async () => {
      const snapshot = await state();
      return snapshot.occupancy === occupancy && snapshot.status === status &&
        !snapshot.pending.adoptingBaseline && snapshot.pending.stableFrames >= snapshot.pending.requiredFrames &&
        snapshot.faults.length === 0 && snapshot;
    });
  }
  function assertView(current, count, active = first.id, held = count === 3) {
    assert.equal(current.status, 'playing');
    assert.equal(current.activePlayerId, active);
    assert.equal(current.awaitingTakeout, held);
    assert.equal(current.players.find((player) => player.playerId === first.id).score, 501 - 60 * count);
    assert.equal(current.players.find((player) => player.playerId === second.id).score, 501);
    assert.equal(current.players.find((player) => player.playerId === first.id).stats.dartsThrown, count);
    assert.equal(current.turn.throws.length, active === first.id ? count : 0);
    assert.equal(scored().length, count, 'exact bridge throw counter');
    assert.ok(!websocketError, websocketError?.message);
  }
  async function holds(count, active = first.id, held = count === 3) {
    const until = Date.now() + 1200;
    while (Date.now() < until) {
      alive();
      assertView(await view(), count, active, held);
      await sleep(150);
    }
  }
  await baseline(0, 'Throw');
  await holds(0);
  const snapshot = await state();
  assert.equal(snapshot.source, 'synthetic');
  const frame = await fetch(`${server}/api/native/cameras/${snapshot.cameras[0].id}/frame?t=${Date.now()}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(frame.status, 200, 'preview query must be dropped before forwarding');
  assert.match(frame.headers.get('content-type') ?? '', /^image\/png/);
  const png = Buffer.from(await frame.arrayBuffer());
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(png.length > 100, 'preview contains an actual PNG');
  // 12 mm apart: distinct silhouettes, well inside T20 and away from ring wires.
  for (const [index, x] of [-12, 0, 12].entries()) {
    await request(server, '/api/native/sim/throw', 'POST', { x_mm: x, y_mm: 102 });
    await baseline(index + 1, index === 2 ? 'Takeout' : 'Throw');
    await poll(`T20 ${index + 1} reaches match`, async () => {
      const current = await view();
      assertView(current, index + 1);
      return current;
    });
    const dart = scored()[index].throw;
    assert.deepEqual(dart.segment, { number: 20, ring: 'TRIPLE' });
    assert.equal(dart.value, 60);
    assert.equal(dart.source, 'board');
    assert.ok(dart.coords && Number.isFinite(dart.coords.x) && Number.isFinite(dart.coords.y));
    assert.equal(new Set(scored().map((event) => event.throw.id)).size, index + 1);
    assert.equal((await request(server, '/api/board/state')).state.numThrows, index + 1);
    await holds(index + 1);
    if (index === 0) {
      const before = scoringEvents().length;
      assert.equal((await request(server, '/api/board/reset', 'POST', {})).ok, true);
      await baseline(1, 'Throw');
      await holds(1);
      assert.equal(scoringEvents().length, before, 'control reset must emit neither scores nor takeout');
    }
  }
  const beforeHeldReset = scoringEvents().length;
  assert.equal((await request(server, '/api/board/reset', 'POST', {})).ok, true);
  await baseline(3, 'Takeout');
  await holds(3);
  assert.equal(scoringEvents().length, beforeHeldReset, 'reset must preserve the takeout-held turn');
  const beforePartial = scoringEvents().length;
  await request(server, '/api/native/sim/takeout', 'POST', { count: 1 });
  await baseline(2, 'Takeout in progress');
  await poll('partial takeout started', () => events.some((event) => event.type === 'takeout.started'));
  await holds(3);
  assert.equal(scoringEvents().length, beforePartial + 1);
  assert.equal(events.filter((event) => event.type === 'takeout.completed').length, 0);
  await request(server, '/api/native/sim/takeout', 'POST', {});
  await baseline(0, 'Throw');
  await poll('full takeout advances exactly once', async () => {
    const current = await view();
    assertView(current, 3, second.id, false);
    return events.filter((event) => event.type === 'takeout.completed').length === 1;
  });
  await holds(3, second.id, false);
  const beforeReset = scoringEvents().length;
  await request(server, '/api/native/sim/reset', 'POST', {});
  await baseline(0, 'Throw');
  await holds(3, second.id, false);
  assert.equal(scoringEvents().length, beforeReset, 'sim reset must not score or advance');
  console.log('PASS native smoke: Python image detector → native bridge → server; 3 board T20s, reset isolation, partial/full takeout, PNG query proxy, native health test, injection rejection.');
} catch (error) {
  process.exitCode = 1;
  console.error(`FAIL native smoke: ${error.stack ?? error}`);
  for (const child of children) console.error(`\n--- ${child.name} logs ---\n${child.logs || '(no output)'}`);
} finally {
  try { await cleanup(); } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL native smoke cleanup: ${error.stack ?? error}`);
  }
  clearTimeout(watchdog);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
}
