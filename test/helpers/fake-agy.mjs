#!/usr/bin/env node
// A stand-in for `agy acp` that speaks the Agent Client Protocol on stdio, so a test can script what Antigravity does.
// "permission" asks for permission to run a command and reports what the client chose; "slow" waits until cancelled;
// "echo-prompt" answers with the whole prompt it received; anything else streams a short answer.
import readline from 'node:readline';

if (process.argv[2] !== 'acp') process.exit(2);
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const text = (t) => ({ type: 'text', text: t });
const waiting = new Map();
let nextOut = 100;
let slow = null;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id != null && !m.method) return waiting.get(m.id)?.(m.result);
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: Boolean(process.env.FAKE_AGY_LOAD) }, authMethods: [] } });
  if (m.method === 'session/new') {
    if (process.env.FAKE_AGY_SIGNED_OUT) return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    return send({ id: m.id, result: { sessionId: 'agy-session-1' } });
  }
  if (m.method === 'session/load') {
    // Like the real agy, replay the whole conversation as updates before answering.
    update(m.params.sessionId, { sessionUpdate: 'user_message_chunk', content: text('old question') });
    update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('old answer') });
    return send({ id: m.id, result: { sessionId: m.params.sessionId } });
  }
  if (m.method === 'session/set_model') { process.stderr.write(`model ${m.params.modelId}\n`); return send({ id: m.id, result: {} }); }
  if (m.method === 'session/cancel') return slow?.();
  if (m.method !== 'session/prompt') return send({ id: m.id, error: { code: -32601, message: 'no' } });
  const sessionId = m.params.sessionId;
  const prompt = m.params.prompt.map((p) => p.text ?? '').join('');
  if (prompt.includes('echo-prompt')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text(`got: ${prompt}`) });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (prompt.includes('slow')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('working') });
    slow = () => send({ id: m.id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (prompt.includes('permission')) {
    const id = nextOut++;
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
    waiting.set(id, (result) => {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: result.outcome.optionId === 'ok' ? 'completed' : 'failed', content: [{ type: 'content', content: text('files') }] });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text(`chose ${result.outcome.optionId}`) });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    });
    return send({ id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 't1', title: 'Run ls', kind: 'execute', rawInput: { command: 'ls' } }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: text('thinking') });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('Hello ') });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text('from agy') });
  send({ id: m.id, result: { stopReason: 'end_turn' } });
});
