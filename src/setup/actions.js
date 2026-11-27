import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TOOLS, detectAll, detectTool, gatherFacts, installPlan, SETUP_DONE, RESTART_NOTE } from './setup.js';

const failure = (status, message) => Object.assign(new Error(message), { status, feature: 'setup', recoverable: true, action: 'retry' });
const clean = (value) => String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '').replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|(?:npm|ghp|gho)_[A-Za-z0-9_]{12,})\b/g, '[redacted]').replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]').replace(/([?&](?:token|key|secret|code)=)[^\s&]+/gi, '$1[redacted]');

// Extends existing setup plans. The browser chooses a tool ID, never a command, path or environment.
export function createSetupActions({ context, config, stateDir, doneFile = SETUP_DONE, changed = () => {} }) {
  const events = new EventEmitter(), streams = new Set(); let job = null, disposed = false, planning = false, controller;
  const previous = config.read().setupProgress?.job;
  if (previous?.state === 'running' || previous?.state === 'checking') config.update({ setupProgress: { ...config.read().setupProgress, job: { ...previous, state: 'interrupted', message: 'Setup was interrupted. Check the tool and retry explicitly.' } } });
  const view = (given) => { if (!given) return null; const { work, ...fields } = given; return fields; };
  const snapshot = () => ({ job: view(job || config.read().setupProgress?.job), step: config.read().setupProgress?.step || 1, complete: fs.existsSync(doneFile) });
  function publish() { events.emit('change', snapshot()); }
  function save() {
    const { output, work, ...summary } = job;
    config.update({ setupProgress: { ...config.read().setupProgress, job: summary } }); publish();
  }
  async function plan() {
    const [facts, states] = await Promise.all([gatherFacts(context), detectAll(context)]);
    return { ...snapshot(), tools: states.map((state) => {
      const tool = TOOLS.find((entry) => entry.id === state.id);
      const install = installPlan(tool.id, { platform: context.platform, ...facts, npmFound: Boolean(facts.npm) });
      return { id: tool.id, title: tool.title, level: tool.level, installed: state.installed, version: state.version, status: state.status, loggedIn: state.loggedIn,
        install: { action: context.platform === 'darwin' ? install.action : 'manual', command: install.display || null, reason: context.platform === 'darwin' ? install.reason : 'Use pocket-dev setup in a terminal on this computer.', steps: install.steps, link: install.link },
        login: tool.login ? [tool.bin, ...tool.login].join(' ') : null };
    }) };
  }
  async function start(body) {
    if (context.platform !== 'darwin') throw failure(409, 'Graphical installation is currently validated on macOS. Use pocket-dev setup in a terminal on this computer.');
    if (!body || Object.keys(body).some((key) => !['tool', 'confirmed', 'requestId'].includes(key)) || body.confirmed !== true || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(body.requestId)) throw failure(400, 'Choose a tool and explicitly confirm its installation.');
    const tool = TOOLS.find((entry) => entry.id === body.tool); if (!tool) throw failure(400, 'Unknown setup tool.');
    const saved = snapshot().job;
    if (saved?.requestId === body.requestId) { if (saved.tool !== tool.id) throw failure(409, 'This action ID belongs to another tool.'); return snapshot(); }
    if (config.read().setupProgress?.acceptedActions?.includes(body.requestId)) throw failure(409, 'This installation action has already been handled. Check setup and choose Retry explicitly if needed.');
    if (disposed || planning || job?.state === 'running' || job?.state === 'checking') throw failure(409, 'A setup action is already running.');
    planning = true;
    let facts, install;
    try {
      facts = await gatherFacts(context);
      install = installPlan(tool.id, { platform: context.platform, ...facts, npmFound: Boolean(facts.npm) });
      if (install.action !== 'run') throw failure(409, install.reason || 'This tool needs manual installation.');
      const detected = await detectTool(tool, context);
      if (detected.installed) throw failure(409, 'This tool is already installed. Use its sign-in instructions or check again.');
      if (disposed) throw failure(503, 'Setup is stopping.');
      const executable = context.find({ id: install.argv[0], bin: install.argv[0] });
      if (!executable) throw failure(409, 'The required package manager is unavailable. Check setup again.');
      const temp = fs.mkdtempSync(path.join(stateDir, 'setup-install-'));
      job = { id: crypto.randomUUID(), requestId: body.requestId, tool: tool.id, title: tool.title, command: install.display, state: 'running', at: Date.now(), output: '', message: 'Installing on this computer…' };
      try {
        config.update({ setupProgress: { ...config.read().setupProgress, acceptedActions: [...(config.read().setupProgress?.acceptedActions || []), body.requestId].slice(-32) } }); save();
      } catch (error) { job = null; fs.rmSync(temp, { recursive: true, force: true }); throw error; }
      const current = job;
      controller = new AbortController();
      // This promise remains inside the current app. Closing a dialog never reruns an install.
      current.work = (async () => {
        try {
          const result = await context.run(executable, install.argv.slice(1), { signal: controller.signal, env: { ...context.childEnv, npm_config_cache: path.join(temp, 'npm-cache') }, cwd: context.env?.HOME || os.homedir(), timeout: 10 * 60000, group: true,
            onOutput(text) { if (disposed || job !== current) return; current.output = clean(current.output + text).slice(-20000); publish(); } });
          if (result.code !== 0) throw new Error(result.timedOut ? 'Installation timed out. Check the local setup output and retry.' : 'Installation failed. Review the setup output, then retry explicitly.');
          current.state = 'checking'; current.message = 'Checking the installed tool…'; publish();
          const verified = await detectTool(tool, context);
          if (!verified.installed || !verified.version || verified.status === 'outdated') throw new Error('The command finished, but the tool could not be verified. Check your PATH and retry the setup check.');
          current.state = 'ready'; current.message = `${tool.title} installed and verified. ${tool.login && !verified.loggedIn ? 'Use its sign-in command on this computer. ' : ''}${RESTART_NOTE}`;
        } catch (error) { current.state = 'failed'; current.message = clean(error.message); }
        finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }); delete current.work; if (!disposed) { save(); changed(tool.id); } }
      })();
      // A promise is process state, never part of a JSON status response.
      return snapshot();
    } finally { planning = false; }
  }
  function progress(step) {
    if (!Number.isInteger(step) || step < 1 || step > 4) throw failure(400, 'Choose a valid setup step.');
    config.update({ setupProgress: { ...config.read().setupProgress, step } }); return snapshot();
  }
  async function complete() {
    if (job?.state === 'running' || job?.state === 'checking') throw failure(409, 'Wait for the active installation before finishing setup.');
    const [node] = await detectAll(context, ['node']); if (node.status !== 'ok') throw failure(409, 'Node.js needs attention before setup can finish.');
    fs.writeFileSync(doneFile, new Date().toISOString() + '\n', { mode: 0o600 }); progress(4); return snapshot();
  }
  function stream(req, res, headers = {}) {
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const send = (value) => { if (res.destroyed) return; if (res.writableLength > 128 * 1024) { res.end(); return; } res.write(`data: ${JSON.stringify(value)}\n\n`); };
    streams.add(res); events.on('change', send); send(snapshot()); res.on('close', () => { events.off('change', send); streams.delete(res); });
  }
  return { plan, start, snapshot, progress, complete, stream, close() { if (disposed) return; disposed = true; controller?.abort(); if (job && ['running', 'checking'].includes(job.state)) { job.state = 'interrupted'; job.message = 'Setup stopped. Check the tool and retry explicitly.'; save(); } for (const response of streams) response.end(); streams.clear(); events.removeAllListeners(); } };
}
