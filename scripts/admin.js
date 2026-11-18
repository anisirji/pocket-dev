import fs from 'node:fs';
import { ADMIN_URL_PATH } from '../src/auth/admin.js';
import { platform as host } from '../src/core/platform.js';
import { cachedUpdateLine } from '../src/setup/update.js';
import { openConfig } from '../src/core/config.js';
import { resolveConfigPath } from '../src/core/paths.js';

// npm run admin: open the admin page. npm run connect / disconnect: open or close phone access.
const NOT_RUNNING = 'Pocket Dev is not running. Start it with: pocket-dev start (or pocket-dev service install), then try again.';
const command = process.argv[2] ?? 'open';

let url;
try { ({ url } = JSON.parse(fs.readFileSync(ADMIN_URL_PATH, 'utf8'))); } catch { fail(NOT_RUNNING); }

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function admin(method, path, body) {
  let res;
  try {
    res = await fetch(url + path, {
      method,
      headers: body ? { 'content-type': 'application/json', 'x-pocket-admin': '1' } : {},
      body: body && JSON.stringify(body),
    });
  } catch {
    fail(NOT_RUNNING);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error ?? `The admin page answered ${res.status}.`);
  return data;
}

if (command === 'open') {
  await admin('GET', '/api/state');
  console.log(host.openUrl(url) ? `Opened ${url}` : `Could not open a browser from here. Open this address yourself: ${url}`);
  // The last look-up's answer, read from disk: this command never waits for the network.
  const newer = (() => { try { return cachedUpdateLine({ config: openConfig(resolveConfigPath()) }); } catch { return null; } })();
  if (newer) console.log(newer);
} else if (command === 'connect' || command === 'disconnect') {
  const state = await admin('PUT', '/api/access', { connected: command === 'connect', by: 'cli' });
  console.log(state.connected ? `Phone access is on (port ${state.port}).` : 'Phone access is off. Terminals keep running on the Mac.');
} else {
  fail('usage: node scripts/admin.js [open|connect|disconnect]');
}
