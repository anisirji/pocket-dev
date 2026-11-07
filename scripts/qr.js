import { localRequest } from './local-api.js';
import { terminalQr, qrNote } from '../qr.js';

const res = await localRequest('POST', '/api/qr-key');
if (!res) {
  console.error('Pocket Dev is not running. Start it with npm start (or npm run service:install to keep it running), then run npm run qr again.');
  process.exit(1);
}
if (!res.ok) {
  console.error(`Pocket Dev on port ${res.port} refused the request (${res.status}): ${res.data.error ?? 'no details'}`);
  process.exit(1);
}
console.log(await terminalQr(res.data.url));
console.log(res.data.url);
console.log(qrNote(res.data.expiresInMin));
