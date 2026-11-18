import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgents, readAgents, sessionFile, tailLines, ACTIVE_MS, QUIET_MS } from '../src/conversations/terminal-agents.js';

const SESSION = '0f1e2d3c-aaaa-4bbb-8ccc-123456789abc';
const T0 = Date.parse('2026-11-17T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const j = (o) => JSON.stringify(o);

const call = (id, input, s = 0, name = 'Agent') => j({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
const launched = (id, agentId, s = 1, withDetail = true) => j({
  type: 'user', timestamp: at(s),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
  ...(withDetail && { toolUseResult: { isAsync: true, status: 'async_launched', agentId } }),
});
const result = (id, s, is_error) => j({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done', ...(is_error && { is_error: true }) }] } });
const notice = (id, status, s) => j({ type: 'queue-operation', operation: 'enqueue', timestamp: at(s), content: `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` });

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-agents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, '-Users-me-proj');
  fs.mkdirSync(path.join(folder, SESSION, 'subagents'), { recursive: true });
  const file = path.join(folder, `${SESSION}.jsonl`);
  const subagents = path.join(folder, SESSION, 'subagents');
  const write = (lines) => fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const agentLog = (agentId, meta, ageMs) => {
    const log = path.join(subagents, `agent-${agentId}.jsonl`);
    fs.writeFileSync(log, `${j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.js' } }] } })}\n`);
    if (meta) fs.writeFileSync(path.join(subagents, `agent-${agentId}.meta.json`), j(meta));
    const when = new Date(T0 - ageMs);
    fs.utimesSync(log, when, when);
  };
  const touch = (ageMs) => { const when = new Date(T0 - ageMs); fs.utimesSync(file, when, when); };
  return { root, file, write, agentLog, touch };
}

test('a foreground agent runs until its result arrives, and an error result is a failure', (t) => {
  const h = home(t);
  h.write([call('toolu_ok00001', { description: 'Check the tests' }), call('toolu_bad0002', { description: 'Fix lint' }, 2), call('toolu_run0003', { description: 'Read docs' }, 3),
    result('toolu_ok00001', 5), result('toolu_bad0002', 6, true)]);
  h.touch(1000);
  const agents = readAgents(h.file, { now: T0 });
  assert.deepEqual(agents.map((a) => [a.label, a.status]), [['Check the tests', 'completed'], ['Fix lint', 'failed'], ['Read docs', 'running']]);
});

test('a background agent runs until its notification, which says how it ended', (t) => {
  const h = home(t);
  h.write([
    call('toolu_a0000001', { description: 'Build A' }), launched('toolu_a0000001', 'agentaaaaaaaa1'),
    call('toolu_b0000002', { description: 'Build B' }), launched('toolu_b0000002', 'agentbbbbbbbb2'),
    call('toolu_c0000003', { description: 'Build C' }), launched('toolu_c0000003', 'agentcccccccc3'),
    notice('toolu_a0000001', 'completed', 50), notice('toolu_b0000002', 'killed', 60),
  ]);
  for (const id of ['agentaaaaaaaa1', 'agentbbbbbbbb2', 'agentcccccccc3']) h.agentLog(id, { description: id }, 1000);
  h.touch(1000);
  assert.deepEqual(readAgents(h.file, { now: T0 }).map((a) => a.status), ['completed', 'failed', 'running']);
});

test('the meta file says finished, and a quiet agent without one stops after the activity window', (t) => {
  const h = home(t);
  h.write([
    call('toolu_d0000004', { description: 'Done quietly' }), launched('toolu_d0000004', 'agentdddddddd4'),
    call('toolu_e0000005', { description: 'Long tool call' }), launched('toolu_e0000005', 'agenteeeeeeee5'),
    call('toolu_f0000006', { description: 'Left behind' }), launched('toolu_f0000006', 'agentffffffff6'),
    call('toolu_g0000007', { description: 'Old CLI' }), launched('toolu_g0000007', 'agentgggggggg7'),
  ]);
  h.agentLog('agentdddddddd4', { finished: true }, 1000);
  h.agentLog('agenteeeeeeee5', { description: 'x' }, QUIET_MS - 60_000);
  h.agentLog('agentffffffff6', { description: 'x' }, QUIET_MS + 60_000);
  h.agentLog('agentgggggggg7', null, ACTIVE_MS + 5000);
  h.touch(QUIET_MS + 120_000);
  const by = Object.fromEntries(readAgents(h.file, { now: T0 }).map((a) => [a.label, a]));
  assert.equal(by['Done quietly'].status, 'completed');
  assert.equal(by['Long tool call'].status, 'running');
  assert.equal(by['Left behind'].status, 'stopped');
  assert.equal(by['Old CLI'].status, 'stopped', 'without a meta file the 90-second rule applies');
});

test('a running agent shows its newest tool call', (t) => {
  const h = home(t);
  h.write([call('toolu_h0000008', { description: 'Edit things' }), launched('toolu_h0000008', 'agenthhhhhhhh8')]);
  h.agentLog('agenthhhhhhhh8', { description: 'x' }, 1000);
  h.touch(1000);
  assert.equal(readAgents(h.file, { now: T0 })[0].latest, 'Edit /src/app.js');
});

test('Claude Code writes some records twice and out of order; the answer is the same', (t) => {
  const lines = [
    launched('toolu_i0000009', 'agentiiiiiiii9', 1), // the launch result before its call
    call('toolu_i0000009', { description: 'Twice written' }),
    call('toolu_i0000009', { description: 'Twice written' }),
    launched('toolu_i0000009', undefined, 2, false), // the copy without detail
  ];
  const [agent] = parseAgents(lines);
  assert.equal(agent.async, true);
  assert.equal(agent.agentId, 'agentiiiiiiii9');
  assert.equal(parseAgents(lines).length, 1);
});

test('Task calls count, other tools and unrelated results do not', () => {
  const lines = [
    call('toolu_j0000010', { description: 'Old name' }, 0, 'Task'),
    call('toolu_k0000011', { command: 'ls' }, 0, 'Bash'),
    result('toolu_k0000011', 1),
    j({ type: 'user', message: { content: 'hello' } }),
    'not json "tool_result"',
  ];
  assert.deepEqual(parseAgents(lines).map((a) => a.label), ['Old name']);
});

test('only the end of a big file is read, and the cut first line is dropped', (t) => {
  const h = home(t);
  const filler = j({ type: 'user', message: { content: 'x'.repeat(500) } });
  h.write([filler, filler, call('toolu_l0000012', { description: 'Late agent' }), filler]);
  const lines = tailLines(h.file, 900).filter(Boolean);
  assert.ok(lines.length < 4);
  for (const line of lines) JSON.parse(line);
  assert.deepEqual(tailLines(path.join(h.root, 'missing.jsonl')), []);
});

test('the session file is found by id in any project folder, and bad ids find nothing', (t) => {
  const h = home(t);
  h.write([filler()]);
  assert.equal(sessionFile(SESSION, h.root), h.file);
  assert.equal(sessionFile('../../etc/passwd', h.root), null);
  assert.equal(sessionFile('aaaaaaaa-0000-4000-8000-000000000000', h.root), null);
  assert.equal(readAgents(path.join(h.root, 'nope.jsonl')).length, 0);
});

function filler() { return j({ type: 'user', message: { content: 'hi' } }); }
