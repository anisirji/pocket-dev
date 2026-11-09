import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Windows has no process.getuid(): the modules that read it while the server starts must cope.
test('takeover loads without process.getuid, as on Windows', () => {
  const pre = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-win-')), 'pre.cjs');
  fs.writeFileSync(pre, "for (const k of ['getuid', 'getgid', 'geteuid', 'getegid']) delete process[k];\n");
  const out = execFileSync(process.execPath, ['--require', pre, '--input-type=module', '-e',
    "const t = await import('./takeover.js'); t.createTakeover({}); const c = await import('./takeover-cli.js'); console.log('ok');"], { cwd: REPO, encoding: 'utf8' });
  assert.match(out, /ok/);
});
