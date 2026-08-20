'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { findFreePort, findNodeRuntime, lanAddresses, waitForServer } = require('./runtime.js');

/**
 * The desktop shell.
 *
 * It runs the *unmodified* backend as two child processes and points a window
 * at it. Nothing about the game lives here -- this file starts processes, waits
 * for them, and shows a window. That is deliberate: the docker deployment and
 * the desktop app must stay the same program, or they drift and only one of
 * them stays tested.
 */

/**
 * Named before anything asks for a path.
 *
 * `app.getPath('userData')` is derived from the name, and unpackaged runs would
 * otherwise take it from this package's manifest and put the database in a
 * `@darts/desktop` directory. Pinning it here means a development run and an
 * installed one read and write the same database, which is the whole point of
 * being able to run the shell without packaging it.
 */
app.setName('Darts');

/** Where `packages/` and (when packaged) `runtime/` live. */
const APP_ROOT = app.isPackaged ? app.getAppPath() : join(__dirname, '..', '..', '..');

const children = [];
let win = null;
let serverUrl = null;
let startupError = null;

/**
 * Start one backend process.
 *
 * stdio is piped and echoed with a prefix rather than inherited: in a packaged
 * app there is no terminal to inherit, and the last few lines of a child that
 * died are the only useful thing to show the user when startup fails.
 */
function startBackend(nodePath, entry, env, name) {
  const child = spawn(nodePath, [join(APP_ROOT, entry)], {
    cwd: APP_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const tail = [];
  const remember = (buf) => {
    const text = String(buf).trimEnd();
    if (text) console.log(`[${name}] ${text}`);
    tail.push(text);
    if (tail.length > 20) tail.shift();
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);

  child.on('exit', (code, signal) => {
    console.log(`[${name}] exited (code ${code}, signal ${signal})`);
    // A backend that dies while the app is up leaves a window showing a frozen
    // scoreboard, which looks like a hang. Say what happened instead.
    if (!app.isQuitting && code !== 0) {
      dialog.showErrorBox(
        'The darts backend stopped',
        `The ${name} process exited with code ${code}.\n\n${tail.join('\n')}`,
      );
      app.quit();
    }
  });

  children.push({ child, name });
  return child;
}

/** Stop both children. Windows needs the tree killed, not just the parent. */
function stopBackends() {
  for (const { child } of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  }
  children.length = 0;
}

async function boot() {
  const nodePath = findNodeRuntime(APP_ROOT);
  const [serverPort, bridgePort] = [await findFreePort(), await findFreePort()];
  const dbFile = join(app.getPath('userData'), 'darts.db');

  console.log(`[desktop] node=${nodePath} server=${serverPort} bridge=${bridgePort} db=${dbFile}`);

  startBackend(nodePath, 'packages/bridge/src/main.ts', { BRIDGE_PORT: String(bridgePort) }, 'bridge');

  startBackend(
    nodePath,
    'packages/server/src/main.ts',
    {
      PORT: String(serverPort),
      // Bound to the network on purpose: a phone or tablet by the board is a
      // second scoreboard, and that is most of the point of running this at home.
      HOST: '0.0.0.0',
      DB_FILE: dbFile,
      BRIDGE_WS: `ws://127.0.0.1:${bridgePort}/events`,
      BRIDGE_HTTP: `http://127.0.0.1:${bridgePort}`,
      WEB_ROOT: join(APP_ROOT, 'packages', 'frontend', 'dist'),
    },
    'server',
  );

  serverUrl = `http://127.0.0.1:${serverPort}`;
  await waitForServer(`${serverUrl}/api/settings`);
  return serverUrl;
}

function buildMenu() {
  const addresses = lanAddresses();
  const port = serverUrl ? new URL(serverUrl).port : '';

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Darts',
        submenu: [
          { label: 'Reload scoreboard', accelerator: 'F5', click: () => win?.reload() },
          { role: 'togglefullscreen' },
          { type: 'separator' },
          {
            label: 'Check for updates',
            enabled: app.isPackaged,
            click: () => checkForUpdates(true),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Other devices',
        submenu:
          addresses.length === 0
            ? [{ label: 'No network connection found', enabled: false }]
            : addresses.flatMap((address) => {
                const url = `http://${address}:${port}`;
                return [
                  {
                    label: `Copy ${url}`,
                    click: () => clipboard.writeText(url),
                  },
                  { label: `Open ${url} in a browser`, click: () => void shell.openExternal(url) },
                ];
              }),
      },
      { role: 'viewMenu' },
    ]),
  );
}

/**
 * Updates come from GitHub releases.
 *
 * Only when packaged: an unpackaged run has no version to compare and
 * electron-updater throws rather than shrugging. `silent` is the startup
 * check, which must never interrupt a game with a dialog; the menu item passes
 * false so an explicit check can say "you are up to date".
 */
function checkForUpdates(interactive = false) {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.on('error', (err) => {
    console.log(`[update] ${err}`);
    if (interactive) dialog.showErrorBox('Could not check for updates', String(err));
  });
  autoUpdater.on('update-not-available', () => {
    if (interactive) {
      void dialog.showMessageBox({ message: `You are on the latest version (${app.getVersion()}).` });
    }
  });
  autoUpdater.on('update-downloaded', async ({ version }) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 1,
      message: `Darts ${version} is ready to install.`,
      detail: 'It will be installed the next time the app starts.',
    });
    if (response === 0) {
      app.isQuitting = true;
      stopBackends();
      autoUpdater.quitAndInstall();
    }
  });

  void autoUpdater.checkForUpdates();
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0c0e12',
    title: 'Darts',
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  await win.loadFile(join(__dirname, 'splash.html'));

  try {
    const url = await boot();
    await win.loadURL(url);
  } catch (err) {
    startupError = err;
    console.error('[desktop] startup failed:', err);
    dialog.showErrorBox('Darts could not start', String(err && err.message ? err.message : err));
    app.quit();
    return;
  }

  buildMenu();
  checkForUpdates();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

// The backend outlives the window otherwise, and a second launch would then
// find its ports taken by an invisible copy of itself.
app.on('will-quit', stopBackends);
app.on('window-all-closed', () => app.quit());

process.on('exit', stopBackends);

module.exports = { startupError };
