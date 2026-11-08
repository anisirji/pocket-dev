import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeLimitNotice } from './limits.js';
import { findBin, engineEnv, ENGINE_SETTINGS, cap, lineDiff, INPUT_MAX } from './env.js';
import { saveToolImages, resultText } from './tool-images.js';

const CLAUDE_BIN = process.env.POCKET_DEV_CLAUDE || findBin('claude') || '/usr/local/bin/claude';

// The permission modes `claude --help` lists for --permission-mode in 2.1.139.
const MODES = [
  { value: 'default', label: 'Ask every time', description: 'Asks before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Edits files without asking, asks before commands' },
  { value: 'plan', label: 'Plan', description: 'Reads and plans, changes nothing until you approve the plan' },
  { value: 'auto', label: 'Auto', description: 'Claude decides, asks only for risky actions' },
  { value: 'dontAsk', label: "Don't ask", description: 'Never asks: anything not already allowed is denied' },
  {
    value: 'bypassPermissions', label: 'Bypass', description: 'Runs everything without asking',
    confirm: 'Claude will edit files and run any command without asking. Continue?',
  },
];

const EFFORTS = [
  { value: 'default', label: 'Default', description: "The model's own default" },
  { value: 'low', label: 'Low', description: 'Minimal thinking, fastest' },
  { value: 'medium', label: 'Medium', description: 'Moderate thinking' },
  { value: 'high', label: 'High', description: 'Deep reasoning' },
  { value: 'xhigh', label: 'Extra high', description: 'Deeper than high (Opus 4.7)' },
  { value: 'max', label: 'Max', description: 'Maximum effort' },
];

// "default" means the model Claude Code itself picks (settings, then its built-in default); every other value is
// passed as --model.
const FALLBACK_MODELS = [
  { value: 'default', label: 'Default', description: 'Claude Code default' },
  { value: 'opus', label: 'Opus', description: '' },
  { value: 'sonnet', label: 'Sonnet', description: '' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest' },
];

let modelsCache = null;
let modelsCacheBin = null;

// Asking the CLI costs one short-lived process (about 2 s) and no model call, so ask once per CLI build. Claude Code
// updates itself in place, so the binary's mtime changes when its model catalog can.
export async function listModels() {
  let bin = null;
  try { bin = fs.statSync(CLAUDE_BIN).mtimeMs; } catch {}
  if (bin !== modelsCacheBin) {
    modelsCache = null;
    modelsCacheBin = bin;
  }
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

export async function settingsSchema() {
  return [
    { key: 'model', label: 'Model', default: 'default', custom: true, choices: await listModels() },
    { key: 'mode', label: 'Mode', default: 'default', choices: MODES },
    { key: 'effort', label: 'Effort', default: 'default', choices: EFFORTS },
  ];
}

// Project rules live where Claude Code's own "don't ask again" puts them.
const RULE_FILES = ['.claude/settings.local.json', '.claude/settings.json'];

function readRuleFile(cwd, file) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'));
    return { data, rules: Array.isArray(data?.permissions?.allow) ? data.permissions.allow.filter((r) => typeof r === 'string') : [] };
  } catch {
    return { data: null, rules: [] };
  }
}

export function projectRules(cwd) {
  return RULE_FILES.map((file) => ({ file, path: path.join(cwd, file), rules: readRuleFile(cwd, file).rules })).filter((f) => f.rules.length);
}

export function removeProjectRule(cwd, file, rule) {
  if (!RULE_FILES.includes(file)) throw new Error(`file must be one of: ${RULE_FILES.join(', ')}`);
  const full = path.join(cwd, file);
  // A symlinked .claude folder could point the rewrite outside the chat's folder.
  if (!fs.realpathSync(full).startsWith(fs.realpathSync(cwd) + path.sep)) throw new Error(`${file} is outside ${cwd}`);
  const { data, rules } = readRuleFile(cwd, file);
  if (!rules.includes(rule)) throw new Error(`${file} has no allow rule ${rule}`);
  data.permissions.allow = data.permissions.allow.filter((r) => r !== rule);
  const tmp = `${full}.pocket-dev.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: fs.statSync(full).mode & 0o777 });
  fs.renameSync(tmp, full);
}

const ruleString = (r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);

// "Always allow" offers what Claude Code's own prompt offers. Usually that is a rule such as Bash(npm test:*), kept for
// this chat or written to the project. For file edits the CLI suggests only switching this session to acceptEdits (a
// bare Edit rule does not cover Write), so those cards have no project option and the chat switches mode.
function remembering(toolName, suggestions) {
  const rules = suggestions.filter((u) => u.type === 'addRules' && u.behavior === 'allow').flatMap((u) => u.rules);
  const modeSwitch = suggestions.find((u) => u.type === 'setMode');
  if (!rules.length && modeSwitch) return { mode: modeSwitch.mode };
  return { rules: rules.length ? rules : [{ toolName }] };
}

const rememberUpdates = ({ rules, mode }, suggestions, destination) => [
  rules ? { type: 'addRules', rules, behavior: 'allow', destination } : { type: 'setMode', mode, destination },
  ...suggestions.filter((u) => u.type === 'addDirectories').map((u) => ({ ...u, destination })),
];

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

const describeInput = (name, input) => (name === 'Bash' ? input.command : DIFF[name] ? input.file_path ?? input.notebook_path : cap(input, INPUT_MAX));

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
  let streamModel = null;
  const blockIds = new Map();

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

  // Paths inside the chat folder read better on a phone relative to it.
  const inFolder = (text) => text.split(`${chat.cwd}/`).join('');

  async function canUseTool(toolName, toolInput, { signal, suggestions = [], toolUseID, title, description }) {
    if (toolName === 'AskUserQuestion') return askQuestion(toolInput, signal);
    const plan = toolName === 'ExitPlanMode';
    const remember = remembering(toolName, suggestions);
    const options = plan
      ? [{ id: 'allow', label: 'Start working' }, { id: 'deny', label: 'Keep planning' }]
      : [
        { id: 'allow', label: 'Allow once' },
        { id: 'allow-chat', label: remember.mode ? 'Allow all edits in this chat' : 'Always allow in this chat' },
        ...(remember.rules ? [{ id: 'allow-project', label: 'Always allow in this project' }] : []),
        { id: 'deny', label: 'Deny' },
      ];
    const res = await chat.ask({
      type: 'permission-request',
      kind: plan ? 'plan' : toolName === 'Bash' ? 'command' : DIFF[toolName] ? 'file' : 'tool',
      title: plan ? 'Claude is ready to start' : inFolder(title || `${toolName} ${summarize(toolName, toolInput)}`),
      detail: plan ? toolInput.plan ?? '' : [DIFF[toolName] ? '' : description, describeInput(toolName, toolInput)].filter(Boolean).join('\n\n'),
      diff: DIFF[toolName] && cap(DIFF[toolName](toolInput)),
      rule: plan ? undefined : remember.rules?.map(ruleString).join(', ') ?? `${remember.mode} mode`,
      options,
    }, signal);
    if (res.cancelled) return { behavior: 'deny', message: 'The request was cancelled.', interrupt: true };
    if (res.decision === 'deny') {
      denied.add(toolUseID);
      return { behavior: 'deny', message: res.message || 'The user denied this.' };
    }
    if (plan) {
      const next = suggestions.find((u) => u.type === 'setMode')?.mode;
      if (MODES.some((m) => m.value === next)) chat.settings = { ...chat.settings, mode: next };
      chat.changed();
      return { behavior: 'allow', updatedInput: toolInput, updatedPermissions: suggestions };
    }
    if (res.decision === 'allow-chat' || res.decision === 'allow-project') {
      const updates = rememberUpdates(remember, suggestions, res.decision === 'allow-chat' ? 'session' : 'localSettings');
      if (remember.mode) chat.settings = { ...chat.settings, mode: remember.mode };
      else if (res.decision === 'allow-chat') for (const r of remember.rules) chat.addGrant(ruleString(r));
      chat.changed();
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
    if (ev.type !== 'tool-run') return chat.update(ev.id, { status });
    const images = saveToolImages(chat.imageDir, block.content, block.tool_use_id);
    chat.update(ev.id, { status, output: cap(resultText(block.content, images)), ...(images.size && { images: [...images.values()] }) });
  }

  function onStreamEvent({ event }) {
    if (event.type === 'message_start') {
      streamMsg = event.message.id;
      streamModel = event.message.model;
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
      chat.emit({ id, type: kind === 'text' ? 'assistant-text' : 'thinking', text: '', streaming: true, model: streamModel });
    } else if (event.type === 'content_block_delta') {
      const id = blockIds.get(event.index);
      if (event.delta.type === 'text_delta') chat.delta(id, 'text', event.delta.text);
      else if (event.delta.type === 'thinking_delta') chat.delta(id, 'text', event.delta.thinking);
    }
  }

  function settleBlock({ id: msgId, model }, kind, text) {
    const list = streamed.get(msgId) ?? [];
    const i = list.findIndex((b) => b.kind === kind);
    if (i === -1) {
      chat.emit({ type: kind === 'text' ? 'assistant-text' : 'thinking', text, streaming: false, model });
      return;
    }
    const [{ id }] = list.splice(i, 1);
    chat.update(id, { text, streaming: false, model });
  }

  function onMessage(m) {
    if (m.parent_tool_use_id) return;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') chat.setSession(m.session_id);
        else if (m.subtype === 'compact_boundary') chat.emit({ type: 'status', text: 'Conversation compacted' });
        return;
      case 'rate_limit_event': {
        const notice = claudeLimitNotice(m.rate_limit_info, (chat.limitSeen ??= new Map()));
        if (notice) chat.emit(notice);
        return;
      }
      case 'stream_event':
        return onStreamEvent(m);
      case 'assistant':
        if (m.error) chat.emit({ type: 'error', message: `Claude error: ${m.error}` });
        for (const block of m.message.content) {
          if (block.type === 'text') settleBlock(m.message, 'text', block.text);
          else if (block.type === 'thinking') settleBlock(m.message, 'thinking', block.thinking);
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
      const { model, mode, effort } = chat.settings;
      const bypass = mode === 'bypassPermissions';
      q = query({
        prompt: input,
        options: {
          cwd: chat.cwd,
          model: model === 'default' ? undefined : model,
          effort: effort === 'default' ? undefined : effort,
          permissionMode: mode,
          allowDangerouslySkipPermissions: bypass,
          resume: chat.sessionId ?? undefined,
          allowedTools: chat.grants,
          includePartialMessages: true,
          pathToClaudeCodeExecutable: CLAUDE_BIN,
          env: engineEnv(),
          settings: ENGINE_SETTINGS,
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

    // Model and mode switch on the live process. Effort and entering or leaving bypass are start-up flags, so those
    // restart the engine (resuming the session) before the next turn.
    async configure(changes) {
      const applied = {};
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'model') {
          await q.setModel(value === 'default' ? undefined : value);
          applied.model = 'now';
        } else if (key === 'mode' && (value === 'bypassPermissions') === engine.bypass) {
          await q.setPermissionMode(value);
          applied.mode = 'now';
        } else {
          applied[key] = 'restart';
        }
      }
      return applied;
    },

    async stop() {
      stopping = true;
      input.end();
      q.close();
    },
  };
  return engine;
}
