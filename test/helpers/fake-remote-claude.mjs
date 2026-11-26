#!/usr/bin/env node
// Drives the real Agent SDK's MCP transport without a model call.
import readline from 'node:readline';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let n = 0, prompt = '', stage = 'idle';
const request = (message) => send({ type: 'control_request', request_id: `mcp-${++n}`, request: { subtype: 'mcp_message', server_name: 'workspace', message } });
const answer = (text) => send({ type: 'assistant', message: { id: `message-${++n}`, model: 'fixture', role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session });
const finish = () => { stage = 'idle'; send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, session_id: session, usage: { input_tokens: 1, output_tokens: 1 } }); };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: msg.request.subtype === 'initialize' ? { commands: [], models: [], output_style: 'default', available_output_styles: ['default'], account: {} } : {} } });
    if (msg.request.subtype === 'interrupt') finish();
    return;
  }
  if (msg.type === 'user') {
    prompt = JSON.stringify(msg.message.content);
    if (!process.argv.includes('--strict-mcp-config') || !process.argv.includes('--tools') || !process.argv.includes('--no-session-persistence')) { answer('UNSAFE OPTIONS'); finish(); return; }
    if (prompt.includes('hold-turn')) { answer('holding'); return; }
    stage = 'init';
    request({ jsonrpc: '2.0', id: n + 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
    return;
  }
  if (msg.type === 'control_response' && msg.response?.request_id?.startsWith('mcp-')) {
    if (stage === 'init') {
      stage = 'tool';
      const write = prompt.includes('write-workspace');
      request({ jsonrpc: '2.0', id: n + 1, method: 'tools/call', params: { name: write ? 'write_file' : 'read_file', arguments: write ? { path: 'result.txt', content: 'written by remote AI' } : { path: 'identity.txt' } } });
    } else if (stage === 'tool') {
      answer(JSON.stringify(msg.response.response)); finish();
    }
  }
});
