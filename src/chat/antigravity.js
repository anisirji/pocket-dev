import fs from 'node:fs';
import path from 'node:path';
import { findBin } from './env.js';
import { antigravityQuotaNotice } from './limits.js';
import { createAcpEngine } from './acp-engine.js';

// Google Antigravity CLI. `agy acp` is an Agent Client Protocol server on standard input and output; the sign-in
// and the settings are the ones the terminal `agy` already has. One process serves one chat. The protocol client is
// shared with GitHub Copilot (acp-engine.js).
const AGY_BIN = process.env.POCKET_DEV_AGY || findBin('agy');

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

const adapter = {
  label: 'Antigravity',
  installName: 'Antigravity (agy)',
  prefix: 'agy',
  bin: () => AGY_BIN,
  args: () => ['acp'],
  signInHint: 'Antigravity is not signed in. In a Pocket Dev terminal run: agy acp --login',
  isAuthError: (err) => err.code === -32000 || /auth/i.test(err.message),
  quotaNotice: antigravityQuotaNotice,
  async afterSession({ call, sessionId, chat }) {
    if (chat.settings.model && chat.settings.model !== 'default') await call('session/set_model', { sessionId, modelId: chat.settings.model });
  },
  // A model change applies to the next prompt in the same session.
  async configure(changes, { call, sessionId }) {
    if (!changes.model) return {};
    if (changes.model === 'default') return { model: 'restart' };
    await call('session/set_model', { sessionId, modelId: changes.model });
    return { model: 'next-turn' };
  },
};

export const createAntigravityEngine = (chat) => createAcpEngine(chat, adapter);
