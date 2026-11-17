import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { findBin, engineEnv, cap, INPUT_MAX } from './env.js';

// Google Antigravity CLI. `agy acp` is an Agent Client Protocol server on standard input and output; the sign-in
// and the settings are the ones the terminal `agy` already has. One process serves one chat.
const AGY_BIN = process.env.POCKET_DEV_AGY || findBin('agy');
const PROTOCOL_VERSION = 1;
const CALL_TIMEOUT_MS = 60_000;

// The models `agy` listed on 1.5.9. Any other id that `agy` accepts can be typed in, and a newer agy may offer more.
const MODELS = [
  { value: 'default', label: 'Default', description: 'The model agy is set to' },
  { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', description: '' },
  { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', description: '' },
  { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', description: 'Fastest' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', description: '' },
  { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', description: 'Most thorough' },
  { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', description: '' },
];

export const settingsSchema = async () => [{ key: 'model', label: 'Model', default: 'default', custom: true, choices: MODELS }];

export const isInstalled = () => Boolean(AGY_BIN) && (!path.isAbsolute(AGY_BIN) || fs.existsSync(AGY_BIN));
export const grantLabel = (grant) => grant.replace(/^tool:/, 'Tool: ');

const TOOL_STATUS = { pending: 'running', in_progress: 'running', completed: 'ok', failed: 'error' };
const STOP_STATUS = { end_turn: 'done', max_tokens: 'done', max_turn_requests: 'done', cancelled: 'interrupted', refusal: 'failed' };

const textOf = (content) => (content?.type === 'text' ? content.text : '');

// Tool call content is a list of blocks: text, or a diff of one file.
function blocksText(content) {
  return (content ?? []).map((c) => (c.type === 'content' ? textOf(c.content) : c.type === 'diff' ? `${c.path}` : '')).filter(Boolean).join('\n');
}

const lines = (text) => (text ?? '').split('\n').filter(Boolean);

// A file change carries its diff as content blocks, but agy sends them only with the permission request and the final
// update. Before that, a write names the file and its full content in the tool input.
function diffOf(content, tc = {}) {
  const diffs = (content ?? []).filter((c) => c.type === 'diff');
  if (diffs.length) return diffs.map((d) => `@@ ${d.path}\n${[...lines(d.oldText).map((l) => `-${l}`), ...lines(d.newText).map((l) => `+${l}`)].join('\n')}`).join('\n');
  const input = tc.rawInput;
  if (tc.kind === 'edit' && typeof input?.Content === 'string') return `@@ ${input.Path ?? ''}\n${lines(input.Content).map((l) => `+${l}`).join('\n')}`;
  return null;
}

const pathOf = (tc) => tc.locations?.[0]?.path ?? tc.rawInput?.Path;
// agy titles an edit with a path relative to a resolved symlink, such as ../../private/tmp/x, so show the file name alone.
const titleOf = (tc) => (tc.kind === 'edit' && pathOf(tc) ? `File ${pathOf(tc).split(/[\\/]/).pop()}` : tc.title);

export function createAntigravityEngine(chat) {
  let child = null;
  let sessionId = null;
  let nextId = 1;
  let stopping = false;
  const calls = new Map();
  // A resumed chat starts a new engine but keeps its old events, so ids must not repeat across engines.
  const freshId = (kind) => `agy-${kind}-${crypto.randomBytes(6).toString('hex')}`;
  let textId = null;
  let thoughtId = null;
  // session/load replays the whole conversation as updates before it answers. They are already in the chat.
  let loading = false;

  const write = (message) => {
    if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  function call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    if (!child) return Promise.reject(new Error('The Antigravity connection closed. Send your message again to reconnect.'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs && setTimeout(() => {
        calls.delete(id);
        reject(new Error(`Antigravity did not answer ${method} within ${timeoutMs / 1000} seconds.`));
      }, timeoutMs);
      calls.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  }

  function closeText() {
    if (textId && chat.find(textId)) chat.update(textId, { streaming: false });
    if (thoughtId && chat.find(thoughtId)) chat.update(thoughtId, { streaming: false });
    textId = thoughtId = null;
  }

  function chunk(kind, content) {
    const text = textOf(content);
    if (!text) return;
    if (kind === 'text') {
      if (thoughtId) { chat.update(thoughtId, { streaming: false }); thoughtId = null; }
      if (!textId) {
        textId = freshId('text');
        chat.emit({ id: textId, type: 'assistant-text', text, streaming: true });
      } else chat.delta(textId, 'text', text);
    } else {
      if (!thoughtId) {
        thoughtId = freshId('thinking');
        chat.emit({ id: thoughtId, type: 'thinking', text, streaming: true });
      } else chat.delta(thoughtId, 'text', text);
    }
  }

  const toolId = (id) => `agy-tool-${id}`;

  const UPDATES = {
    agent_message_chunk: (u) => chunk('text', u.content),
    agent_thought_chunk: (u) => chunk('thought', u.content),
    tool_call: (u) => {
      closeText();
      const id = toolId(u.toolCallId);
      const diff = diffOf(u.content, u);
      const fields = u.kind === 'edit' || diff
        ? { type: 'file-edit', path: pathOf(u) ?? u.title, diff: cap(diff ?? ''), status: TOOL_STATUS[u.status] ?? 'running' }
        : { type: 'tool-run', name: titleOf(u) || u.kind || 'Tool', summary: u.kind === 'execute' ? cap(u.rawInput?.CommandLine ?? '', 200) : '', input: cap(u.rawInput ?? '', INPUT_MAX), output: cap(blocksText(u.content)), status: TOOL_STATUS[u.status] ?? 'running' };
      if (chat.find(id)) chat.update(id, fields);
      else chat.emit({ id, ...fields });
    },
    tool_call_update: (u) => {
      const id = toolId(u.toolCallId);
      if (!chat.find(id)) return;
      const patch = {};
      if (u.status) patch.status = TOOL_STATUS[u.status] ?? 'running';
      const edit = chat.find(id).type === 'file-edit';
      const diff = diffOf(u.content, u);
      if (edit) { if (diff) patch.diff = cap(diff); }
      else if (u.content) patch.output = cap(blocksText(u.content));
      chat.update(id, patch);
    },
  };

  async function requestPermission(id, params) {
    const tc = params.toolCall ?? {};
    const options = params.options ?? [];
    const pick = (...kinds) => options.find((o) => kinds.includes(o.kind))?.optionId;
    const grantKey = `tool:${titleOf(tc) || tc.kind || 'tool'}`;
    const answer = (optionId) => write({ id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
    if (chat.grants.includes(grantKey) && pick('allow_once', 'allow_always')) return answer(pick('allow_once', 'allow_always'));
    const diff = diffOf(tc.content, tc);
    const res = await chat.ask({
      type: 'permission-request', kind: diff ? 'file' : 'command', title: titleOf(tc) || 'Antigravity wants to use a tool',
      detail: (tc.kind === 'execute' && tc.rawInput?.CommandLine) || (diff ? pathOf(tc) : cap(tc.rawInput ?? blocksText(tc.content), INPUT_MAX)),
      diff: diff ? cap(diff) : undefined,
      rule: grantLabel(grantKey),
      options: [{ id: 'allow', label: 'Approve' }, { id: 'allow-chat', label: 'Approve for this chat' }, { id: 'deny', label: 'Deny' }],
    });
    if (res.cancelled) return answer(null);
    if (res.decision === 'deny') return answer(pick('reject_once', 'reject_always') ?? null);
    if (res.decision === 'allow-chat') {
      chat.addGrant(grantKey);
      chat.changed();
    }
    answer(pick('allow_once', 'allow_always'));
  }

  function receive(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && !msg.method) {
      const pending = calls.get(msg.id);
      if (!pending) return;
      calls.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message ?? 'Antigravity error'), { code: msg.error.code }));
      else pending.resolve(msg.result);
    } else if (msg.id != null) {
      if (msg.method === 'session/request_permission') {
        requestPermission(msg.id, msg.params ?? {}).catch(() => write({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } }));
      } else write({ id: msg.id, error: { code: -32601, message: `Pocket Dev cannot answer ${msg.method}` } });
    } else if (msg.method === 'session/update' && !loading && msg.params?.sessionId === sessionId) {
      UPDATES[msg.params.update?.sessionUpdate]?.(msg.params.update);
    }
  }

  function gone(err) {
    if (!child) return;
    child = null;
    for (const { reject, timer } of calls.values()) { clearTimeout(timer); reject(err); }
    calls.clear();
    if (stopping) return;
    if (chat.engine === engine) chat.engine = null;
    if (chat.turn) chat.fail(err.message);
    else chat.changed();
  }

  const signInHint = 'Antigravity is not signed in. In a Pocket Dev terminal run: agy acp --login';

  const engine = {
    async start() {
      if (!AGY_BIN) throw new Error('Antigravity (agy) is not installed on this computer.');
      child = spawn(AGY_BIN, ['acp'], { cwd: chat.cwd, env: engineEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      readline.createInterface({ input: child.stdout }).on('line', receive);
      child.on('error', (err) => gone(new Error(`Could not start Antigravity: ${err.message}`)));
      child.on('exit', (code) => gone(new Error(stderr.trim() || `Antigravity stopped (exit ${code}).`)));
      try {
        const init = await call('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'pocket-dev', title: 'Pocket Dev' } });
        const params = { cwd: chat.cwd, mcpServers: [] };
        let res;
        if (chat.sessionId && init.agentCapabilities?.loadSession) {
          sessionId = chat.sessionId;
          loading = true;
          try { await call('session/load', { sessionId, ...params }); } finally { loading = false; }
        } else {
          res = await call('session/new', params);
          sessionId = res.sessionId;
        }
        if (chat.settings.model && chat.settings.model !== 'default') await call('session/set_model', { sessionId, modelId: chat.settings.model });
        chat.setSession(sessionId);
      } catch (err) {
        const message = err.code === -32000 || /auth/i.test(err.message) ? signInHint : err.message;
        await engine.stop();
        throw new Error(message);
      }
    },

    async send({ text, images }) {
      textId = thoughtId = null;
      const prompt = [{ type: 'text', text }];
      for (const img of images ?? []) prompt.push({ type: 'image', mimeType: img.mediaType, data: img.data });
      let res;
      try {
        res = await call('session/prompt', { sessionId, prompt }, 0);
      } catch (err) {
        closeText();
        throw err;
      }
      closeText();
      chat.endTurn({ status: STOP_STATUS[res?.stopReason] ?? 'done' });
    },

    async interrupt() {
      if (sessionId) write({ method: 'session/cancel', params: { sessionId } });
    },

    // A model change applies to the next prompt in the same session.
    async configure(changes) {
      if (!changes.model) return {};
      if (changes.model === 'default') return { model: 'restart' };
      await call('session/set_model', { sessionId, modelId: changes.model });
      return { model: 'next-turn' };
    },

    async stop() {
      stopping = true;
      const proc = child;
      child = null;
      for (const { reject, timer } of calls.values()) { clearTimeout(timer); reject(new Error('The Antigravity connection closed.')); }
      calls.clear();
      if (proc && proc.exitCode === null) proc.kill();
    },
  };
  return engine;
}
