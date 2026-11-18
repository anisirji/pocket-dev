import fs from 'node:fs';
import path from 'node:path';
import { findBin } from './env.js';
import { copilotLimitNotice } from './limits.js';
import { createAcpEngine } from './acp-engine.js';

// GitHub Copilot CLI (`copilot`, npm package @github/copilot). `copilot --acp --stdio` is an Agent Client Protocol server
// on standard input and output (public preview at GitHub). The sign-in is the one `copilot login` already made, in the
// system credential store; Pocket Dev never reads or keeps a token. One process serves one chat, and the protocol client
// is shared with Antigravity (acp-engine.js).
const COPILOT_BIN = process.env.POCKET_DEV_COPILOT || findBin('copilot');

const MODE_URL = 'https://agentclientprotocol.com/protocol/session-modes#';
const MODES = [
  { value: 'agent', label: 'Agent', description: 'Copilot answers and works on the task' },
  { value: 'plan', label: 'Plan', description: 'Copilot plans the steps before doing them' },
];
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh'].map((value) => ({ value, label: value === 'default' ? 'Default' : value[0].toUpperCase() + value.slice(1), description: '' }));

// Copilot lists no models over the protocol, so this holds Auto and anything the person types; `/model` in a terminal
// shows what the account can use.
const MODELS = [{ value: 'default', label: 'Auto', description: 'Copilot picks the model' }];

export const settingsSchema = async () => [
  { key: 'model', label: 'Model', default: 'default', custom: true, choices: MODELS },
  { key: 'mode', label: 'Mode', default: 'agent', choices: MODES },
  { key: 'effort', label: 'Effort', default: 'default', choices: EFFORTS },
];

export const isInstalled = () => Boolean(COPILOT_BIN) && (!path.isAbsolute(COPILOT_BIN) || fs.existsSync(COPILOT_BIN));
export const grantLabel = (grant) => grant.replace(/^tool:/, 'Tool: ');

// A permission request carries the change as a unified diff in the tool input; keep only the changed lines.
function unifiedToDiff(text, file) {
  const changed = String(text).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  return changed.length ? `@@ ${file ?? ''}\n${changed.join('\n')}` : null;
}

const shape = {
  commandOf: (tc) => tc.rawInput?.command ?? tc.rawInput?.commands?.join?.(' && ') ?? tc.rawInput?.cmd,
  pathOf: (tc) => tc.locations?.[0]?.path ?? tc.rawInput?.path ?? tc.rawInput?.fileName,
  inputDiff(tc) {
    const input = tc.rawInput ?? {};
    const file = shape.pathOf(tc);
    if (typeof input.diff === 'string') return unifiedToDiff(input.diff, file);
    if (tc.kind === 'edit' && typeof input.file_text === 'string') return `@@ ${file ?? ''}\n${input.file_text.split('\n').filter(Boolean).map((l) => `+${l}`).join('\n')}`;
    return null;
  },
  // Copilot titles a request by what it does ("Create file"), so one approval for this chat covers that kind of change.
  titleOf: (tc) => tc.title,
};

const adapter = {
  label: 'Copilot',
  installName: 'GitHub Copilot (copilot)',
  prefix: 'copilot',
  shape,
  authOnPrompt: true,
  bin: () => COPILOT_BIN,
  args: (chat) => ['--acp', '--stdio', '--no-auto-update', ...(chat.settings.effort && chat.settings.effort !== 'default' ? ['--reasoning-effort', chat.settings.effort] : [])],
  env: () => ({ NO_COLOR: '1' }),
  signInHint: 'GitHub Copilot is not signed in. In a Pocket Dev terminal run: copilot login',
  isAuthError: (err) => err.code === -32000 || /authenticat|log ?in|sign ?in|credential|unauthori[sz]ed|\b401\b|no token/i.test(err.message),
  quotaNotice: (answer) => copilotLimitNotice(answer),
  errorNotice: (err) => copilotLimitNotice(err.message),
  async afterSession({ call, sessionId, chat }) {
    if (chat.settings.model && chat.settings.model !== 'default') await call('session/set_model', { sessionId, modelId: chat.settings.model });
    if (chat.settings.mode && chat.settings.mode !== 'agent') await call('session/set_mode', { sessionId, modeId: `${MODE_URL}${chat.settings.mode}` });
  },
  // Model and mode apply to the next prompt in the same session. Effort is a command-line argument, so it needs a restart.
  async configure(changes, { call, sessionId }) {
    const how = {};
    if (changes.model) {
      await call('session/set_model', { sessionId, modelId: changes.model === 'default' ? 'auto' : changes.model });
      how.model = 'next-turn';
    }
    if (changes.mode) {
      await call('session/set_mode', { sessionId, modeId: `${MODE_URL}${changes.mode}` });
      how.mode = 'next-turn';
    }
    if ('effort' in changes) how.effort = 'restart';
    return how;
  },
};

export const createCopilotEngine = (chat) => createAcpEngine(chat, adapter);
