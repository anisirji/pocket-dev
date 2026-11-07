import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { findBin, engineEnv, cap, lineDiff, OUTPUT_MAX } from './env.js';

const CODEX_BIN = process.env.POCKET_DEV_CODEX || findBin('codex');

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
  ];
}

export const grantLabel = (grant) => (grant === 'files' ? 'All file changes' : grant.replace(/^command:/, 'Command: '));

// All Codex chats share one app-server process: it multiplexes threads, and each extra process costs memory on the
// Mac. It starts with the first awake chat and exits with the last one.
const server = {
  proc: null,
  ready: null,
  nextId: 1,
  calls: new Map(),
  threads: new Map(),

  start() {
    if (this.ready) return this.ready;
    if (!CODEX_BIN) return Promise.reject(new Error('codex is not installed (not found on PATH or in ~/.local/bin).'));
    const proc = spawn(CODEX_BIN, ['app-server'], { env: engineEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let stderrTail = '';
    proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.on('error', () => {});
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      const err = new Error(`codex app-server exited (${code ?? 'signal'})${stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : ''}`);
      this.proc = this.ready = null;
      for (const { reject } of this.calls.values()) reject(err);
      this.calls.clear();
      for (const engine of [...this.threads.values()]) engine.gone(err);
      this.threads.clear();
    });
    this.ready = this.call('initialize', {
      clientInfo: { name: 'pocket-dev', title: 'Pocket Dev', version: '1.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }).then(() => this.write({ method: 'initialized' }));
    this.ready.catch(() => this.stop());
    return this.ready;
  },

  stop() {
    const { proc } = this;
    this.proc = this.ready = null;
    proc?.kill();
  },

  release() {
    if (!this.threads.size) this.stop();
  },

  write(msg) {
    this.proc?.stdin.write(`${JSON.stringify(msg)}\n`);
  },

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  },

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && !msg.method) {
      const call = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      if (msg.error) call?.reject(new Error(msg.error.message ?? 'codex error'));
      else call?.resolve(msg.result);
      return;
    }
    const engine = this.threads.get(msg.params?.threadId);
    if (msg.id != null) {
      if (engine) engine.onRequest(msg.id, msg.method, msg.params);
      else this.write({ id: msg.id, error: { code: -32601, message: `Pocket Dev cannot answer ${msg.method}` } });
    } else {
      engine?.onNotification(msg.method, msg.params);
    }
  },
};

let modelsCache = null;

export async function listModels() {
  modelsCache ??= (async () => {
    await server.start();
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
  let threadId = null;
  let turnId = null;
  // Codex reports thread-wide token totals; a turn's usage is the growth since the turn started.
  let total = null;
  let turnBase = null;
  const fileChanges = new Map();
  const outputLen = new Map();
  let threadModel = null;
  const model = () => (chat.settings.model === 'default' ? null : chat.settings.model);

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
        input: `${unwrapShell(item.command)}\n\nin ${item.cwd}`, output: '', status: 'running',
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
      completed: (item) => chat.update(item.id, { status: item.error ? 'error' : 'ok', output: cap(item.error ?? item.result) }),
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
    if (chat.grants.includes(grantKey)) return reply(id, { decision: 'accept' });
    const res = await chat.ask({
      type: 'permission-request', kind, title, detail, diff,
      rule: grantLabel(grantKey),
      options: [{ id: 'allow', label: 'Approve' }, { id: 'allow-chat', label: 'Approve for this chat' }, { id: 'deny', label: 'Deny' }],
    });
    const deny = offered.includes('decline') ? 'decline' : 'cancel';
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
      title: p.reason || 'Run command', detail: `${unwrapShell(p.command ?? '')}\n\nin ${p.cwd ?? chat.cwd}`,
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
  };

  const engine = {
    async start() {
      await server.start();
      const { approvalPolicy, sandbox } = chat.settings;
      const params = { cwd: chat.cwd, model: model(), approvalPolicy, sandbox };
      const res = chat.sessionId
        ? await server.call('thread/resume', { threadId: chat.sessionId, ...params, excludeTurns: true })
        : await server.call('thread/start', params);
      threadId = res.thread.id;
      threadModel = res.model;
      if (!chat.sessionId) total = { inputTokens: 0, outputTokens: 0 };
      server.threads.set(threadId, engine);
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
        sandboxPolicy: SANDBOX_POLICY[sandbox],
        effort: effort === 'default' ? null : effort,
      });
      turnId ??= res.turn.id;
    },

    async interrupt() {
      if (turnId) await server.call('turn/interrupt', { threadId, turnId });
    },

    // turn/start carries every setting, so a change takes effect from the next turn.
    async configure(changes) {
      return Object.fromEntries(Object.keys(changes).map((k) => [k, 'next-turn']));
    },

    async stop() {
      if (threadId) {
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
      if (handle) handle(id, params).catch(() => reply(id, { decision: 'cancel' }));
      else server.write({ id, error: { code: -32601, message: `Pocket Dev cannot answer ${method}` } });
    },

    gone(err) {
      if (chat.engine === engine) chat.engine = null;
      if (chat.turn) chat.fail(err.message);
      else chat.changed();
    },
  };
  return engine;
}
