import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

// A stand-in for claude: answers --version, and says it is logged out the way `claude auth status` does, with an
// email address that must never reach the phone.
function fakeClaude(t, loggedIn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'cloudflared'), '#!/bin/sh\necho "cloudflared version 2026.1.1"\n', { mode: 0o700 });
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/bin/sh
case "$1" in
  --version) echo "9.8.7 (Claude Code)" ;;
  auth) echo '{"loggedIn": ${loggedIn}, "email": "private@example.com"}'; [ ${loggedIn} = true ] || exit 1 ;;
esac
`, { mode: 0o700 });
  return file;
}

test('GET /api/setup/status needs a login and reports each tool without secrets', { timeout: 60000 }, async (t) => {
  const fakeClaudeFile = fakeClaude(t, false);
  const s = await startServer(t, { env: { POCKET_DEV_CLAUDE: fakeClaudeFile, POCKET_DEV_CODEX: '/nonexistent/codex', POCKET_DEV_CLOUDFLARED: path.join(path.dirname(fakeClaudeFile), 'cloudflared') } });
  assert.equal((await s.request('GET', '/api/setup/status')).status, 401);
  const { cookie } = await s.login();
  const r = await s.request('GET', '/api/setup/status', { cookie });
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.tools.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(byId), ['node', 'git', 'claude', 'codex', 'gh', 'cloudflared']);
  assert.equal(byId.node.status, 'ok');
  assert.deepEqual([byId.claude.installed, byId.claude.version, byId.claude.loggedIn, byId.claude.status], [true, '9.8.7', false, 'logged-out']);
  assert.equal(byId.claude.fix.command, 'claude auth login');
  assert.deepEqual([byId.codex.installed, byId.codex.status], [false, 'missing']);
  assert.ok(byId.codex.fix.command === null || typeof byId.codex.fix.command === 'string');
  const json = JSON.stringify(r.data);
  assert.ok(!json.includes('private@example.com'));
  assert.ok(!json.includes(os.tmpdir()), 'no file paths');
});

test('a made-up cookie does not read the tools list', { timeout: 60000 }, async (t) => {
  const s = await startServer(t);
  assert.equal((await s.request('GET', '/api/setup/status', { cookie: 'pd_guest=nope' })).status, 401);
});
