import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Chat } from '../src/chat/chat.js';
import { createWorkspaceTools } from '../src/chat/workspace-tools.js';

test('the native macOS workspace sandbox executes commands, isolates reads and cancels descendants', { skip: process.platform !== 'darwin' }, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-native-command-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const outside = path.join(temp, 'private.txt'); fs.writeFileSync(outside, 'OUTSIDE_PRIVATE_SENTINEL');
  const chat = Chat.create({ tool: 'claude', cwd: root, settings: { mode: 'bypassPermissions' } }, temp);
  chat.startTurn(); const tools = createWorkspaceTools(chat);
  t.after(() => { tools.close(); chat.closed = true; clearTimeout(chat.persistTimer); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const output = await tools.execute('run_command', { command: 'printf WORKSPACE_COMMAND_OK > result.txt; cat result.txt' });
  assert.match(output, /WORKSPACE_COMMAND_OK/); assert.match(output, /Exit code: 0/);
  const denied = await tools.execute('run_command', { command: `cat '${outside}'` });
  assert.doesNotMatch(denied, /OUTSIDE_PRIVATE_SENTINEL/); assert.match(denied, /Exit code: 1/);
  const pending = tools.execute('run_command', { command: 'sleep 1; printf BAD > late.txt' });
  setTimeout(() => tools.close(), 100);
  await assert.rejects(pending, /no longer active/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(fs.existsSync(path.join(root, 'late.txt')), false);
});
