import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createUpdater, notInstalledByNpm, permissionHelp, INSTALL_ARGS, RELEASES_URL, UPDATE_COMMAND } from './update.js';

// The Admin page's Update button. Installing software stays a Mac-side action: this only ever runs behind the admin
// listener (this computer, x-pocket-admin header), never on the port the phone uses. One update runs at a time, and
// the page polls view() for the phase: idle, checking, installing, restarting, done or failed.

const OUTPUT_LINES = 12;
const BUSY = new Set(['checking', 'installing', 'restarting']);

// npm sits next to the node that runs Pocket Dev. The background service has a short PATH, so say where it is.
export function npmCommand({ env = process.env, execPath = process.execPath, platform = process.platform, exists = fs.existsSync } = {}) {
  if (env.POCKET_DEV_NPM) return env.POCKET_DEV_NPM;
  const beside = path.join(path.dirname(execPath), platform === 'win32' ? 'npm.cmd' : 'npm');
  return exists(beside) ? beside : 'npm';
}

// Runs a command, handing each chunk of output to `onChunk`. Resolves { code, stdout, stderr, error } and never rejects.
export function runStreaming(cmd, args, { onChunk = () => {}, env = process.env, execPath = process.execPath, timeoutMs = 10 * 60_000, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    const withNode = { ...env, PATH: [path.dirname(execPath), env.PATH].filter(Boolean).join(path.delimiter) };
    let child;
    try {
      const quote = (a) => (/[\s&|<>()^"%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
      child = platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
        ? spawn([cmd, ...args].map(quote).join(' '), { shell: true, env: withNode, windowsHide: true })
        : spawn(cmd, args, { env: withNode, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) { return resolve({ code: null, stdout: '', stderr: '', error }); }
    let stdout = '', stderr = '', settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ stdout, stderr, error: null, ...r }); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ code: null, error: new Error('npm took too long and was stopped') }); }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout = (stdout + d).slice(-20_000); onChunk(String(d)); });
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-20_000); onChunk(String(d)); });
    child.on('error', (error) => done({ code: null, error }));
    child.on('close', (code) => done({ code }));
  });
}

// Every outside action is a parameter: the npm runner, the service questions and the restart.
export function createUpdateRunner({
  versionCheck, kind = 'global', version, readVersion, run = runStreaming, serviceInfo = async () => ({ installed: false, isThisServer: false }),
  restartThisServer = () => {}, restartDelayMs = 400, now = Date.now, log = () => {},
} = {}) {
  let state = { phase: 'idle', lines: [], error: null, denied: false, from: null, to: null, message: null, startedAt: null };
  const set = (changes) => { state = { ...state, ...changes }; };

  const onChunk = (text) => {
    const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    set({ lines: [...state.lines, ...lines].slice(-OUTPUT_LINES) });
  };
  const updater = createUpdater({
    version, readVersion,
    run: (cmd, args) => run(npmCommand(), args, { onChunk }),
    hasService: async () => (await serviceInfo()).installed,
  });

  function view() {
    const latest = versionCheck.view();
    const available = Boolean(latest?.available);
    const reason = kind === 'global' ? null : notInstalledByNpm(kind);
    const busy = BUSY.has(state.phase);
    return {
      enabled: true,
      current: version, latest: latest?.latest ?? null, available,
      checkedAt: latest?.checkedAt ?? null,
      canUpdate: available && kind === 'global' && !busy,
      reason: available ? reason : null,
      command: UPDATE_COMMAND, releasesUrl: RELEASES_URL,
      phase: state.phase, output: state.lines, error: state.error, denied: state.denied,
      help: state.denied ? permissionHelp() : null, message: state.message, from: state.from, to: state.to,
    };
  }

  // Starts an update and answers at once; the install itself carries on in the background. Returns { status, body }.
  async function start() {
    if (BUSY.has(state.phase)) return { status: 409, body: { ...view(), error: 'An update is already running.' } };
    if (kind !== 'global') return { status: 409, body: { ...view(), error: notInstalledByNpm(kind) } };
    set({ phase: 'checking', lines: [], error: null, denied: false, message: 'Checking for the newest version…', from: version, to: null, startedAt: now() });
    void (async () => {
      try {
        const latest = await versionCheck.refresh({ maxAgeMs: 0 });
        if (!latest?.available) { set({ phase: 'idle', message: 'Pocket Dev is up to date.' }); return; }
        set({ phase: 'installing', message: `Installing ${latest.latest}…` });
        const r = await updater.install();
        if (!r.ok) {
          set({ phase: 'failed', denied: r.denied, error: r.denied ? 'npm could not write to its global folder.' : `The update did not finish: ${r.error}. Pocket Dev was not changed.` });
          return;
        }
        // npm replaced this copy's files in place, so the version on disk is the new one. If it still reads as the old
        // one, say so instead of claiming an install that this copy cannot confirm.
        const changed = Boolean(r.to) && r.to !== version;
        const to = changed ? r.to : version;
        const done = changed ? `Installed ${to}.` : `npm finished, but this copy still reports ${version}.`;
        const svc = await serviceInfo();
        if (svc.installed && svc.isThisServer) {
          set({ phase: 'restarting', to, message: `${done} Restarting Pocket Dev: this page and your phone reconnect in a few seconds.` });
          setTimeout(restartThisServer, restartDelayMs);
        } else if (svc.installed) {
          set({ phase: 'done', to, message: `${done} Restart the background service to use it: pocket-dev service restart` });
        } else {
          set({ phase: 'done', to, message: `${done} Restart Pocket Dev to finish: pocket-dev start` });
        }
      } catch (err) {
        log(`update failed: ${err.message}`);
        set({ phase: 'failed', error: `The update did not finish: ${err.message}. Pocket Dev was not changed.` });
      }
    })();
    return { status: 202, body: view() };
  }

  return { view, start, phase: () => state.phase, INSTALL_ARGS };
}
