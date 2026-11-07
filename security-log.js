import fs from 'node:fs';

// Every event type and the filter it falls under. Appending an unknown type throws, so a typo fails loudly.
export const EVENT_KINDS = {
  'login': 'access',
  'login-pending': 'access',
  'login-failed': 'failure',
  'login-locked': 'failure',
  'qr-expired': 'failure',
  'device-revoked': 'change',
  'device-blocked': 'change',
  'device-unblocked': 'change',
  'device-approved': 'change',
  'device-denied': 'change',
  'device-removed': 'change',
  'device-renamed': 'change',
  'pending-expired': 'change',
  'password-changed': 'change',
  'limit-changed': 'change',
  'approval-changed': 'change',
  'lockdown': 'change',
  'access-connected': 'change',
  'access-disconnected': 'change',
  'keep-open-changed': 'change',
  'autostart-changed': 'change',
  'service-installed': 'change',
  'server-stopped': 'change',
};

const FILTERS = {
  all: () => true,
  failures: (e) => EVENT_KINDS[e.type] === 'failure',
  changes: (e) => EVENT_KINDS[e.type] === 'change',
};
export const isLogFilter = (f) => Object.hasOwn(FILTERS, f);

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Append-only JSONL. Past maxBytes the file moves to <file>.1, replacing the older copy.
export function createSecurityLog(file, maxBytes) {
  const old = `${file}.1`;
  let size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;

  function append(type, fields = {}) {
    if (!Object.hasOwn(EVENT_KINDS, type)) throw new Error(`Unknown security event: ${type}`);
    const line = JSON.stringify({ at: Date.now(), type, ...fields }) + '\n';
    if (size > 0 && size + line.length > maxBytes) {
      fs.renameSync(file, old);
      size = 0;
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
    if (size === 0) fs.chmodSync(file, 0o600);
    size += Buffer.byteLength(line);
  }

  // Newest first.
  function recent({ filter = 'all', limit = 200, since = 0 } = {}) {
    const keep = FILTERS[filter];
    const out = [];
    for (const line of [...readLines(old), ...readLines(file)].reverse()) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.at < since) break;
      if (keep(entry)) out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  }

  return { append, recent };
}
