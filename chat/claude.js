import { query } from '@anthropic-ai/claude-agent-sdk';
import { findBin, engineEnv, cap, lineDiff, INPUT_MAX } from './env.js';

const CLAUDE_BIN = process.env.POCKET_DEV_CLAUDE || findBin('claude') || '/usr/local/bin/claude';

export const MODES = {
  default: { label: 'Ask first', description: 'Asks before edits and commands' },
  acceptEdits: { label: 'Accept edits', description: 'Edits files without asking, asks before commands' },
  plan: { label: 'Plan', description: 'Reads and plans, changes nothing until you approve the plan' },
  bypassPermissions: {
    label: 'Skip permissions', description: 'Runs everything without asking',
    confirm: 'Claude will edit files and run any command without asking. Continue?',
  },
};

// "default" means the model Claude Code itself picks (settings, then its built-in default); every other value is
// passed as --model.
const FALLBACK_MODELS = [
  { value: 'default', label: 'Default', description: 'Claude Code default' },
  { value: 'opus', label: 'Opus', description: '' },
  { value: 'sonnet', label: 'Sonnet', description: '' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest' },
];

let modelsCache = null;

// Asking the CLI costs one short-lived process (about 2 s) and no model call, so do it once per server run.
export async function listModels() {
  modelsCache ??= (async () => {
    const idle = inbox();
    const q = query({ prompt: idle, options: { pathToClaudeCodeExecutable: CLAUDE_BIN, env: engineEnv() } });
    try {
      const models = await q.supportedModels();
      return models.map((m) => ({ value: m.value, label: m.value === 'default' ? 'Default' : m.displayName, description: m.description }));
    } finally {
      idle.end();
      q.close();
    }
  })().catch(() => {
    modelsCache = null;
    return FALLBACK_MODELS;
  });
  return modelsCache;
}

const firstLine = (s) => String(s ?? '').split('\n')[0];

const SUMMARY = {
  Bash: (i) => firstLine(i.command),
  Read: (i) => i.file_path,
  Glob: (i) => i.pattern,
  Grep: (i) => `${i.pattern}${i.path ? `  ${i.path}` : ''}`,
  WebFetch: (i) => i.url,
  WebSearch: (i) => i.query,
  Task: (i) => i.description,
  Agent: (i) => i.description,
  TodoWrite: (i) => `${i.todos?.length ?? 0} todos`,
  NotebookEdit: (i) => i.notebook_path,
};
const summarize = (name, input) => SUMMARY[name]?.(input) ?? firstLine(Object.values(input).find((v) => typeof v === 'string') ?? '');

const DIFF = {
  Edit: (i) => lineDiff(i.old_string, i.new_string),
  MultiEdit: (i) => (i.edits ?? []).map((e) => lineDiff(e.old_string, e.new_string)).join('\n@@\n'),
  Write: (i) => lineDiff('', i.content),
};

const describeInput = (name, input) => (name === 'Bash' ? input.command : cap(input, INPUT_MAX));

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
}

// A pushable async iterable: the SDK reads user turns from it for as long as the engine lives.
function inbox() {
  const queue = [];
  let wake = null;
  let done = false;
  return {
    push(msg) {
      queue.push(msg);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length) yield queue.shift();
        if (done) return;
        await new Promise((r) => { wake = r; });
        wake = null;
      }
    },
  };
}

export function createClaudeEngine(chat) {
  const input = inbox();
  let q = null;
  let stopping = false;
  let stderrTail = '';
  const denied = new Set();
  // The CLI sends each content block twice: streamed (stream_event) and then whole (assistant). Streamed blocks are
  // queued per message so the whole block can replace the streamed text in the same event.
  const streamed = new Map();
  let streamMsg = null;
  const blockIds = new Map();

  function grant(updates) {
    for (const u of updates) {
      if (u.type === 'addRules' && u.behavior === 'allow') {
        for (const r of u.rules) chat.addGrant(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
      } else if (u.type === 'setMode' && MODES[u.mode]) {
        chat.mode = u.mode;
      }
    }
    chat.changed();
  }

  async function askQuestion(toolInput, signal) {
    const questions = (toolInput.questions ?? []).map((qn, i) => ({
      id: String(i), header: qn.header ?? '', question: qn.question ?? '',
      options: (qn.options ?? []).map(({ label, description }) => ({ label, description: description ?? '' })),
      multiSelect: Boolean(qn.multiSelect), allowOther: true,
    }));
    const res = await chat.ask({ type: 'question', questions }, signal);
    if (res.cancelled) return { behavior: 'deny', message: 'The user dismissed the question.', interrupt: chat.turn?.interrupted };
    // The SDK expects answers keyed by question text, with multi-select answers joined by ", ".
    const answers = Object.fromEntries(questions.map((qn) => [qn.question, (res.answers[qn.id] ?? []).join(', ')]));
    return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
  }

  async function canUseTool(toolName, toolInput, { signal, suggestions = [], toolUseID, title, description }) {
    if (toolName === 'AskUserQuestion') return askQuestion(toolInput, signal);
    const plan = toolName === 'ExitPlanMode';
    const options = plan
      ? [{ id: 'allow', label: 'Start working' }, { id: 'deny', label: 'Keep planning' }]
      : [{ id: 'allow', label: 'Allow' }, { id: 'allow-chat', label: 'Allow for this chat' }, { id: 'deny', label: 'Deny' }];
    const res = await chat.ask({
      type: 'permission-request',
      kind: plan ? 'plan' : toolName === 'Bash' ? 'command' : DIFF[toolName] ? 'file' : 'tool',
      title: plan ? 'Claude is ready to start' : title || `${toolName} ${summarize(toolName, toolInput)}`,
      detail: plan ? toolInput.plan ?? '' : [description, describeInput(toolName, toolInput)].filter(Boolean).join('\n\n'),
      diff: DIFF[toolName]?.(toolInput),
      options,
    }, signal);
    if (res.cancelled) return { behavior: 'deny', message: 'The request was cancelled.', interrupt: true };
    if (res.decision === 'deny') {
      denied.add(toolUseID);
      return { behavior: 'deny', message: res.message || 'The user denied this.' };
    }
    if (res.decision === 'allow-chat' || plan) {
      const updates = suggestions.length || plan
        ? suggestions
        : [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
      grant(updates);
      return { behavior: 'allow', updatedInput: toolInput, updatedPermissions: updates };
    }
    return { behavior: 'allow', updatedInput: toolInput };
  }

  function onToolUse(block) {
    if (block.name === 'AskUserQuestion') return;
    const { id, name, input: toolInput } = block;
    if (DIFF[name]) {
      chat.emit({ id, type: 'file-edit', path: toolInput.file_path ?? toolInput.notebook_path ?? '', diff: cap(DIFF[name](toolInput)), status: 'running' });
    } else {
      chat.emit({ id, type: 'tool-run', name, summary: summarize(name, toolInput), input: describeInput(name, toolInput), output: '', status: 'running' });
    }
  }

  function onToolResult(block) {
    const ev = chat.find(block.tool_use_id);
    if (!ev) return;
    const status = denied.has(block.tool_use_id) ? 'denied' : block.is_error ? 'error' : 'ok';
    chat.update(ev.id, ev.type === 'tool-run' ? { status, output: cap(resultText(block.content)) } : { status });
  }

  function onStreamEvent({ event }) {
    if (event.type === 'message_start') {
      streamMsg = event.message.id;
      blockIds.clear();
      return;
    }
    if (event.type === 'content_block_start') {
      const kind = event.content_block.type;
      if (kind !== 'text' && kind !== 'thinking') return;
      const id = `${streamMsg}:${event.index}`;
      blockIds.set(event.index, id);
      const list = streamed.get(streamMsg) ?? [];
      list.push({ kind, id });
      streamed.set(streamMsg, list);
      chat.emit({ id, type: kind === 'text' ? 'assistant-text' : 'thinking', text: '', streaming: true });
    } else if (event.type === 'content_block_delta') {
      const id = blockIds.get(event.index);
      if (event.delta.type === 'text_delta') chat.delta(id, 'text', event.delta.text);
      else if (event.delta.type === 'thinking_delta') chat.delta(id, 'text', event.delta.thinking);
    }
  }

  function settleBlock(msgId, kind, text) {
    const list = streamed.get(msgId) ?? [];
    const i = list.findIndex((b) => b.kind === kind);
    if (i === -1) {
      chat.emit({ type: kind === 'text' ? 'assistant-text' : 'thinking', text, streaming: false });
      return;
    }
    const [{ id }] = list.splice(i, 1);
    chat.update(id, { text, streaming: false });
  }

  function onMessage(m) {
    if (m.parent_tool_use_id) return;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') chat.setSession(m.session_id);
        else if (m.subtype === 'compact_boundary') chat.emit({ type: 'status', text: 'Conversation compacted' });
        return;
      case 'stream_event':
        return onStreamEvent(m);
      case 'assistant':
        if (m.error) chat.emit({ type: 'error', message: `Claude error: ${m.error}` });
        for (const block of m.message.content) {
          if (block.type === 'text') settleBlock(m.message.id, 'text', block.text);
          else if (block.type === 'thinking') settleBlock(m.message.id, 'thinking', block.thinking);
          else if (block.type === 'tool_use') onToolUse(block);
        }
        return;
      case 'user':
        if (Array.isArray(m.message.content)) {
          for (const block of m.message.content) if (block.type === 'tool_result') onToolResult(block);
        }
        return;
      case 'result': {
        streamed.clear();
        const u = m.usage ?? {};
        if (m.subtype !== 'success' && m.errors?.length && !chat.turn?.interrupted) chat.emit({ type: 'error', message: m.errors.join('\n') });
        chat.endTurn({
          status: m.subtype === 'success' && !m.is_error ? 'done' : 'failed',
          durationMs: m.duration_ms,
          costUsd: m.total_cost_usd,
          usage: { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 },
        });
        return;
      }
    }
  }

  async function consume() {
    try {
      for await (const m of q) onMessage(m);
    } catch (err) {
      if (!stopping) chat.fail(`Claude stopped: ${err.message}${stderrTail ? `\n${stderrTail.trim()}` : ''}`);
    }
    if (chat.engine === engine) chat.engine = null;
    if (!stopping && chat.turn) chat.fail('Claude exited during the turn.');
    chat.changed();
  }

  const engine = {
    async start() {
      const bypass = chat.mode === 'bypassPermissions';
      q = query({
        prompt: input,
        options: {
          cwd: chat.cwd,
          model: chat.model === 'default' ? undefined : chat.model,
          permissionMode: chat.mode,
          allowDangerouslySkipPermissions: bypass,
          resume: chat.sessionId ?? undefined,
          allowedTools: chat.grants,
          includePartialMessages: true,
          pathToClaudeCodeExecutable: CLAUDE_BIN,
          env: engineEnv(),
          canUseTool,
          stderr: (d) => { stderrTail = (stderrTail + d).slice(-2000); },
        },
      });
      engine.bypass = bypass;
      consume();
    },

    send({ text, images }) {
      const content = [
        ...images.map(({ mediaType, data }) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })),
        { type: 'text', text },
      ];
      input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: chat.sessionId ?? '' });
    },

    async interrupt() {
      await q.interrupt();
    },

    // Model and mode switch live. Bypass needs a start-up flag, so entering or leaving it restarts the engine on the
    // next turn instead.
    async configure({ model, mode }) {
      if (model !== undefined) await q.setModel(model === 'default' ? undefined : model);
      if (mode !== undefined) {
        if ((mode === 'bypassPermissions') !== engine.bypass) return 'restart';
        await q.setPermissionMode(mode);
      }
      return 'live';
    },

    async stop() {
      stopping = true;
      input.end();
      q.close();
    },
  };
  return engine;
}
