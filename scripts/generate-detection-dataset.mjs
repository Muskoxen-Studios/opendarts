#!/usr/bin/env node
// Offline fixture generation only: no detector, bridge, server, database or scoring API.
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'vite';
import { detectionScenarios, random, SCENARIO_SEED, SCENARIO_VERSION, SCENARIO_HORIZONTAL_FOV, SCENARIO_VERTICAL_FOV } from './detection-scenarios.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function options(args) {
  let output = join(root, 'build/rendered-benchmark'), small = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--small') small = true;
    else if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) output = resolve(args[++i]);
    else if (args[i] === '--help') {
      console.log('Usage: node scripts/generate-detection-dataset.mjs [--output DIRECTORY] [--small]\nRequires installed Electron, Vite and (Linux) xvfb-run. Reuses a verified complete cache.');
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  return { output, small };
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function json(path, value) { await writeFile(path, JSON.stringify(value) + '\n'); }

const html = `<!doctype html><html><body><canvas id="overview"></canvas><canvas id="cam0"></canvas><canvas id="cam1"></canvas><canvas id="cam2"></canvas><script type="module">
import { CameraRig3D, DEFAULT_RIG, DEFAULT_DART, validDart, validRig } from '/packages/frontend/src/cameraRig3d.ts';
window.rigReady = (async () => {
  const renderer = new CameraRig3D(document.getElementById('overview'), ['cam0','cam1','cam2'].map(id => document.getElementById(id)), DEFAULT_RIG);
  window.rigTest = {
    configure(rig) {
      if (!validRig(rig)) throw new Error('Invalid scenario rig');
      renderer.setDarts([]); renderer.setRig(rig);
      const config = renderer.configuration();
      for (const camera of Object.values(config.cameras)) {
        if (new Set(atob(camera.reference)).size < 20) throw new Error('Blank WebGL reference');
      }
      return config;
    },
    frames(specs) {
      const darts = specs.map(spec => ({ ...DEFAULT_DART, ...spec }));
      if (!darts.every(validDart)) throw new Error('Invalid scenario dart');
      renderer.setDarts(darts); return renderer.frames();
    },
    dispose() { renderer.dispose(); }
  };
  return true;
})();
</script></body></html>`;

function perturb(images, effect, previous) {
  const result = { ...images };
  if (!effect) return result;
  const rng = random(effect.seed ?? SCENARIO_SEED);
  for (const camera of ['cam0', 'cam1', 'cam2']) {
    if (camera === effect.frozenCamera) { result[camera] = previous[camera]; continue; }
    if (effect.noise || effect.gain !== undefined || effect.offset !== undefined) {
      const pixels = Buffer.from(images[camera], 'base64');
      for (let i = 0; i < pixels.length; i++) pixels[i] = Math.max(0, Math.min(255,
        Math.round(pixels[i] * (effect.gain ?? 1) + (effect.offset ?? 0) + (rng() * 2 - 1) * (effect.noise ?? 0))));
      result[camera] = pixels.toString('base64');
    }
  }
  return result;
}

async function generate({ output, small }) {
  const scenarios = detectionScenarios({ small });
  const fingerprint = createHash('sha256').update(JSON.stringify({ small, seed: SCENARIO_SEED, version: SCENARIO_VERSION }));
  for (const file of ['scripts/generate-detection-dataset.mjs', 'scripts/detection-scenarios.mjs',
    'scripts/rendered-browser.cjs', 'packages/frontend/src/cameraRig3d.ts', 'packages/frontend/src/boardGeometry.ts', 'package-lock.json']) {
    fingerprint.update(await readFile(join(root, file)));
  }
  const key = fingerprint.digest('hex');
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) {
    try {
      const cache = JSON.parse(await readFile(join(output, 'generator-cache.json'), 'utf8'));
      if (cache.version !== SCENARIO_VERSION || cache.key !== key || !cache.files['dataset.json']) throw new Error('cache settings changed');
      for (const [file, digest] of Object.entries(cache.files)) {
        if (!/^(dataset\.json|case-\d+\/(configuration|step-\d+)\.json)$/.test(file)) throw new Error('invalid cache reference');
        if (hash(await readFile(join(output, file))) !== digest) throw new Error(`cache file changed: ${file}`);
      }
      console.log(`Cached dataset: ${join(output, 'dataset.json')} (${scenarios.length} cases)`);
      return;
    } catch (error) { throw new Error(`Output is nonempty but not a matching complete cache (${error.message}); choose a new --output directory.`); }
  }

  let vite, browser, logs = '', ready = false, serial = 0, failure;
  const pending = new Map();
  const deadline = Date.now() + 80_000;
  function kill(signal) {
    if (!browser?.pid) return;
    try { if (process.platform === 'win32') browser.kill(signal); else process.kill(-browser.pid, signal); } catch { /* Already exited. */ }
  }
  function fail(error) {
    failure ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  const interrupt = () => { fail(new Error('Generation interrupted')); kill('SIGTERM'); };
  const watchdog = setTimeout(() => { fail(new Error('Generation exceeded 80 seconds')); kill('SIGKILL'); }, 80_000);
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  function alive() { if (failure) throw failure; if (Date.now() >= deadline) throw new Error('Generation deadline exceeded'); }
  function rpc(method, args = []) {
    alive();
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${method} timed out`)); }, Math.min(15_000, deadline - Date.now()));
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      browser.stdin.write(JSON.stringify({ id, method, args }) + '\n', error => { if (error) fail(error); });
    });
  }
  // Stage all files; dataset.json becomes visible only after every fixture is complete.
  const staging = join(output, `.generating-${process.pid}`);
  try {
    await mkdir(staging);
    vite = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 },
      plugins: [{ name: 'detection-dataset', configureServer(server) {
        server.middlewares.use('/__dataset', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
      } }] });
    await vite.listen(); alive();
    const electron = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe'
      : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
    await access(electron);
    const args = ['--no-sandbox', ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []), 'scripts/rendered-browser.cjs', `--url=http://127.0.0.1:${vite.httpServer.address().port}/__dataset`];
    browser = spawn(process.platform === 'linux' ? (process.env.XVFB_RUN ?? 'xvfb-run') : electron,
      process.platform === 'linux' ? ['-a', '-s', '-screen 0 1400x1100x24', electron, ...args] : args,
      { cwd: root, detached: process.platform !== 'win32', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    browser.on('error', fail);
    browser.on('exit', (code, signal) => fail(new Error(`Electron exited (${code ?? signal})`)));
    browser.stdin.on('error', fail);
    browser.stderr.on('data', data => { logs = (logs + data).slice(-8000); });
    createInterface({ input: browser.stdout }).on('line', line => {
      if (!line.startsWith('RIGTEST ')) return;
      try {
        const message = JSON.parse(line.slice(8));
        if (message.ready) ready = true;
        else {
          const request = pending.get(message.id); pending.delete(message.id);
          if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result);
        }
      } catch (error) { fail(error); }
    });
    const readyDeadline = Date.now() + 25_000;
    while (!ready) { alive(); if (Date.now() > readyDeadline) throw new Error('Electron readiness timed out'); await sleep(50); }
    const manifest = { version: 1, cases: [] }, files = {};
    async function save(relative, value) {
      await json(join(staging, relative), value);
      files[relative] = hash(await readFile(join(staging, relative)));
    }
    for (const [index, scenario] of scenarios.entries()) {
      alive();
      const folder = `case-${index}`; await mkdir(join(staging, folder));
      const configuration = await rpc('configure', [scenario.rig]);
      await save(`${folder}/configuration.json`, configuration);
      let previous = Object.fromEntries(Object.entries(configuration.cameras).map(([id, camera]) => [id, camera.reference]));
      const steps = [];
      for (const [i, step] of scenario.steps.entries()) {
        const images = perturb(await rpc('frames', [step.darts]), step.effect, previous);
        for (const [id, pixels] of Object.entries(images)) {
          if (!['cam0', 'cam1', 'cam2'].includes(id) || Buffer.from(pixels, 'base64').length !== configuration.width * configuration.height) throw new Error('Invalid rendered image');
        }
        const relative = `${folder}/step-${i}.json`;
        await save(relative, images);
        steps.push({ images: relative, expected: step.darts.map(d => [d.x, d.y]), allowReject: step.allowReject, toleranceMm: 3 });
        previous = images;
      }
      manifest.cases.push({ id: scenario.id, family: scenario.family, split: scenario.split, configuration: `${folder}/configuration.json`, steps });
      console.log(`Rendered ${scenario.id}: ${steps.length} steps (${scenario.split})`);
    }
    await rpc('dispose');
    await save('dataset.json', manifest);
    await json(join(staging, 'generator-cache.json'), { version: SCENARIO_VERSION, key, seed: SCENARIO_SEED,
      rendering: { width: 1280, height: 720, horizontalFov: SCENARIO_HORIZONTAL_FOV,
        verticalFov: SCENARIO_VERTICAL_FOV, calibration: 'provisional, not measured hardware',
        pixels: 'top-down grayscale', mounting: 'per-case varied geometry' }, files });
    for (const entry of await readdir(staging)) if (entry !== 'dataset.json' && entry !== 'generator-cache.json') await rename(join(staging, entry), join(output, entry));
    await rename(join(staging, 'dataset.json'), join(output, 'dataset.json'));
    await rename(join(staging, 'generator-cache.json'), join(output, 'generator-cache.json'));
    console.log(`Saved ${manifest.cases.length} cases / ${manifest.cases.reduce((n, c) => n + c.steps.length, 0)} steps: ${join(output, 'dataset.json')}`);
  } catch (error) {
    if (logs) console.error(logs);
    throw error;
  } finally {
    clearTimeout(watchdog);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    fail(new Error('Generator closed'));
    // Kill the entire xvfb-run/Electron process group, including Xvfb grandchildren.
    kill('SIGTERM');
    await sleep(200); kill('SIGKILL');
    if (vite) await Promise.race([vite.close(), sleep(3000)]);
    await rm(staging, { recursive: true, force: true });
  }
}
try { await generate(options(process.argv.slice(2))); }
catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
