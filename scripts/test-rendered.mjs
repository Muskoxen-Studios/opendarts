#!/usr/bin/env node
// Standalone real WebGL → Python → native bridge → server smoke; Node 24+, Python,
// installed Electron and (on Linux) xvfb-run. No scores/impact coordinates enter Python.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Visual inspection only: no detector, bridge, server or scoring assertions.
const picturesOnly = process.argv.includes('--pictures');
const children = [], events = [], pending = new Map();
const deadline = Date.now() + 90_000;
let temporary, vite, socket, browser, failure, serial = 0;
const watchdog = setTimeout(() => { failure = 'overall 90-second timeout'; for (const child of children) child.process.kill('SIGTERM'); }, 90_000);
const interrupt = () => { failure = 'interrupted'; for (const child of children) child.process.kill('SIGTERM'); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
function alive() {
  assert.ok(!failure && Date.now() < deadline, failure ?? 'overall timeout');
  for (const child of children) assert.ok(!child.error && child.process.exitCode === null && child.process.signalCode === null,
    `${child.name} exited: ${child.error ?? child.process.exitCode ?? child.process.signalCode}`);
}
async function poll(label, check, timeout = 12_000) {
  const until = Math.min(deadline, Date.now() + timeout); let last;
  while (Date.now() < until) { alive(); try { const value = await check(); if (value) return value; } catch (error) { last = error.message; } await sleep(100); }
  throw new Error(`${label} timed out: ${last ?? 'condition not met'}`);
}
async function ports() {
  const reservations = [];
  try {
    for (let i = 0; i < 4; i++) { const server = netServer(); reservations.push(server); await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); }); }
    return reservations.map(server => server.address().port);
  } finally { await Promise.all(reservations.map(server => new Promise(yes => server.close(yes)))); }
}
function launch(name, command, args, env = {}, input = false) {
  const child = { name, logs: '', process: spawn(command, args, { cwd: root, env: { ...process.env, ...env },
    detached: process.platform !== 'win32', stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }) };
  children.push(child);
  for (const stream of [child.process.stdout, child.process.stderr]) stream.on('data', data => { child.logs = (child.logs + data).slice(-48_000); });
  child.process.on('error', error => { child.error = error.message; });
  child.closed = new Promise(yes => child.process.once('close', yes));
  return child;
}
async function request(base, path, method = 'GET', body, status = 200) {
  alive(); const response = await fetch(base + path, { method, signal: AbortSignal.timeout(5000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const text = await response.text(); assert.equal(response.status, status, `${method} ${path}: ${text}`); return JSON.parse(text);
}
function rpc(method, args = [], screenshot) {
  alive(); const id = ++serial;
  return new Promise((yes, no) => {
    const timer = setTimeout(() => { pending.delete(id); no(new Error(`Electron ${method} timed out`)); }, Math.min(15_000, deadline - Date.now()));
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); message.error ? no(new Error(message.error)) : yes(message.result); });
    browser.process.stdin.write(JSON.stringify({ id, method, args, screenshot }) + '\n');
  });
}
const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#20242b;color:#eee;font:18px sans-serif;margin:12px}main{display:grid;grid-template-columns:640px 640px;gap:8px}canvas{width:640px;height:360px}h1{font-size:20px;margin:8px}</style></head><body><h1>Actual Three.js rig — overview / cam0 / cam1 / cam2</h1><main><canvas id="overview"></canvas><canvas id="cam0"></canvas><canvas id="cam1"></canvas><canvas id="cam2"></canvas></main><script type="module">
import { CameraRig3D, DEFAULT_RIG, DEFAULT_DART } from '/packages/frontend/src/cameraRig3d.ts';
window.rigReady = (async () => {
  const renderer = new CameraRig3D(document.querySelector('#overview'), ['cam0','cam1','cam2'].map(id => document.getElementById(id)), DEFAULT_RIG);
  let session, sequence = 0, timestamp = 0;
  async function getJSON(path, body) {
    const response = await fetch(path, { signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { method: 'POST', headers: {'content-type':'application/json'}, body:JSON.stringify(body) }) });
    const text = await response.text(); if (!response.ok) throw new Error(path + ': ' + response.status + ' ' + text); return JSON.parse(text);
  }
  async function upload() {
    const images = renderer.frames(); renderer.renderOverview();
    await getJSON('/api/native/render/frames', { session, sequence:sequence++, timestampMs:timestamp = Math.max(timestamp + 1, Date.now()), images });
  }
  window.rigTest = {
    overview() { renderer.renderOverview(); },
    preview(specs) { renderer.setDarts(specs.map(spec => ({...DEFAULT_DART, ...spec}))); renderer.frames(); renderer.renderOverview(); },
    async configure() { renderer.setDarts([]); const configuration = renderer.configuration();
      // Confirm framebuffer contains board texture, not blank/constant pixels.
      const pixels = atob(configuration.cameras.cam0.reference);
      if (new Set(pixels).size < 20) throw new Error('WebGL framebuffer is blank');
      ({session} = await getJSON('/api/native/render/configure', configuration)); return {session, levels:new Set(pixels).size}; },
    async settle(specs, occupancy, status) {
      renderer.setDarts(specs.map(spec => ({...DEFAULT_DART, ...spec})));
      const until = Date.now() + 10000; let snapshot;
      for (let i = 0; Date.now() < until; i++) {
        await upload(); await new Promise(resolve => setTimeout(resolve, 140));
        snapshot = await getJSON('/api/native/state');
        if (snapshot.pending.reviewRequired) throw new Error('Python review fault: ' + JSON.stringify(snapshot));
        if (i >= 2 && snapshot.renderSession === session && snapshot.occupancy === occupancy && snapshot.status === status &&
          !snapshot.pending.adoptingBaseline && snapshot.pending.stableFrames >= snapshot.pending.requiredFrames && !snapshot.faults.length) return snapshot;
      }
      throw new Error('Rendered scene (' + specs.length + ' darts, expected occupancy=' + occupancy + ', status=' + status + ') not accepted: ' + JSON.stringify(snapshot));
    },
    reset() { return getJSON('/api/native/render/reset', {session}); },
    dispose() { renderer.dispose(); }
  };
  renderer.renderOverview(); return true;
})();
</script></body></html>`;

try {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required');
  temporary = await mkdtemp(join(tmpdir(), 'darts-rendered-'));
  const [detectorPort, bridgePort, serverPort, vitePort] = await ports();
  const detector = `http://127.0.0.1:${detectorPort}`, bridge = `http://127.0.0.1:${bridgePort}`, server = `http://127.0.0.1:${serverPort}`;
  if (!picturesOnly) {
  launch('Python rendered detector', 'python3', ['-B', 'services/detector/main.py', '--source', 'rendered', '--port', String(detectorPort)]);
  await poll('Python health', async () => (await request(detector, '/health')).ok);
  launch('native bridge', process.execPath, ['packages/bridge/src/main.ts'], { SOURCE: 'native', DETECTOR_URL: detector, BRIDGE_PORT: String(bridgePort) });
  await poll('bridge health', async () => (await request(bridge, '/health')).source === 'native');
  socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/events`);
  socket.addEventListener('message', ({data}) => { try { events.push(JSON.parse(String(data))); } catch (error) { failure = error.message; } });
  socket.addEventListener('error', () => { failure = 'bridge observer websocket error'; });
  await poll('observer connected', () => events.some(event => event.type === 'board.connected'));
  launch('server', process.execPath, ['packages/server/src/main.ts'], { HOST: '127.0.0.1', PORT: String(serverPort), DB_FILE: join(temporary, 'test.db'), BRIDGE_HTTP: bridge, BRIDGE_WS: `ws://127.0.0.1:${bridgePort}/events`, WEB_ROOT: '' });
  await poll('server board online', async () => (await request(server, '/api/state')).boardOnline);
  const players = await Promise.all(['Rendered A', 'Rendered B'].map(name => request(server, '/api/profiles', 'POST', {name}, 201)));
  await request(server, '/api/matches', 'POST', { config: { gameType:'x01', startScore:501, inMode:'straight', outMode:'straight', legsToWin:1, setsToWin:1 }, playerIds:players.map(player => player.id) }, 201);
  }
  vite = await createServer({ root, configFile: false, server: { host:'127.0.0.1', port:vitePort, strictPort:true, proxy: { '/api': { target:server, changeOrigin:true } } },
    plugins: [{ name:'rendered-test-harness', configureServer(server) { server.middlewares.use('/__rigtest', (_request, response) => { response.setHeader('Content-Type','text/html'); response.end(html); }); } }] });
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/__rigtest`;
  let ready = false;
  const electron = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
  await access(electron);
  const args = ['--no-sandbox', ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []), 'scripts/rendered-browser.cjs', `--url=${url}`];
  browser = process.platform === 'linux' ? launch('Electron WebGL', process.env.XVFB_RUN ?? 'xvfb-run', ['-a', '-s', '-screen 0 1400x1100x24', electron, ...args], { ELECTRON_RUN_AS_NODE:'' }, true) : launch('Electron WebGL', electron, args, { ELECTRON_RUN_AS_NODE:'' }, true);
  createInterface({input:browser.process.stdout}).on('line', line => { if (!line.startsWith('RIGTEST ')) return; const message = JSON.parse(line.slice(8)); if (message.ready) ready = true; else pending.get(message.id)?.(message); });
  await poll('Electron harness ready', () => ready, 20_000);
  if (picturesOnly) {
    for (const [name, darts] of [
      ['reference-empty', []],
      ['reference-dart', [{ x: 0, y: 102 }]],
      ['reference-tilted', [{ x: 28, y: 100, tiltX: 22, tiltY: -16, roll: 35 }]],
    ]) {
      await rpc('preview', [darts]);
      const output = await rpc('capture', [], join(root, 'build/test-rendered', `${name}.png`));
      console.log(`Rendered preview: ${output}`);
    }
    await rpc('dispose');
    console.log('PASS render-only screenshots. Detection was not started or tested.');
  } else {
  console.log('WebGL calibration:', await rpc('configure'));
  const scored = () => events.filter(event => event.type === 'throw.detected');
  async function verify(count, active = 0, held = count === 3) {
    await poll(`server accepts ${count} rendered throws`, async () => {
      const view = (await request(server, '/api/state')).view;
      if (view.players.find(player => player.playerId === players[0].id).stats.dartsThrown !== count) return false;
      assert.equal(view.players.find(player => player.playerId === players[0].id).score, 501 - 60 * count);
      assert.equal(view.players.find(player => player.playerId === players[1].id).score, 501);
      assert.equal(view.activePlayerId, players[active].id); assert.equal(view.awaitingTakeout, held);
      assert.equal(view.turn.throws.length, active === 0 ? count : 0);
      assert.equal(scored().length, count);
      for (const {throw: dart} of scored()) { assert.deepEqual(dart.segment, {number:20, ring:'TRIPLE'}); assert.equal(dart.value,60); assert.equal(dart.source,'board'); assert.ok(dart.coords && Number.isFinite(dart.coords.x) && Number.isFinite(dart.coords.y)); }
      assert.equal(new Set(scored().map(event => event.throw.id)).size, count); return true;
    });
  }
  await rpc('settle', [[], 0, 'Throw']); await verify(0);
  console.log('PASS rendered empty-board baseline: 3 calibrated WebGL views, stable Python occupancy=0, no bridge throws/server score changes');
  await rpc('capture', [], join(root, 'build/test-rendered/empty.png'));
  const darts = [{x:0,y:102}, {x:-12,y:102,tiltX:8,tiltY:-6,roll:20}, {x:12,y:102,tiltX:-7,tiltY:5,roll:-15}];
  for (let count = 1; count <= 3; count++) {
    await rpc('settle', [darts.slice(0,count), count, count === 3 ? 'Takeout' : 'Throw']); await verify(count);
    console.log(`PASS rendered T20 ${count}: ${JSON.stringify(darts[count-1])}`);
    await rpc('capture', [], join(root, 'build/test-rendered', `darts-${count}.png`));
    const before = events.filter(event => ['throw.detected','takeout.started','takeout.completed'].includes(event.type)).length;
    await rpc('reset'); await rpc('settle', [darts.slice(0,count), count, count === 3 ? 'Takeout' : 'Throw']); await verify(count);
    assert.equal(events.filter(event => ['throw.detected','takeout.started','takeout.completed'].includes(event.type)).length, before, 'reset must not score/advance');
  }
  await rpc('settle', [darts.slice(0,2), 2, 'Takeout in progress']); await verify(3);
  assert.equal(events.filter(event => event.type === 'takeout.started').length,1);
  assert.equal(events.filter(event => event.type === 'takeout.completed').length,0);
  await rpc('settle', [[], 0, 'Throw']); await verify(3,1,false);
  assert.equal(events.filter(event => event.type === 'takeout.completed').length,1);
  await rpc('dispose');
  console.log('PASS rendered e2e: actual Three WebGL pixels → Python rendered → native bridge → server; perpendicular + 2 tilted T20s, resets, partial/full takeout. Screenshots: build/test-rendered/darts-{1,2,3}.png');
  }
} catch (error) {
  process.exitCode = 1; console.error(`FAIL ${picturesOnly ? 'render-only screenshots' : 'rendered e2e'}: ${error.stack ?? error}`);
  if (browser && !failure && browser.process.exitCode === null) { try { console.error('Failure screenshot:', await rpc('capture', [], join(root,'build/test-rendered/failure.png'))); } catch (captureError) { console.error(captureError.message); } }
  for (const child of children) console.error(`\n--- ${child.name} ---\n${child.logs || '(no output)'}`);
} finally {
  socket?.close();
  for (const child of [...children].reverse()) {
    const kill = signal => { try { if (process.platform === 'win32') child.process.kill(signal); else process.kill(-child.process.pid, signal); } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); } };
    kill('SIGTERM'); if (!await Promise.race([child.closed.then(() => true), sleep(1000).then(() => false)])) { kill('SIGKILL'); await Promise.race([child.closed, sleep(1000)]); }
  }
  await vite?.close(); if (temporary) await rm(temporary,{recursive:true,force:true});
  clearTimeout(watchdog); process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',interrupt);
}
