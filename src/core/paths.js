import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = process.env.POCKET_DEV_STATE_DIR || path.join(os.homedir(), '.pocket-dev');

// config.json used to sit in the project folder, which an npm upgrade replaces. It now lives in STATE_DIR next to the
// devices and logs. The first run after the move copies the old file over and keeps it as config.json.migrated.
export function resolveConfigPath() {
  if (process.env.POCKET_DEV_CONFIG) return process.env.POCKET_DEV_CONFIG;
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(STATE_DIR, 'config.json');
  const legacy = path.join(PACKAGE_ROOT, 'config.json');
  if (!fs.existsSync(file) && fs.existsSync(legacy)) {
    fs.copyFileSync(legacy, file);
    fs.chmodSync(file, 0o600);
    fs.renameSync(legacy, `${legacy}.migrated`);
    console.log(`Moved ${legacy} to ${file}. The old file is kept as config.json.migrated.`);
  }
  return file;
}
