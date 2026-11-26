import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const LIMIT = 256 * 1024;
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const bad = (message) => { throw new Error(message); };
const secret = (file) => /(^|[/\\])(?:\.env(?:\..*)?|\.ssh|\.aws|\.pocket-dev|\.codex|\.claude|\.git|credentials(?:\.json)?)(?:[/\\]|$)/i.test(file);
export const WORKSPACE_TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 file in the workspace. Paths are relative to the project.', properties: { path: { type: 'string' }, offset: { type: 'integer' }, length: { type: 'integer' } }, required: ['path'] },
  { name: 'list_files', description: 'List a directory in the workspace.', properties: { path: { type: 'string' } }, required: ['path'] },
  { name: 'write_file', description: 'Write a UTF-8 file in the workspace after approval.', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  { name: 'create_directory', description: 'Create a directory in the workspace after approval. Create parent directories first.', properties: { path: { type: 'string' } }, required: ['path'] },
  { name: 'ask_user', description: 'Ask the workspace owner a question and wait for their answer.', properties: { question: { type: 'string' }, choices: { type: 'array' } }, required: ['question'] },
  { name: 'run_command', description: 'Run a shell command in the workspace sandbox after approval. Use for searches, Git and tests.', properties: { command: { type: 'string' } }, required: ['command'] },
];

export function commandSandbox(platform = process.platform) {
  if (platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) return 'seatbelt';
  if (platform === 'linux' && spawnSync('bwrap', ['--version'], { timeout: 2000, stdio: 'ignore' }).status === 0) return 'bubblewrap';
  return null;
}

// Workspace tools execute only here, never on the AI source. Every process has a private HOME and a
// mandatory OS sandbox. Unsupported machines fail closed for commands; file tools still work.
export function createWorkspaceTools(chat, { sandbox = commandSandbox(), spawnImpl = spawn } = {}) {
  const root = fs.realpathSync(chat.cwd);
  const abort = new AbortController();
  let active = true;
  const assert = (signal) => { if (signal?.aborted || !active || chat.closed || !chat.turn || chat.turn.interrupted) bad('This workspace session is no longer active.'); };
  const safePath = (given, writing = false) => {
    if (typeof given !== 'string' || given.includes('\0') || given.length > 4096) bad('Invalid workspace path.');
    const lexical = path.resolve(root, given || '.');
    if (!within(root, lexical) || secret(path.relative(root, lexical))) bad('This path is outside the authorized workspace or contains credentials.');
    const real = writing ? path.join(fs.realpathSync(path.dirname(lexical)), path.basename(lexical)) : fs.realpathSync(lexical);
    if (!within(root, real) || secret(path.relative(root, real))) bad('A link points outside the authorized workspace or contains credentials.');
    if (writing && fs.lstatSync(real, { throwIfNoEntry: false })?.isSymbolicLink()) bad('Writing through links is not allowed.');
    return real;
  };
  async function approve(name, args, signal) {
    if (chat.settings.mode === 'plan' || chat.settings.sandbox === 'read-only') bad('This conversation is read only.');
    const key = `remote:${name}:${name !== 'run_command' ? args.path : args.command}`;
    if (chat.grants.includes(key) || chat.settings.mode === 'bypassPermissions' || (chat.settings.approvalPolicy === 'never' && chat.settings.sandbox !== 'read-only') || (chat.settings.mode === 'acceptEdits' && name !== 'run_command')) return;
    if (chat.settings.mode === 'dontAsk' || chat.settings.approvalPolicy === 'never') bad('This operation has not been approved and this conversation is set to never ask.');
    const result = await chat.ask({ type: 'permission-request', kind: name === 'run_command' ? 'command' : 'file',
      title: name === 'write_file' ? `Write ${args.path}` : name === 'create_directory' ? `Create ${args.path}` : args.command,
      detail: name === 'write_file' ? args.content : `Workspace: ${root}`,
      options: [{ id: 'allow', label: 'Allow once' }, { id: 'allow-chat', label: 'Allow in this chat' }, { id: 'deny', label: 'Deny' }],
    }, signal);
    assert(signal);
    if (result.cancelled || !['allow', 'allow-chat'].includes(result.decision)) bad('The workspace owner denied this operation.');
    if (result.decision === 'allow-chat') chat.addGrant(key);
  }
  async function command(command, signal) {
    assert(signal);
    if (!sandbox) bad('Remote commands require an OS sandbox: sandbox-exec on macOS or bubblewrap on Linux. This computer can still use the remote file tools.');
    if (typeof command !== 'string' || !command.trim() || command.length > 16000 || command.includes('\0')) bad('Invalid command.');
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-workspace-')));
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: temp, TMPDIR: temp, LANG: 'en_US.UTF-8', TERM: 'dumb' };
    // No provider credentials, login tokens, or parent process environment are inherited.
    let bin, args;
    if (sandbox === 'seatbelt') {
      const literal = (v) => JSON.stringify(v);
      const system = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/opt/homebrew', '/private/etc', '/private/var/db', '/dev', '/etc'];
      const denied = ['.env', '.ssh', '.aws', '.pocket-dev', '.codex', '.claude'];
      // The dynamic loader must open the filesystem root before starting a signed system shell.
      const profile = `(version 1)(deny default)(allow process*)(allow sysctl-read)(allow mach-lookup)(allow file-read-metadata)(allow file-read* (literal "/") ${system.map((p) => `(subpath ${literal(p)})`).join(' ')} (subpath ${literal(root)}) (subpath ${literal(temp)}))(allow file-write* (subpath ${literal(root)}) (subpath ${literal(temp)}) (literal "/dev/null"))${denied.map((p) => `(deny file-read* file-write* (subpath ${literal(path.join(root, p))}))`).join('')}`;
      bin = '/usr/bin/sandbox-exec'; args = ['-p', profile, '/bin/sh', '-c', command];
    } else {
      bin = 'bwrap';
      args = ['--die-with-parent', '--unshare-all', '--new-session', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
      for (const dir of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/alternatives', '/etc/ld.so.cache']) if (fs.existsSync(dir)) args.push('--ro-bind', dir, dir);
      args.push('--bind', root, root, '--bind', temp, temp, '--chdir', root);
      for (const item of ['.env', '.ssh', '.aws', '.pocket-dev', '.codex', '.claude']) {
        const file = path.join(root, item);
        if (fs.existsSync(file)) args.push(fs.statSync(file).isDirectory() ? '--tmpfs' : '--ro-bind', ...(fs.statSync(file).isDirectory() ? [file] : ['/dev/null', file]));
      }
      args.push('/bin/sh', '-c', command);
    }
    try {
      return await new Promise((resolve, reject) => {
        const child = spawnImpl(bin, args, { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', ended = false;
        const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
        const timer = setTimeout(kill, 60_000);
        const onAbort = () => kill(); signal.addEventListener('abort', onAbort, { once: true });
        const append = (chunk) => { output = (output + chunk.toString()).slice(-LIMIT); };
        child.stdout.on('data', append); child.stderr.on('data', append);
        const finish = (error, code, exitSignal) => { if (ended) return; ended = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); kill(); if (error) reject(error); else resolve(`${output}\n${exitSignal ? `Exit signal: ${exitSignal}` : `Exit code: ${code}`}`); };
        child.on('error', (err) => finish(err)); child.on('close', (code, exitSignal) => finish(null, code, exitSignal));
      });
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  return {
    async execute(name, args, { signal: requestedSignal } = {}) {
      const signal = requestedSignal ? AbortSignal.any([abort.signal, requestedSignal]) : abort.signal;
      assert(signal);
      if (!WORKSPACE_TOOLS.some((t) => t.name === name) || !args || typeof args !== 'object' || Array.isArray(args)) bad('Unknown workspace operation.');
      const id = crypto.randomBytes(8).toString('hex');
      chat.emit({ id, type: 'tool-run', name, summary: args.path || args.command || '', input: JSON.stringify(args).slice(0, LIMIT), output: '', status: 'running' });
      try {
        let result;
        if (name === 'read_file') {
          const file = safePath(args.path);
          const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          try {
            const stat = fs.fstatSync(fd), offset = args.offset ?? 0, length = args.length ?? LIMIT;
            if (!stat.isFile() || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > LIMIT) bad('Choose a file and a byte range of at most 256 KB.');
            const data = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)));
            const read = fs.readSync(fd, data, 0, data.length, offset);
            result = data.subarray(0, read).toString('utf8');
          } finally { fs.closeSync(fd); }
        } else if (name === 'list_files') result = fs.readdirSync(safePath(args.path), { withFileTypes: true }).filter((e) => !secret(e.name)).slice(0, 2000).map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n');
        else if (name === 'write_file') {
          if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > LIMIT) bad('Write at most 256 KB at a time.');
          safePath(args.path, true); await approve(name, args, signal); assert(signal);
          const fd = fs.openSync(safePath(args.path, true), fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
          try { if (fs.fstatSync(fd).nlink > 1) bad('Writing to hard-linked files is not allowed.'); fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, args.content); } finally { fs.closeSync(fd); }
          result = 'File saved.';
        } else if (name === 'create_directory') {
          safePath(args.path, true); await approve(name, args, signal); assert(signal);
          fs.mkdirSync(safePath(args.path, true)); result = 'Directory created.';
        } else if (name === 'ask_user') {
          if (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 2000 || (args.choices !== undefined && (!Array.isArray(args.choices) || args.choices.length > 8 || args.choices.some((v) => typeof v !== 'string' || v.length > 200)))) bad('Invalid question.');
          const response = await chat.ask({ type: 'question', questions: [{ id: 'answer', header: 'Question', question: args.question,
            options: (args.choices || []).map((label) => ({ label, description: '' })), multiSelect: false, allowOther: true }] }, signal);
          assert(signal); if (response.cancelled) bad('The question was cancelled.'); result = (response.answers?.answer || []).join(', ');
        } else {
          if (!sandbox) bad('Running commands with shared AI is not available on this computer. File tools are still available.');
          if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000 || args.command.includes('\0')) bad('Invalid command.');
          await approve(name, args, signal); assert(signal); result = await command(args.command, signal);
        }
        assert(signal); chat.update(id, { status: 'ok', output: result }); return result;
      } catch (err) { chat.update(id, { status: 'error', output: err.message }); throw err; }
    },
    close() { active = false; abort.abort(); },
  };
}
