import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { engineEnv, cap, INPUT_MAX } from './env.js';

// The Agent Client Protocol client that Antigravity (`agy acp`) and GitHub Copilot (`copilot --acp --stdio`) share. One
// process serves one chat. What differs per tool (the program, its arguments, how a tool call names a file or a command,
// how a spent quota shows up) comes in through the adapter, so the protocol code exists once.
const PROTOCOL_VERSION = 1;
const CALL_TIMEOUT_MS = 60_000;

const TOOL_STATUS = { pending: 'running', in_progress: 'running', completed: 'ok', failed: 'error' };
const STOP_STATUS = { end_turn: 'done', max_tokens: 'done', max_turn_requests: 'done', cancelled: 'interrupted', refusal: 'failed' };

export const textOf = (content) => (content?.type === 'text' ? content.text : '');

// Tool call content is a list of blocks: text, or a diff of one file.
function blocksText(content) {
  return (content ?? []).map((c) => (c.type === 'content' ? textOf(c.content) : c.type === 'diff' ? `${c.path}` : '')).filter(Boolean).join('\n');
}

const lines = (text) => (text ?? '').split('\n').filter(Boolean);

// The default way a tool call names things, the way `agy` does. An adapter overrides what its tool does differently.
export const defaultShape = {
  commandOf: (tc) => tc.rawInput?.CommandLine,
  pathOf: (tc) => tc.locations?.[0]?.path ?? tc.rawInput?.Path,
  // Before the diff blocks arrive, a write may name the file and its full content in the tool input.
  inputDiff: (tc) => (tc.kind === 'edit' && typeof tc.rawInput?.Content === 'string' ? `@@ ${tc.rawInput.Path ?? ''}\n${lines(tc.rawInput.Content).map((l) => `+${l}`).join('\n')}` : null),
  titleOf: (tc, shape) => (tc.kind === 'edit' && shape.pathOf(tc) ? `File ${shape.pathOf(tc).split(/[\\/]/).pop()}` : tc.title),
};

export function diffOf(content, tc, shape) {
  const diffs = (content ?? []).filter((c) => c.type === 'diff');
  if (diffs.length) return diffs.map((d) => `@@ ${d.path}\n${[...lines(d.oldText).map((l) => `-${l}`), ...lines(d.newText).map((l) => `+${l}`)].join('\n')}`).join('\n');
  return shape.inputDiff(tc ?? {});
}

// adapter: { label, prefix, bin(), args(chat), signInHint, isAuthError(err), afterSession({ call, sessionId, chat, init }),
//            configure(changes, { call, sessionId, chat }), quotaNotice(answer), shape }
export function createAcpEngine(chat, adapter) {
  const { label, prefix } = adapter;
  const shape = { ...defaultShape, ...adapter.shape };
  const titleOf = (tc) => shape.titleOf(tc, shape);
  let child = null;
  let sessionId = null;
  let nextId = 1;
  let stopping = false;
  const calls = new Map();
  // A resumed chat starts a new engine but keeps its old events, so ids must not repeat across engines.
  const freshId = (kind) => `${prefix}-${kind}-${crypto.randomBytes(6).toString('hex')}`;
  let textId = null;
  let turnText = '';
  let thoughtId = null;
  // session/load replays the whole conversation as updates before it answers. They are already in the chat.
  let loading = false;

  const write = (message) => {
    if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  function call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    if (!child) return Promise.reject(new Error(`The ${label} connection closed. Send your message again to reconnect.`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs && setTimeout(() => {
        calls.delete(id);
        reject(new Error(`${label} did not answer ${method} within ${timeoutMs / 1000} seconds.`));
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
      turnText += text;
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

  const toolId = (id) => `${prefix}-tool-${id}`;

  const UPDATES = {
    agent_message_chunk: (u) => chunk('text', u.content),
    agent_thought_chunk: (u) => chunk('thought', u.content),
    tool_call: (u) => {
      closeText();
      const id = toolId(u.toolCallId);
      const diff = diffOf(u.content, u, shape);
      const command = shape.commandOf(u);
      const fields = u.kind === 'edit' || diff
        ? { type: 'file-edit', path: shape.pathOf(u) ?? u.title, diff: cap(diff ?? ''), status: TOOL_STATUS[u.status] ?? 'running' }
        : { type: 'tool-run', name: titleOf(u) || u.kind || 'Tool', summary: u.kind === 'execute' ? cap(command ?? '', 200) : '', input: cap(u.rawInput ?? '', INPUT_MAX), output: cap(blocksText(u.content)), status: TOOL_STATUS[u.status] ?? 'running' };
      if (chat.find(id)) chat.update(id, fields);
      else chat.emit({ id, ...fields });
    },
    tool_call_update: (u) => {
      const id = toolId(u.toolCallId);
      if (!chat.find(id)) return;
      const patch = {};
      if (u.status) patch.status = TOOL_STATUS[u.status] ?? 'running';
      const edit = chat.find(id).type === 'file-edit';
      const diff = diffOf(u.content, u, shape);
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
    const diff = diffOf(tc.content, tc, shape);
    const res = await chat.ask({
      type: 'permission-request', kind: diff ? 'file' : 'command', title: titleOf(tc) || `${label} wants to use a tool`,
      detail: (tc.kind === 'execute' && shape.commandOf(tc)) || (diff ? shape.pathOf(tc) : cap(tc.rawInput ?? blocksText(tc.content), INPUT_MAX)),
      diff: diff ? cap(diff) : undefined,
      rule: grantKey.replace(/^tool:/, 'Tool: '),
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
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message ?? `${label} error`), { code: msg.error.code }));
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

  const engine = {
    async start() {
      const bin = adapter.bin();
      if (!bin) throw new Error(`${adapter.installName ?? label} is not installed on this computer.`);
      child = spawn(bin, adapter.args(chat), { cwd: chat.cwd, env: { ...engineEnv(), ...adapter.env?.(chat) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      readline.createInterface({ input: child.stdout }).on('line', receive);
      child.on('error', (err) => gone(new Error(`Could not start ${label}: ${err.message}`)));
      child.on('exit', (code) => gone(new Error(stderr.trim() || `${label} stopped (exit ${code}).`)));
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
        await adapter.afterSession?.({ call, sessionId, chat, init, created: res });
        chat.setSession(sessionId);
      } catch (err) {
        const message = adapter.isAuthError?.(err) ? adapter.signInHint : err.message;
        await engine.stop();
        throw new Error(message);
      }
    },

    async send({ text, images }) {
      textId = thoughtId = null;
      turnText = '';
      const prompt = [{ type: 'text', text }];
      for (const img of images ?? []) prompt.push({ type: 'image', mimeType: img.mediaType, data: img.data });
      let res;
      try {
        res = await call('session/prompt', { sessionId, prompt }, 0);
      } catch (err) {
        closeText();
        const notice = adapter.errorNotice?.(err);
        if (notice) {
          chat.emit(notice);
          chat.endTurn({ status: 'failed' });
          return;
        }
        if (adapter.authOnPrompt && adapter.isAuthError?.(err)) throw new Error(adapter.signInHint);
        throw err;
      }
      closeText();
      const quota = adapter.quotaNotice?.(turnText);
      if (quota) chat.emit(quota);
      chat.endTurn({ status: STOP_STATUS[res?.stopReason] ?? 'done' });
    },

    async interrupt() {
      if (sessionId) write({ method: 'session/cancel', params: { sessionId } });
    },

    // A change applies to the next prompt in the same session, or the next start of the process for what only a
    // command-line argument can set. The adapter decides which.
    async configure(changes) {
      return adapter.configure ? adapter.configure(changes, { call, sessionId, chat }) : {};
    },

    async stop() {
      stopping = true;
      const proc = child;
      child = null;
      for (const { reject, timer } of calls.values()) { clearTimeout(timer); reject(new Error(`The ${label} connection closed.`)); }
      calls.clear();
      if (proc && proc.exitCode === null) proc.kill();
    },
  };
  return engine;
}
