import fs from 'node:fs';
import { LOCAL_SECRET_PATH } from '../auth.js';
import { terminalQr, qrNote } from '../qr.js';

function notRunning() {
  console.error('Pocket Dev is not running. Start it with npm start (or npm run service:install to keep it running), then run npm run qr again.');
  process.exit(1);
}

let local;
try { local = JSON.parse(fs.readFileSync(LOCAL_SECRET_PATH, 'utf8')); } catch { notRunning(); }

let res;
try {
  res = await fetch(`http://127.0.0.1:${local.port}/api/qr-key`, { method: 'POST', headers: { 'x-pocket-dev': '1', 'x-pocket-dev-secret': local.secret } });
} catch {
  notRunning();
}
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Pocket Dev on port ${local.port} refused the request (${res.status}): ${data.error ?? 'no details'}`);
  process.exit(1);
}
console.log(await terminalQr(data.url));
console.log(data.url);
console.log(qrNote(data.expiresInMin));
