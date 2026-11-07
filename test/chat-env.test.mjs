import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBin } from '../chat/env.js';

test('Codex prefers the standalone install over launchd PATH, with a PATH fallback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-bin-'));
  const local = path.join(root, '.local/bin');
  const global = path.join(root, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(global);
  for (const dir of [local, global]) {
    for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  }
  const originalPath = process.env.PATH;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(os, 'homedir', () => root);
  process.env.PATH = `${global}:${local}`;
  assert.equal(findBin('codex'), path.join(local, 'codex'));
  assert.equal(findBin('claude'), path.join(global, 'claude'), 'other tools still follow PATH');
  fs.chmodSync(path.join(local, 'codex'), 0o600);
  assert.equal(findBin('codex'), path.join(global, 'codex'), 'an unavailable standalone install falls back to PATH');
});
