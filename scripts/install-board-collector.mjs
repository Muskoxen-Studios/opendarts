#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'linux') throw new Error('The background service requires Linux systemd; use npm run collector on other systems.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const directory = join(config, 'systemd', 'user');
// systemd expands percent specifiers, and its quoted argument syntax differs
// from shell syntax. No shell is involved in ExecStart.
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
const pathSetting = value => value.replaceAll('%', '%%').replace(/[\\\s]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
const unit = `[Unit]
Description=Darts passive board camera and position collector

[Service]
Type=simple
WorkingDirectory=${pathSetting(root)}
ExecStart=${quote(process.execPath)} ${quote(join(root, 'scripts/collect-board-data.mjs'))}
Restart=always
RestartSec=5
TimeoutStopSec=20
StandardOutput=journal
StandardError=journal
SyslogIdentifier=darts-board-collector

[Install]
WantedBy=default.target
`;
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'darts-board-collector.service'), unit);
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', 'darts-board-collector.service'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'restart', 'darts-board-collector.service'], { stdio: 'inherit' });
console.log('Collector service enabled and started. Follow logs: npm run collector:logs');
