#!/usr/bin/env node
// A stand-in for the Claude Code CLI that speaks the stream-json protocol the Agent SDK uses, so a test can script what
// "Claude" does. The message text picks the script: "background" answers, finishes, then works again on its own and
// finishes a second time; anything else answers once.
import readline from 'node:readline';

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const session = '11111111-2222-3333-4444-555555555555';
let started = false;
let n = 0;
const assistant = (text) => send({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', model: 'fake', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session });
const result = () => send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 5, num_turns: 1, result: 'done', session_id: session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
const after = (ms, fn) => setTimeout(fn, ms);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') {
    const body = m.request.subtype === 'initialize'
      ? { commands: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} }
      : {};
    return send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: body } });
  }
  if (m.type !== 'user') return;
  if (!started) {
    started = true;
    send({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), tools: [], model: 'fake', permissionMode: 'default', apiKeySource: 'none', mcp_servers: [], slash_commands: [], output_style: 'default' });
  }
  const text = JSON.stringify(m.message?.content ?? '');
  assistant('first answer');
  result();
  if (text.includes('background')) {
    after(600, () => assistant('a background helper finished, so I am working again'));
    after(1800, () => { assistant('and now I am done'); result(); });
  }
});
