// Runs after npm installs Pocket Dev. It must never fail the install: every step is guarded and the exit code is 0.
// node-pty is optional, so it may be missing; on macOS and Linux its prebuilt helper must be executable.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let ptyDir = null;
  try { ptyDir = path.dirname(createRequire(path.join(here, '..', 'package.json')).resolve('node-pty/package.json')); } catch {}
  if (!ptyDir) {
    console.log('Pocket Dev: the terminal component (node-pty) was not installed. Everything else works. To add it later, run: pocket-dev doctor --fix');
    return;
  }
  if (process.platform === 'win32') return;
  const root = path.join(ptyDir, 'prebuilds');
  for (const dir of fs.readdirSync(root)) {
    try { fs.chmodSync(path.join(root, dir, 'spawn-helper'), 0o755); } catch {}
  }
}

try { main(); } catch {}
process.exitCode = 0;
