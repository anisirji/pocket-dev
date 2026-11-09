// node-pty's macOS and Linux prebuilt helper must be executable. Windows has no such file; nothing here may fail an install.
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'node_modules', 'node-pty', 'prebuilds');
try {
  for (const dir of fs.readdirSync(root)) {
    try { fs.chmodSync(path.join(root, dir, 'spawn-helper'), 0o755); } catch {}
  }
} catch {}
