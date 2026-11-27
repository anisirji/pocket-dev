import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { PACKAGE_ROOT } from '../core/paths.js';
import { findBin } from '../chat/env.js';
import { screenSupport } from './screen.js';

const execute = promisify(execFile);
const SCRIPT = path.join(PACKAGE_ROOT, 'src', 'machine', 'mac-input.py');
const KEYS = new Set([...`ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`, 'Enter', 'Tab', 'Space', 'Backspace', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp']);
const MODIFIERS = new Set(['shift', 'control', 'alt', 'command']);
export function parseScreenInput(event) {
  const invalid = () => { throw new Error('Unsupported screen input.'); };
  if (!event || typeof event !== 'object' || Array.isArray(event)) return invalid();
  const only = (keys) => { if (Object.keys(event).some((key) => !keys.includes(key))) invalid(); };
  const point = () => { for (const key of ['x', 'y']) if (!Number.isFinite(event[key]) || event[key] < 0 || event[key] > 1) invalid(); return { x: event.x, y: event.y }; };
  if (event.kind === 'move') { only(['kind', 'x', 'y']); return { kind: 'move', ...point() }; }
  if (event.kind === 'click') {
    only(['kind', 'x', 'y', 'button', 'count']); if (!['left', 'right'].includes(event.button) || ![1, 2].includes(event.count ?? 1)) return invalid();
    return { kind: 'click', ...point(), button: event.button, count: event.count ?? 1 };
  }
  if (event.kind === 'scroll') {
    only(['kind', 'x', 'y', 'dx', 'dy']); for (const key of ['dx', 'dy']) if (!Number.isFinite(event[key]) || Math.abs(event[key]) > 600) return invalid();
    return { kind: 'scroll', ...point(), dx: Math.round(event.dx), dy: Math.round(event.dy) };
  }
  if (event.kind === 'text') {
    only(['kind', 'text']); if (typeof event.text !== 'string' || !event.text.length || event.text.length > 200 || /[\u0000-\u001f\u007f]/.test(event.text)) return invalid();
    return { kind: 'text', text: event.text };
  }
  if (event.kind === 'key') {
    only(['kind', 'key', 'modifiers']); if (!KEYS.has(event.key) || (event.modifiers != null && (!Array.isArray(event.modifiers) || event.modifiers.length > 4 || event.modifiers.some((key) => !MODIFIERS.has(key))))) return invalid();
    return { kind: 'key', key: event.key, modifiers: [...new Set(event.modifiers || [])] };
  }
  return invalid();
}

export function inputPython({ find = findBin, exists = fs.existsSync, env = process.env } = {}) {
  const file = env.POCKET_DEV_INPUT_PYTHON || find('python3');
  // /usr/bin/python3 can be an installer shim. Never trigger an installer from a capability check.
  if (file === '/usr/bin/python3') return ['/Library/Developer/CommandLineTools/usr/bin/python3', '/Applications/Xcode.app/Contents/Developer/usr/bin/python3'].find(exists) || null;
  return file && path.isAbsolute(file) && exists(file) ? file : null;
}
export function createScreenInputAdapter({ system = process.platform, python = inputPython(), run = execute, launch = spawn } = {}) {
  async function support() {
    if (system !== 'darwin') return { state: 'unsupported', available: false, message: 'Desktop input is currently available on macOS. Screen viewing remains available where supported.' };
    if (!python) return { state: 'setup-required', available: false, message: 'Install Python 3 on this Mac to enable the optional desktop input adapter.' };
    try {
      const { stdout } = await run(python, [SCRIPT, '--check'], { timeout: 5000, maxBuffer: 16000 });
      const state = JSON.parse(stdout), displays = (await screenSupport()).displays;
      return { ...state, available: state.state === 'ready', displays };
    } catch { return { state: 'failed', available: false, message: 'Mac input could not be checked. Review Accessibility and Screen Recording permissions on the Mac.' }; }
  }
  function start(displayId, onFault = () => {}) {
    const child = launch(python, [SCRIPT, String(displayId)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let sequence = 0, closed = false, initialized = false, resolveReady, rejectReady;
    const calls = new Map(), ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const initialTimer = setTimeout(() => fail(new Error('Mac input did not become ready.')), 5000);
    function close() {
      if (closed) return; closed = true; clearTimeout(initialTimer);
      if (!initialized) rejectReady(new Error('Desktop control ended before initialization.'));
      for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error('Desktop control ended.')); } calls.clear();
      child.kill('SIGTERM'); child.stdin.end();
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 300); kill.unref();
    }
    function fail(error) { if (closed) return; rejectReady(error); close(); onFault(error); }
    child.once('error', () => fail(new Error('The Mac input adapter could not start.')));
    child.once('exit', () => { if (!closed) fail(new Error('Mac input stopped. Request control again after checking the computer.')); });
    child.stdin.on('error', () => fail(new Error('The Mac input connection closed.')));
    // Never echo native diagnostics: input text must not enter local logs or browser error messages.
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (closed) return;
      let result; try { if (line.length > 16000) throw new Error(); result = JSON.parse(line); } catch { return fail(new Error('The Mac input adapter returned an invalid response.')); }
      if (result.state !== 'ready') return fail(new Error(result.message || 'macOS stopped desktop input.'));
      if (!initialized) { initialized = true; clearTimeout(initialTimer); resolveReady(); return; }
      const call = calls.get(result.id); if (!call) return;
      calls.delete(result.id); clearTimeout(call.timer); call.resolve();
    });
    function send(type, event) {
      if (closed || !initialized || calls.size >= 4) return Promise.reject(new Error('Desktop control is not ready for more input.'));
      const id = ++sequence;
      let parsed; try { if (event) parsed = parseScreenInput(event); } catch (error) { return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error('Delayed desktop input was discarded.')), 1200);
        calls.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, type, ...(parsed && { event: parsed, at: Date.now() }) }) + '\n');
      });
    }
    return { ready, input: (event) => send('input', event), check: () => send('check'), close };
  }
  return { support, start };
}
