import fs from 'node:fs';
import { localRequest } from './local-api.js';
import { ADMIN_URL_PATH } from '../admin.js';
import { terminalQr, qrNote } from '../qr.js';

// The phone port is closed while phone access is disconnected; the admin listener says whether the server is up.
async function disconnected() {
  try {
    const { url } = JSON.parse(fs.readFileSync(ADMIN_URL_PATH, 'utf8'));
    const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.json()).access?.connected === false;
  } catch {
    return false;
  }
}

const res = await localRequest('POST', '/api/qr-key');
if (!res) {
  console.error(await disconnected()
    ? 'Pocket Dev is running but phone access is disconnected, so no phone can reach it. Press Connect on the admin page (npm run admin) or run npm run connect, then run npm run qr again.'
    : 'Pocket Dev is not running. Start it with npm start (or npm run service:install to keep it running), then run npm run qr again.');
  process.exit(1);
}
if (!res.ok) {
  console.error(`Pocket Dev on port ${res.port} refused the request (${res.status}): ${res.data.error ?? 'no details'}`);
  process.exit(1);
}
// --link https://name.trycloudflare.com logs the phone in on that address instead of the Wi-Fi one.
const linkAt = process.argv.indexOf('--link');
const url = linkAt === -1 ? res.data.url : `${new URL(process.argv[linkAt + 1]).origin}/?k=${new URL(res.data.url).searchParams.get('k')}`;
console.log(await terminalQr(url));
console.log(url);
console.log(qrNote(res.data.expiresInMin));
