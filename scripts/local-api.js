import fs from 'node:fs';
import { LOCAL_SECRET_PATH, LOCAL_SECRET_HEADER } from '../auth.js';

// Calls the Pocket Dev server running on this Mac. Each start writes its port and a fresh secret to a 0600 file, so
// only this Mac user's scripts can make these requests. Resolves to null when no server answers.
export async function localRequest(method, pathname, body) {
  let local;
  try { local = JSON.parse(fs.readFileSync(LOCAL_SECRET_PATH, 'utf8')); } catch { return null; }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${local.port}${pathname}`, {
      method,
      headers: { 'x-pocket-dev': '1', [LOCAL_SECRET_HEADER]: local.secret, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
  } catch {
    return null;
  }
  return { port: local.port, status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
}
