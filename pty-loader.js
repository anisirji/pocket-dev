// node-pty is an optional dependency: it holds a compiled part, and a failed download, build or unpack must not stop
// Pocket Dev from starting. Everything that needs a pty asks here. This module never throws.
// POCKET_DEV_FORCE_NO_PTY=1 makes it report "not available" without touching node-pty (for tests).

export const REPAIR_COMMAND = 'pocket-dev doctor --fix';
const DOCS = 'docs/SETUP.md (Troubleshooting)';

// What went wrong in plain words, from the error node-pty or Node gave.
export function describeFailure(err) {
  const code = err?.code;
  const text = String(err?.message ?? err ?? '');
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find (module|package) 'node-pty'/.test(text)) {
    return 'the terminal component (node-pty) is not installed';
  }
  if (/Cannot find module .*(pty|conpty)\.node|prebuilds|build[\\/]Release/.test(text)) {
    return 'the terminal component (node-pty) was installed without its compiled part';
  }
  if (/NODE_MODULE_VERSION|was compiled against a different Node|dlopen|not a valid Win32|Module did not self-register/.test(text)) {
    return 'the terminal component (node-pty) does not match this version of Node';
  }
  return `the terminal component (node-pty) could not load (${text.split('\n')[0].slice(0, 160) || 'unknown error'})`;
}

export function unavailable(reason) {
  return { available: false, pty: null, reason, hint: `On this computer, run:  ${REPAIR_COMMAND}   then restart Pocket Dev. More help: ${DOCS}.`, command: REPAIR_COMMAND };
}

// `importer` and `env` are injected by tests. Resolves { available, pty, reason, hint, command }.
export async function loadPty({ importer = () => import('node-pty'), env = process.env } = {}) {
  if (env.POCKET_DEV_FORCE_NO_PTY === '1') return unavailable('terminals were switched off for this run (POCKET_DEV_FORCE_NO_PTY)');
  try {
    const mod = await importer();
    const pty = mod?.default ?? mod;
    if (typeof pty?.spawn !== 'function') return unavailable('the terminal component (node-pty) loaded but is incomplete');
    return { available: true, pty, reason: null, hint: null, command: null };
  } catch (err) {
    return unavailable(describeFailure(err));
  }
}

let shared = null;
// One load per process. The server and the terminal host share the answer.
export const getPty = (options) => (shared ??= loadPty(options));
export const resetPtyForTests = () => { shared = null; };

// The one sentence every terminal error uses.
export const terminalsError = (status) => `Terminals are not available on this computer: ${status.reason}. ${status.hint}`;
