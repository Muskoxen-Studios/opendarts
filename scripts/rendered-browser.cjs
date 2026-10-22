#!/usr/bin/env node
// Test-only Electron driver. JSON-lines RPC keeps assertions in the Node parent.
const { app, BrowserWindow } = require('electron');
const { createInterface } = require('node:readline');
const { mkdir, writeFile } = require('node:fs/promises');
const { dirname } = require('node:path');
const url = process.argv.find(arg => arg.startsWith('--url='))?.slice(6);
app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-dev-shm-usage');
let window;
const watchdog = setTimeout(() => { console.error('Electron 90-second timeout'); app.exit(1); }, 90_000);
function reply(value) { process.stdout.write(`RIGTEST ${JSON.stringify(value)}\n`); }
app.whenReady().then(async () => {
  if (!url) throw new Error('--url required');
  window = new BrowserWindow({ width: 1340, height: 1080, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } });
  window.webContents.on('console-message', (_event, ...args) => console.error('renderer console:', ...args));
  window.webContents.on('render-process-gone', (_event, details) => { console.error(details); app.exit(1); });
  await window.loadURL(url);
  await window.webContents.executeJavaScript('window.rigReady');
  reply({ ready: true });
  let queue = Promise.resolve();
  createInterface({ input: process.stdin }).on('line', line => {
    queue = queue.then(async () => {
      let command;
      try {
        command = JSON.parse(line);
        let result;
        if (command.screenshot) {
          await window.webContents.executeJavaScript('window.rigTest.overview()');
          await new Promise(resolve => setTimeout(resolve, 100));
          const image = await window.webContents.capturePage();
          await mkdir(dirname(command.screenshot), { recursive: true });
          await writeFile(command.screenshot, image.toPNG());
          result = command.screenshot;
        } else {
          result = await window.webContents.executeJavaScript(`window.rigTest[${JSON.stringify(command.method)}](...${JSON.stringify(command.args ?? [])})`);
        }
        reply({ id: command.id, result });
      } catch (error) { reply({ id: command?.id, error: error.stack ?? String(error) }); }
    });
  }).on('close', () => { clearTimeout(watchdog); app.quit(); });
}).catch(error => { console.error(error.stack); app.exit(1); });
app.on('window-all-closed', () => app.quit());
