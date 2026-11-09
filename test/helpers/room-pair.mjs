import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

export const syncEnv = { POCKET_DEV_TASK_SYNC_MS: '300', POCKET_DEV_CHAT_SYNC_MS: '50' };
const names = ['Laptop', 'Desktop', 'Server'];

// Starts `levels.length` servers and puts them in one room. The first is the host (always admin); the others join
// at the level given. Each server gets: api(room), messages(), chats() calls with a logged-in phone cookie.
export async function roomOf(t, levels = ['admin', 'admin'], { env = {} } = {}) {
  const servers = [];
  for (let i = 0; i < levels.length; i++) {
    const s = await startServer(t, { env: { ...syncEnv, ...env } });
    wire(s);
    s.cookie = (await s.login()).cookie;
    s.id = (await s.api('GET', '')).data.deviceId;
    s.name = names[i];
    servers.push(s);
  }
  const [a, ...rest] = servers;
  assert.equal((await a.api('POST', '/create', { name: a.name, addresses: [a.base] })).status, 200);
  for (const [i, s] of rest.entries()) {
    const { data: { code } } = await a.api('POST', '/invite');
    const level = levels[i + 1];
    const body = { code, host: a.base, name: s.name, addresses: [s.base], level, ...(level === 'collaborator' && { folders: [s.home] }) };
    assert.equal((await s.api('POST', '/join', body)).status, 200);
  }
  return servers;
}

export function wire(s) {
  const call = (prefix) => (method, endpoint = '', body) => s.request(method, `${prefix}${endpoint}`, { cookie: s.cookie, body });
  s.api = call('/api/room');
  s.messages = call('/api/messages');
  s.chat = call('/api/chat');
  s.roomChats = call('/api/room/chats');
  return s;
}

// Starts the same server again after it was stopped.
export async function restart(t, s, env = {}) {
  if (s.proc.exitCode === null) {
    s.proc.kill('SIGTERM');
    await new Promise((resolve) => s.proc.once('exit', resolve));
  }
  const next = await startServer(t, { env: { ...syncEnv, ...env }, reuse: { root: s.root, port: s.port, adminPort: s.adminPort } });
  wire(next);
  next.cookie = (await next.login()).cookie;
  next.id = s.id;
  next.name = s.name;
  return next;
}
