import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Proves a request comes from a process run by this Mac user: only they can read the 0600 file.
export const LOCAL_SECRET_PATH = path.join(os.homedir(), '.pocket-dev', 'local-secret');
export const LOCAL_SECRET_HEADER = 'x-pocket-dev-local-secret';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

let secret;

export const readLocalSecret = () => fs.readFileSync(LOCAL_SECRET_PATH, 'utf8').trim();

// Kept until the next reboot, so two servers on different ports share one secret instead of overwriting each other's.
export function ensureLocalSecret() {
  const bootedAt = Date.now() - os.uptime() * 1000;
  const stat = fs.statSync(LOCAL_SECRET_PATH, { throwIfNoEntry: false });
  if (stat && stat.mtimeMs > bootedAt && (stat.mode & 0o077) === 0) {
    secret = readLocalSecret();
    if (secret) return;
  }
  fs.mkdirSync(path.dirname(LOCAL_SECRET_PATH), { recursive: true, mode: 0o700 });
  secret = crypto.randomBytes(32).toString('hex');
  const tmp = `${LOCAL_SECRET_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, secret + '\n', { mode: 0o600 });
  fs.renameSync(tmp, LOCAL_SECRET_PATH);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function isLocalRequest(req) {
  if (!secret || !LOOPBACK.has(req.socket.remoteAddress)) return false;
  return crypto.timingSafeEqual(sha256(req.headers[LOCAL_SECRET_HEADER] ?? ''), sha256(secret));
}
