#!/usr/bin/env node
// A stand-in for `copilot --acp --stdio` that speaks the Agent Client Protocol with the message shapes the real GitHub
// Copilot CLI 1.0.112 sent when it was captured. A test scripts what Copilot does through the prompt text:
// "permission" asks to create a file (an edit with a diff, a unified diff in the request, allow_once / allow_always /
// reject_once) and reports the option chosen; "slow" waits until cancelled; "echo-prompt" answers with the whole prompt;
// "image-check" says whether an image block came with the prompt; "limit-error" fails the prompt the way a spent premium
// allowance does; "limit-answer" answers with that message as text; "need-login" fails as a signed-out Copilot does;
// anything else streams a short answer. FAKE_COPILOT_LOG names a file that gets one JSON line per call and one for the
// arguments, so a test can read back what Pocket Dev sent.
import fs from 'node:fs';
import readline from 'node:readline';

if (!process.argv.includes('--acp')) process.exit(2);
const log = (entry) => { if (process.env.FAKE_COPILOT_LOG) fs.appendFileSync(process.env.FAKE_COPILOT_LOG, `${JSON.stringify(entry)}\n`); };
log({ argv: process.argv.slice(2) });

const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const text = (t) => ({ type: 'text', text: t });
const waiting = new Map();
let nextOut = 100;
let slow = null;
let created = 0;

const MODES = [`agent`, `plan`, `autopilot`].map((m) => ({ id: `https://agentclientprotocol.com/protocol/session-modes#${m}`, name: m }));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id != null && !m.method) return waiting.get(m.id)?.(m.result);
  if (m.method) log({ method: m.method, params: m.params });
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: process.env.FAKE_COPILOT_LOAD !== '0', promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { close: {}, list: {} } }, agentInfo: { name: 'Copilot', version: '1.0.112' }, authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI' }] } });
  }
  if (m.method === 'session/new') {
    const sessionId = `00000000-0000-4000-8000-${String(++created).padStart(12, '0')}`;
    send({ id: m.id, result: { sessionId, modes: { availableModes: MODES, currentModeId: MODES[0].id } } });
    return update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Summarize' }] });
  }
  if (m.method === 'session/load') {
    // Like the real Copilot, replay the whole conversation as updates before answering.
    update(m.params.sessionId, { sessionUpdate: 'user_message_chunk', content: text('old question') });
    update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('old answer') });
    return send({ id: m.id, result: { modes: { availableModes: MODES, currentModeId: MODES[0].id } } });
  }
  if (m.method === 'session/set_model' || m.method === 'session/set_mode') return send({ id: m.id, result: {} });
  if (m.method === 'session/cancel') return slow?.();
  if (m.method !== 'session/prompt') return send({ id: m.id, error: { code: -32601, message: 'no' } });
  const sessionId = m.params.sessionId;
  const prompt = m.params.prompt.map((p) => p.text ?? '').join('');
  const hasImage = m.params.prompt.some((p) => p.type === 'image');
  if (prompt.includes('need-login')) return send({ id: m.id, error: { code: -32000, message: 'Authentication required. Run copilot login.' } });
  if (prompt.includes('limit-error')) return send({ id: m.id, error: { code: -32603, message: 'You have exceeded your premium request allowance. Resets on Dec 1, 2026.' } });
  if (prompt.includes('limit-answer')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('You have exceeded your premium request allowance. Resets on Dec 1, 2026.') });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (prompt.includes('echo-prompt')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text(`got: ${prompt}`) });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (prompt.includes('image-check')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text(hasImage ? 'image: yes' : 'image: no') });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (prompt.includes('slow')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('working') });
    slow = () => send({ id: m.id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (prompt.includes('permission')) {
    const id = nextOut++;
    const file = '/tmp/fake-copilot/probe.txt';
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: `Creating ${file}`, kind: 'edit', status: 'pending', rawInput: { path: file, file_text: 'hello' }, locations: [{ path: file }], content: [{ type: 'diff', path: file, oldText: '', newText: 'hello' }] });
    waiting.set(id, (result) => {
      const ok = result.outcome.optionId !== 'reject_once';
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: ok ? 'completed' : 'failed', content: [{ type: 'diff', path: file, oldText: '', newText: 'hello' }] });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text(`chose ${result.outcome.optionId}`) });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    });
    return send({ id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't1', title: 'Create file', kind: 'edit', status: 'pending', rawInput: { fileName: file, diff: `\ndiff --git a${file} b${file}\ncreate file mode 100644\nindex 0000000..0000000\n--- a/dev/null\n+++ b${file}\n@@ -1,0 +1,1 @@\n+hello\n` }, locations: [{ path: file }] }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }] } });
  }
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('Hello ') });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('from copilot') });
  update(sessionId, { sessionUpdate: 'usage_update', used: 14085, size: 128000 });
  send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
});
