import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrNote } from '../qr.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the start banner and pocket-dev qr name the global command, never npm run', () => {
  assert.match(qrNote(5), /New code: pocket-dev qr$/);
  const script = fs.readFileSync(path.join(REPO, 'scripts', 'qr.js'), 'utf8');
  assert.doesNotMatch(script, /npm (run|start)/, 'a global install has no npm scripts');
});
