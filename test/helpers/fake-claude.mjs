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
  if (text.includes('bgagent')) {
    // A background agent: its Agent call is answered at once, and the SDK reports its real life as task messages.
    const sys = (subtype, extra) => send({ type: 'system', subtype, task_id: 'task_1', tool_use_id: 'toolu_bg', uuid: `u${++n}`, session_id: session, ...extra });
    send({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'Build the room screen', run_in_background: true } }] }, parent_tool_use_id: null, session_id: session });
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Async agent launched successfully.' }] }, parent_tool_use_id: null, session_id: session });
    sys('task_started', { description: 'Build the room screen' });
    after(300, () => sys('task_progress', { description: 'Build the room screen', usage: { total_tokens: 10, tool_uses: 3, duration_ms: 300 }, last_tool_name: 'Edit', summary: 'editing room.js' }));
    after(600, () => { assistant('launched it'); result(); });
    after(1200, () => sys('task_notification', { status: 'completed', output_file: '/tmp/x', summary: 'done', usage: { total_tokens: 20, tool_uses: 7, duration_ms: 1100 } }));
    return;
  }
  if (text.includes('picture')) {
    // A tool run whose result is a picture (a 1x1 PNG), then an answer.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    send({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id: 'toolu_pic', name: 'Read', input: { file_path: '/tmp/shot.png' } }] }, parent_tool_use_id: null, session_id: session });
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pic', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] }, parent_tool_use_id: null, session_id: session });
    after(100, () => { assistant('here is the picture'); result(); });
    return;
  }
  if (text.includes('bgresume')) {
    // An agent started in the background, then resumed with SendMessage: both calls carry the same task id.
    const use = (id, name, input) => send({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null, session_id: session });
    const res = (id) => send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, parent_tool_use_id: null, session_id: session });
    const sys = (subtype, tool, extra) => send({ type: 'system', subtype, task_id: 'task_9', tool_use_id: tool, uuid: `u${++n}`, session_id: session, ...extra });
    use('toolu_a', 'Agent', { description: 'Build the modes' }); res('toolu_a');
    sys('task_started', 'toolu_a', { description: 'Build the modes' });
    sys('task_notification', 'toolu_a', { status: 'stopped', output_file: '/tmp/x', summary: 'stopped' });
    use('toolu_sm', 'SendMessage', { to: 'task_9', message: 'continue' }); res('toolu_sm');
    sys('task_started', 'toolu_sm', { description: 'continue' });
    sys('task_progress', 'toolu_sm', { description: 'continue', usage: { total_tokens: 1, tool_uses: 4, duration_ms: 1 }, last_tool_name: 'Bash', summary: 'running tests' });
    after(900, () => { assistant('resumed'); result(); });
    return;
  }
  if (text.includes('helpers')) {
    // Two helper agents and a todo list; the second helper's tool calls are tagged with its parent's id.
    const use = (id, name, input, parent = null) => send({ type: 'assistant', message: { id: `msg_${++n}`, role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: parent, session_id: session });
    use('toolu_todo', 'TodoWrite', { todos: [{ content: 'Write plan', status: 'completed', activeForm: 'Writing plan' }, { content: 'Build it', status: 'in_progress', activeForm: 'Building' }] });
    use('toolu_h1', 'Agent', { description: 'Search the codebase', prompt: 'look' });
    use('toolu_h2', 'Agent', { description: 'Write the tests', prompt: 'write' });
    use('toolu_c1', 'Read', { file_path: '/tmp/a.js' }, 'toolu_h1');
    use('toolu_c2', 'Grep', { pattern: 'needle' }, 'toolu_h1');
    use('toolu_c3', 'Bash', { command: 'npm test' }, 'toolu_h2');
    after(700, () => send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_h1', content: 'found it' }] }, parent_tool_use_id: null, session_id: session }));
    after(text.includes('linger') ? 60000 : 900, () => { assistant('helpers done'); result(); });
    return;
  }
  assistant('first answer');
  result();
  if (text.includes('background')) {
    after(600, () => assistant('a background helper finished, so I am working again'));
    after(1800, () => { assistant('and now I am done'); result(); });
  }
});
