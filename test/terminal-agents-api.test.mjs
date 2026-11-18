import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// History reads its folders from these at call time, so a temp store stands in for ~/.claude and ~/.codex.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-agents-api-'));
process.env.POCKET_DEV_CLAUDE_DIR = path.join(root, 'claude', 'projects');
process.env.POCKET_DEV_CODEX_DIR = path.join(root, 'codex');
const { createHistoryApi } = await import('../src/conversations/history.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ME = process.getuid();
const ID = '5a1b2c3d-1111-4222-8333-944455556666';
const folder = path.join(process.env.POCKET_DEV_CLAUDE_DIR, '-tmp-app');
fs.mkdirSync(path.join(folder, ID, 'subagents'), { recursive: true });
const j = (o) => JSON.stringify(o);
fs.writeFileSync(path.join(folder, `${ID}.jsonl`), [
  j({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'toolu_api00001', name: 'Agent', input: { description: 'Write the tests' } }] } }),
  j({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'toolu_api00002', name: 'Agent', input: { description: 'Read the docs' } }] } }),
  j({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_api00002', content: 'ok' }] } }),
].join('\n') + '\n');

const proc = (pid, ppid, exe, args) => ({ pid, ppid, uid: ME, stat: 'S', started: 0, exe, args });
const processes = [
  proc(500, 1, '/bin/zsh', 'zsh'), proc(501, 500, '/usr/local/bin/claude', `/usr/local/bin/claude --resume ${ID}`),
  proc(600, 1, '/bin/zsh', 'zsh'), proc(601, 600, '/usr/local/bin/codex', 'codex resume 0b3c1d2e-1111-4222-8333-944455556677'),
  proc(700, 1, '/bin/zsh', 'zsh'),
];
const terminals = [{ id: 'claude-tab', pid: 500 }, { id: 'codex-tab', pid: 600 }, { id: 'plain-tab', pid: 700 }];

function api({ device = { id: 'dev1', name: 'Pixel', ip: '192.168.1.20' } } = {}) {
  const listed = { count: 0 };
  const handle = createHistoryApi({
    createSession: async () => ({}), sessionView: (s) => s,
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readJson: async (req) => req.body ?? {}, deviceFor: () => device, log: () => {},
    own: { terminals: () => terminals },
    system: { listProcesses: async () => { listed.count++; return processes; }, uid: ME, selfPid: 999_999 },
  });
  const call = async (query) => {
    const res = {};
    const url = `/api/history/agents${query}`;
    await handle({ method: 'GET', url, headers: {} }, res, url.split('?')[0]);
    return res;
  };
  return { call, listed };
}

test('a Claude Code terminal answers with its agents, running first-hand from the session file', async () => {
  const { call } = api();
  const r = await call('?terminalId=claude-tab');
  assert.equal(r.status, 200);
  assert.equal(r.body.sessionId, ID);
  assert.deepEqual(r.body.agents.map((a) => [a.label, a.status]), [['Write the tests', 'running'], ['Read the docs', 'completed']]);
});

test('a Codex terminal and a plain shell answer with no agents', async () => {
  const { call } = api();
  assert.deepEqual((await call('?terminalId=codex-tab')).body, { sessionId: null, agents: [] });
  assert.deepEqual((await call('?terminalId=plain-tab')).body, { sessionId: null, agents: [] });
});

test('an unknown terminal is 404, a missing id is 404, and a request without an owner device is refused', async () => {
  assert.equal((await api().call('?terminalId=gone')).status, 404);
  assert.equal((await api().call('')).status, 404);
  assert.equal((await api({ device: null }).call('?terminalId=claude-tab')).status, 403);
});

test('polling does not list the processes again within a few seconds', async () => {
  const { call, listed } = api();
  await call('?terminalId=claude-tab');
  await call('?terminalId=claude-tab');
  await call('?terminalId=codex-tab');
  assert.equal(listed.count, 1);
});
