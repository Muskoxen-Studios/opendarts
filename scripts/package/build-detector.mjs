#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.DETECTOR_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const models = join(root, 'services/detector/models');
// Do not accidentally ship a training environment's CUDA stack in installers.
execFileSync(python, ['-c',
  'import torch; assert torch.version.cuda is None and getattr(torch.version, "hip", None) is None, "Use a CPU-only PyTorch build for detector packaging"'],
  { cwd: root, stdio: 'inherit' });
execFileSync(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'darts-detector',
  '--distpath', join(root, 'build/detector-runtime'), '--workpath', join(root, 'build/detector-freeze-work'),
  '--specpath', join(root, 'build/detector-freeze-work'), '--add-data', `${models}${delimiter}models`,
  join(root, 'services/detector/main.py')], { cwd: root, stdio: 'inherit' });
