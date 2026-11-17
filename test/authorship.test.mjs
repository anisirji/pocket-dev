import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// Pocket Dev is the author's own project. No tracked file may carry a line that credits an AI tool with writing it.
// These files discuss the patterns on purpose: this test, and the test that proves a Pocket Dev chat never adds a trailer.
const ALLOWED = new Set(['test/authorship.test.mjs', 'test/git-commit.test.mjs']);
const TEXT = /\.(md|js|mjs|json|html|css|yml|yaml|sh|txt|svg|plist)$|(^|\/)(LICENSE|\.gitignore|\.gitattributes)$/;
const PATTERN = /co-authored-by|(^|[^a-z])generated with|noreply@anthropic\.com/i;

function tracked() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

test('no tracked file credits an AI tool with writing the project', (t) => {
  const files = tracked();
  if (!files) return t.skip('not a git checkout');
  const hits = [];
  for (const file of files) {
    if (ALLOWED.has(file) || !TEXT.test(file) || file.startsWith('public/vendor/') || file === 'package-lock.json') continue;
    const url = new URL(`../${file}`, import.meta.url);
    if (!fs.existsSync(url) || fs.statSync(url).size > 1_000_000) continue;
    fs.readFileSync(url, 'utf8').split('\n').forEach((line, i) => { if (PATTERN.test(line)) hits.push(`${file}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});

test('no assistant workspace folder or instruction file is tracked', (t) => {
  const files = tracked();
  if (!files) return t.skip('not a git checkout');
  assert.deepEqual(files.filter((f) => /(^|\/)CLAUDE\.md$/i.test(f) || /(^|\/)\.claude\//.test(f)), []);
});
