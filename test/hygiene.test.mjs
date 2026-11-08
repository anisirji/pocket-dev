import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './isolated-env.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A release smoke run once wrote real sessions into the owner's ~/.claude/projects. A server started by a test has real
// terminals and chat engines, so a claude or codex it starts must have its history isolated.
test('every test or script that starts server.js gives it an isolated environment', () => {
  const files = ['test', 'scripts'].flatMap((dir) => fs.readdirSync(path.join(REPO, dir))
    .filter((f) => /\.(mjs|js)$/.test(f)).map((f) => path.join(dir, f)));
  const offenders = files.filter((file) => {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    return /\[\s*'server\.js'/.test(text) && !/\benv:\s*isolatedEnv\(/.test(text);
  });
  assert.deepEqual(offenders, [], 'start the server with env: isolatedEnv(home, {...}) from test/isolated-env.mjs');
});

test('isolatedEnv points HOME and every Claude and Codex folder inside the test home', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: '/Users/owner/.claude', CODEX_HOME: '/Users/owner/.codex', POCKET_DEV_CODEX_SOCKET: '/Users/owner/.codex/sock', POCKET_DEV_CHAT_DIR: '/Users/owner/chats' });
  try {
    const env = isolatedEnv('/tmp/t-home', { PORT: '1' });
    assert.deepEqual([env.HOME, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.POCKET_DEV_CLAUDE_DIR, env.POCKET_DEV_CODEX_DIR, env.PORT],
      ['/tmp/t-home', '/tmp/t-home/.claude', '/tmp/t-home/.codex', '/tmp/t-home/.claude/projects', '/tmp/t-home/.codex', '1']);
    assert.equal(env.POCKET_DEV_CODEX_SOCKET, undefined, "never the owner's running Codex daemon");
    assert.equal(env.POCKET_DEV_CHAT_DIR, undefined);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
