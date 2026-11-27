import fs from 'node:fs';
import { BROWSER_MCP_NAME, browserAutomationStatus, browserMcpConfig } from './browser-tools.js';
import { saveToolImages, resultText } from './tool-images.js';
import { requestCodexPermissions } from './codex-permissions.js';
import { requestMcpInput } from './mcp-input.js';
import path from 'node:path';
import { findBin, engineEnv, cap, lineDiff, OUTPUT_MAX } from './env.js';
import { connectCodexRpc, codexSocketPath } from './codex-rpc.js';
import { codexLimitNotices } from './limits.js';

const CODEX_BIN = process.env.POCKET_DEV_CODEX || findBin('codex');
// A binary override keeps tests/custom installations isolated unless they also select a socket.
const CODEX_SOCKET = codexSocketPath();

const SANDBOX_POLICY = {
  'read-only': { type: 'readOnly', networkAccess: false },
  'workspace-write': { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  'danger-full-access': { type: 'dangerFullAccess' },
};

// The approval policies codex app-server 0.166 accepts (AskForApproval); it has no on-failure.
const APPROVAL_POLICIES = [
  { value: 'untrusted', label: 'Ask first', description: 'Asks before any command that is not a known safe read' },
  { value: 'on-request', label: 'On request', description: 'Codex decides when to ask, such as to leave the sandbox' },
  { value: 'never', label: 'Never ask', description: 'Never asks; failures go back to Codex' },
];

const SANDBOXES = [
  { value: 'read-only', label: 'Read only', description: 'Can read files, cannot change anything' },
  { value: 'workspace-write', label: 'Workspace', description: 'Can change files inside the chat folder' },
  {
    value: 'danger-full-access', label: 'Full access', description: 'No sandbox: any file, any command, network',
    confirm: 'Codex will be able to change any file and run any command outside the sandbox. Continue?',
  },
];

const EFFORTS = [
  { value: 'default', label: 'Default', description: 'From ~/.codex/config.toml' },
  { value: 'low', label: 'Low', description: 'Fastest' },
  { value: 'medium', label: 'Medium', description: '' },
  { value: 'high', label: 'High', description: '' },
  { value: 'xhigh', label: 'Extra high', description: 'Slowest, most thorough' },
];

export async function settingsSchema() {
  return [
    { key: 'model', label: 'Model', default: 'default', custom: true, choices: await listModels() },
    { key: 'approvalPolicy', label: 'Approval', default: 'untrusted', choices: APPROVAL_POLICIES },
    { key: 'sandbox', label: 'Sandbox', default: 'workspace-write', choices: SANDBOXES },
    { key: 'effort', label: 'Effort', default: 'default', choices: EFFORTS },
    { key: 'browser', label: 'Browser', default: 'off', choices: [
      { value: 'off', label: 'Off', description: 'No Pocket browser tools' },
      ...(browserAutomationStatus().available ? [{ value: 'isolated', label: 'Separate browser', description: 'Browser automation in a separate Chrome or Edge session', confirm: 'Allow this personal Codex chat to open and control a separate browser? It will not use your existing browser profile. Browser actions can interact with websites you open.' }] : []),
    ] },
  ];
}

export const codexBinary = () => CODEX_BIN;
export const isInstalled = () => Boolean(CODEX_BIN) && (!path.isAbsolute(CODEX_BIN) || fs.existsSync(CODEX_BIN));
export const grantLabel = (grant) => (grant === 'files' ? 'All file changes' : grant.replace(/^command:/, 'Command: '));

// Reuse the terminal's daemon so resuming its threads does not compete for the writer lock.
// Older installs without a daemon share one private stdio process instead.
const server = {
  connection: null,
  ready: null,
  users: 0,
  threads: new Map(),

  start() {
    if (this.ready) return this.ready;
    const ready = connectCodexRpc({ bin: CODEX_BIN, env: engineEnv(), socketPath: CODEX_SOCKET, experimental: true }).then((connection) => {
      this.connection = connection;
      connection.onMessage = (msg) => this.onMessage(msg);
      connection.onGone = (err) => {
        if (this.connection !== connection) return;
        this.connection = this.ready = null;
        const engines = [...this.threads.values()];
        this.threads.clear();
        for (const engine of engines) engine.gone(err);
      };
      return connection;
    });
    this.ready = ready;
    ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  },

  async acquire() {
    this.users++;
    try { await this.start(); }
    catch (err) { this.release(); throw err; }
  },

  stop() {
    const { connection } = this;
    this.connection = this.ready = null;
    connection?.close();
  },

  release() {
    this.users--;
    if (!this.users) this.stop();
  },

  write(msg) {
    this.connection?.write(msg);
  },

  call(method, params, timeoutMs) {
    return this.connection?.call(method, params, timeoutMs) ?? Promise.reject(new Error('The Codex connection closed. Send your message again to reconnect.'));
  },

  onMessage(msg) {
    const engine = this.threads.get(msg.params?.threadId);
    if (msg.id != null) {
      if (engine) engine.onRequest(msg.id, msg.method, msg.params);
      else this.write({ id: msg.id, error: { code: -32601, message: `Pocket Dev cannot answer ${msg.method}` } });
    } else if (msg.method === 'account/rateLimits/updated') {
      // The limit belongs to the account, so it names no thread: every open Codex chat hears it.
      for (const open of this.threads.values()) open.onNotification(msg.method, msg.params);
    } else {
      engine?.onNotification(msg.method, msg.params);
    }
  },
};

let modelsCache = null;

export async function listModels() {
  modelsCache ??= (async () => {
    await server.acquire();
    try {
      const { data } = await server.call('model/list', {});
      return [
        { value: 'default', label: 'Default', description: 'Model from ~/.codex/config.toml' },
        ...data.filter((m) => !m.hidden).map((m) => ({ value: m.model, label: m.displayName, description: m.description })),
      ];
    } finally {
      server.release();
    }
  })().catch(() => {
    modelsCache = null;
    return [{ value: 'default', label: 'Default', description: 'Model from ~/.codex/config.toml' }];
  });
  return modelsCache;
}

const unwrapShell = (command) => command.replace(/^\/bin\/(?:ba|z)?sh -lc /, '').replace(/^(["'])(.*)\1$/s, '$2');

// Codex sends a whole new or deleted file as plain content and only updates as a unified diff.
const changeDiff = (c) => cap(c.kind.type === 'add' ? lineDiff('', c.diff) : c.kind.type === 'delete' ? lineDiff(c.diff, '') : c.diff);

const ITEM_STATUS = { completed: 'ok', failed: 'error', declined: 'denied', inProgress: 'running' };

export function createCodexEngine(chat) {
  let acquired = false;
  let threadId = null;
  let turnId = null;
  // Codex reports thread-wide token totals; a turn's usage is the growth since the turn started.
  let total = null;
  let turnBase = null;
  const fileChanges = new Map();
  const outputLen = new Map();
  let threadModel = null, effectiveSandbox = null, sandboxMode = null, browserEnabled = false;
  const model = () => (chat.settings.model === 'default' ? null : chat.settings.model);

  const withCwd = (command, cwd) => (cwd && cwd !== chat.cwd ? `${command}\n\nin ${cwd}` : command);
  const reply = (id, result) => server.write({ id, result });

  function ensureThinking(id) {
    if (!chat.find(id)) chat.emit({ id, type: 'thinking', text: '', streaming: true });
  }

  const ITEMS = {
    agentMessage: {
      started: (item) => chat.emit({ id: item.id, type: 'assistant-text', text: item.text ?? '', streaming: true, model: model() ?? threadModel }),
      completed: (item) => chat.find(item.id)
        ? chat.update(item.id, { text: item.text, streaming: false })
        : chat.emit({ id: item.id, type: 'assistant-text', text: item.text, streaming: false, model: model() ?? threadModel }),
    },
    reasoning: {
      completed: (item) => {
        const text = item.summary.join('\n\n');
        if (chat.find(item.id)) chat.update(item.id, { text: text || chat.find(item.id).text, streaming: false });
        else if (text) chat.emit({ id: item.id, type: 'thinking', text, streaming: false });
      },
    },
    commandExecution: {
      started: (item) => chat.emit({
        id: item.id, type: 'tool-run', name: 'Shell', summary: unwrapShell(item.command),
        input: withCwd(unwrapShell(item.command), item.cwd), output: '', status: 'running',
      }),
      completed: (item) => chat.update(item.id, {
        status: item.status === 'completed' && item.exitCode ? 'error' : ITEM_STATUS[item.status],
        output: cap(item.aggregatedOutput ?? chat.find(item.id)?.output ?? ''),
      }),
    },
    fileChange: {
      started: (item) => {
        fileChanges.set(item.id, item.changes);
        item.changes.forEach((c, i) => chat.emit({ id: `${item.id}:${i}`, type: 'file-edit', path: c.path, diff: changeDiff(c), status: 'running' }));
      },
      completed: (item) => item.changes.forEach((c, i) => {
        const id = `${item.id}:${i}`;
        const patch = { path: c.path, diff: changeDiff(c), status: ITEM_STATUS[item.status] };
        if (chat.find(id)) chat.update(id, patch);
        else chat.emit({ id, type: 'file-edit', ...patch });
      }),
    },
    mcpToolCall: {
      started: (item) => chat.emit({
        id: item.id, type: 'tool-run', name: `${item.server}.${item.tool}`, summary: '',
        input: cap(item.arguments, 4000), output: '', status: 'running',
      }),
      completed: (item) => {
        const content = item.result?.content;
        const normalized = Array.isArray(content) ? content.map((block) => block?.type === 'image' && typeof block.data === 'string' ? { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } } : block) : null;
        const images = normalized ? saveToolImages(chat.imageDir, normalized, item.id) : new Map();
        const output = item.error ? cap(item.error) : normalized ? cap(resultText(normalized, images)) : cap(item.result);
        chat.update(item.id, { status: item.error || item.result?.isError ? 'error' : 'ok', output, ...(images.size && { images: [...images.values()] }) });
      },
    },
    webSearch: {
      completed: (item) => chat.emit({ id: item.id, type: 'tool-run', name: 'Web search', summary: item.query ?? '', input: cap(item, 4000), output: '', status: 'ok' }),
    },
    contextCompaction: {
      completed: () => chat.emit({ type: 'status', text: 'Conversation compacted' }),
    },
  };

  const NOTIFICATIONS = {
    'turn/started': ({ turn }) => { turnId = turn.id; },
    'item/started': ({ item }) => ITEMS[item.type]?.started?.(item),
    'item/completed': ({ item }) => ITEMS[item.type]?.completed?.(item),
    'item/agentMessage/delta': ({ itemId, delta }) => chat.delta(itemId, 'text', delta),
    'item/reasoning/summaryTextDelta': ({ itemId, delta }) => {
      ensureThinking(itemId);
      chat.delta(itemId, 'text', delta);
    },
    'item/commandExecution/outputDelta': ({ itemId, delta }) => {
      const len = (outputLen.get(itemId) ?? 0) + delta.length;
      outputLen.set(itemId, len);
      if (len <= OUTPUT_MAX) chat.delta(itemId, 'output', delta);
    },
    'account/rateLimits/updated': ({ rateLimits }) => {
      for (const notice of codexLimitNotices(rateLimits, (chat.limitSeen ??= new Map()))) chat.emit(notice);
    },
    'thread/tokenUsage/updated': ({ tokenUsage }) => { total = tokenUsage.total; },
    'turn/completed': ({ turn }) => {
      turnId = null;
      if (turn.status === 'failed' && turn.error) chat.emit({ type: 'error', message: turn.error.message });
      const usage = total && turnBase && { input: total.inputTokens - turnBase.inputTokens, output: total.outputTokens - turnBase.outputTokens };
      chat.endTurn({ status: { completed: 'done', interrupted: 'interrupted' }[turn.status] ?? 'failed', durationMs: turn.durationMs, usage: usage || undefined });
    },
    error: ({ error, willRetry }) => {
      if (!willRetry) chat.emit({ type: 'error', message: error.message });
    },
  };

  const decisions = (params, fallback) => params.availableDecisions?.filter((d) => typeof d === 'string') ?? fallback;

  // Codex only offers acceptForSession for some requests. Pocket Dev keeps its own per-chat list too, so
  // "Approve for this chat" holds across engine restarts and for requests without that option.
  async function approve(id, params, { grantKey, kind, title, detail, diff, fallback }) {
    const offered = decisions(params, fallback);
    const deny = offered.includes('decline') ? 'decline' : 'cancel';
    // A running turn still has the policy it started with. Honor a live switch
    // to never at the client boundary without granting extra sandbox access.
    if (chat.settings.approvalPolicy === 'never') {
      chat.emit({ type: 'status', text: 'Permission request declined because Approval is set to Never ask.' });
      return reply(id, { decision: deny });
    }
    if (chat.grants.includes(grantKey)) return reply(id, { decision: 'accept' });
    const res = await chat.ask({
      type: 'permission-request', kind, title, detail, diff,
      rule: grantLabel(grantKey),
      options: [{ id: 'allow', label: 'Approve' }, { id: 'allow-chat', label: 'Approve for this chat' }, { id: 'deny', label: 'Deny' }],
    });
    if (res.cancelled) return reply(id, { decision: 'cancel' });
    if (res.decision === 'deny') {
      reply(id, { decision: deny });
      if (res.message && turnId) {
        server.call('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: res.message, text_elements: [] }] }).catch(() => {});
      }
      return;
    }
    if (res.decision === 'allow-chat') {
      chat.addGrant(grantKey);
      chat.changed();
      return reply(id, { decision: offered.includes('acceptForSession') ? 'acceptForSession' : 'accept' });
    }
    reply(id, { decision: 'accept' });
  }

  async function askUser(id, params) {
    const questions = params.questions.map((qn) => ({
      id: qn.id, header: qn.header, question: qn.question,
      options: qn.options ?? [], multiSelect: false, allowOther: qn.isOther || !qn.options?.length,
    }));
    const res = await chat.ask({ type: 'question', questions });
    const answers = res.cancelled ? {} : Object.fromEntries(Object.entries(res.answers).map(([k, v]) => [k, { answers: v }]));
    reply(id, { answers });
  }

  const REQUESTS = {
    'item/commandExecution/requestApproval': (id, p) => approve(id, p, {
      grantKey: `command:${unwrapShell(p.command ?? '')}`, kind: 'command',
      title: `Run ${unwrapShell(p.command ?? '')}`, detail: [p.reason, withCwd(unwrapShell(p.command ?? ''), p.cwd)].filter(Boolean).join('\n\n'),
      fallback: ['accept', 'acceptForSession', 'decline', 'cancel'],
    }),
    'item/fileChange/requestApproval': (id, p) => {
      const changes = fileChanges.get(p.itemId) ?? [];
      return approve(id, p, {
        grantKey: 'files', kind: 'file',
        title: p.reason || `Change ${changes.length === 1 ? changes[0].path : `${changes.length} files`}`,
        detail: changes.map((c) => c.path).join('\n'),
        diff: changes.map((c) => `@@ ${c.path}\n${changeDiff(c)}`).join('\n'),
        fallback: ['accept', 'acceptForSession', 'decline', 'cancel'],
      });
    },
    'item/tool/requestUserInput': askUser,
    'item/permissions/requestApproval': async (id, params) => reply(id, await requestCodexPermissions(chat, params)),
    'mcpServer/elicitation/request': async (id, params) => reply(id, await requestMcpInput(chat, params)),
  };

  const engine = {
    async start() {
      await server.acquire();
      acquired = true;
      const { approvalPolicy, sandbox } = chat.settings;
      const params = { cwd: chat.cwd, model: model(), approvalPolicy, sandbox };
      browserEnabled = chat.settings.browser === 'isolated';
      try {
        if (browserEnabled) {
          const { config } = await server.call('config/read', { cwd: chat.cwd, includeLayers: false });
          if (config?.mcp_servers?.[BROWSER_MCP_NAME]) throw new Error('An MCP server named pocket_dev_browser already exists. Keep using that configured server or rename it before enabling Pocket browser tools.');
          params.config = { [`mcp_servers.${BROWSER_MCP_NAME}`]: browserMcpConfig(chat) };
        } else if (chat.browserToolsUsed) params.config = { [`mcp_servers.${BROWSER_MCP_NAME}`]: { command: process.execPath, args: ['-e', 'process.exit(0)'], enabled: false } };
      } catch (error) { acquired = false; server.release(); throw error; }
      let res;
      try {
        res = chat.sessionId
          ? await server.call('thread/resume', { threadId: chat.sessionId, ...params, excludeTurns: true })
          : await server.call('thread/start', params);
      } catch (err) {
        acquired = false;
        server.release();
        if (/already has an active writer/i.test(err.message)) {
          throw new Error('This conversation is owned by another Codex server. Close its original Codex session, then send your message again, or start a new Codex chat.');
        }
        throw err;
      }
      threadId = res.thread.id;
      if (!browserEnabled && chat.browserToolsUsed) {
        try {
          const inventory = await server.call('mcpServerStatus/list', { threadId, limit: 100 }, 10000);
          if (!Array.isArray(inventory.data) || inventory.data.some((entry) => entry.name === BROWSER_MCP_NAME && Object.keys(entry.tools || {}).length)) throw new Error('Browser tools remain attached to the native thread.');
        } catch {
          await server.call('thread/unsubscribe', { threadId }).catch(() => {});
          acquired = false; server.release();
          throw Object.assign(new Error('Codex could not confirm browser access was disabled. Close this conversation in other Codex clients and retry.'), { code: 'BROWSER_DISABLED_UNCONFIRMED', recoverable: true, feature: 'browser' });
        }
      }
      threadModel = res.model;
      sandboxMode = sandbox; effectiveSandbox = res.sandbox || null;
      if (!chat.sessionId) total = { inputTokens: 0, outputTokens: 0 };
      server.threads.set(threadId, engine);
      if (browserEnabled) chat.browserToolsUsed = true;
      chat.setSession(threadId);
    },

    async send({ text, images }) {
      const { approvalPolicy, sandbox, effort } = chat.settings;
      turnBase = total;
      const res = await server.call('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }, ...images.map(({ path }) => ({ type: 'localImage', path }))],
        model: model(),
        approvalPolicy,
        // Preserve the policy computed by Codex for this project, including its actual writable roots.
        sandboxPolicy: sandbox === sandboxMode && effectiveSandbox ? effectiveSandbox : { ...SANDBOX_POLICY[sandbox], ...(sandbox === 'workspace-write' ? { writableRoots: [chat.cwd] } : {}) },
        effort: effort === 'default' ? null : effort,
      });
      turnId ??= res.turn.id;
    },

    async interrupt() {
      if (turnId) await server.call('turn/interrupt', { threadId, turnId });
    },

    // The next turn receives the full policy. Suppressing prompts can take
    // effect immediately, including requests already waiting for an answer.
    async configure(changes) {
      if (Object.hasOwn(changes, 'browser')) {
        await engine.stop(); if (chat.engine === engine) chat.engine = null;
      }
      if (changes.approvalPolicy === 'never') {
        for (const [requestId, { event }] of chat.requests) {
          if (event.type === 'permission-request') chat.answer(requestId, { decision: 'deny' });
        }
      }
      return Object.fromEntries(Object.keys(changes).map((k) => [k, k === 'approvalPolicy' && changes[k] === 'never' ? 'now' : 'next-turn']));
    },

    async stop() {
      if (!acquired) return;
      acquired = false;
      if (threadId) {
        if (browserEnabled) await server.call('mcpServer/tool/call', { threadId, server: BROWSER_MCP_NAME, tool: 'browser_close', arguments: {} }, 5000).catch(() => {});
        server.threads.delete(threadId);
        await server.call('thread/unsubscribe', { threadId }).catch(() => {});
      }
      server.release();
    },

    onNotification(method, params) {
      NOTIFICATIONS[method]?.(params);
    },

    onRequest(id, method, params) {
      const handle = REQUESTS[method];
      if (handle) handle(id, params).catch(() => reply(id, method === 'mcpServer/elicitation/request' ? { action: 'cancel', content: null } : method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'cancel' }));
      else server.write({ id, error: { code: -32601, message: `Pocket Dev cannot answer ${method}` } });
    },

    gone(err) {
      if (acquired) { acquired = false; server.release(); }
      if (chat.engine === engine) chat.engine = null;
      if (chat.turn) chat.fail(err.message);
      else chat.changed();
    },
  };
  return engine;
}
