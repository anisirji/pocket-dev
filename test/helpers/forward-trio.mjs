import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, until } from './server.mjs';

export const env = { POCKET_DEV_ROOM_PING_MS: '250' };

export async function device(t, extra = {}) {
  const s = await startServer(t, { env: { ...env, ...extra } });
  s.cookie = (await s.login()).cookie;
  s.api = (method, endpoint, body) => s.request(method, `/api/room${endpoint}`, { cookie: s.cookie, body });
  s.id = (await s.api('GET', '')).data.deviceId;
  // Through this device's front door: /m/<target><endpoint>, logged in as this device's phone.
  s.to = (target, method, endpoint, body, extra = {}) => s.request(method, `/m/${target.id}${endpoint}`, { cookie: s.cookie, body, ...extra });
  return s;
}
// A Git project (what a collaborator may be given) and a loose file inside the device's own HOME.
export function project(s) {
  const repo = path.join(s.home, 'Desktop', 'proj');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(s.home, 'Desktop', 'other'), { recursive: true });
  fs.writeFileSync(path.join(s.home, 'Desktop', 'other', 'secret.txt'), 'private');
  return repo;
}
export const setConfig = (s, patch) => fs.writeFileSync(s.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(s.config, 'utf8')), ...patch }));
export const listing = (s, target, dir) => s.to(target, 'GET', `/api/files/list?path=${encodeURIComponent(dir)}`);

// H hosts. A joins giving full admin on A. B joins giving only the project folder (collaborator) and turns on role access.
export async function trio(t, { env: extra } = {}) {
  const h = await device(t, extra), a = await device(t, extra), b = await device(t, extra);
  const repo = project(b);
  await h.api('POST', '/create', { name: 'Host', addresses: [h.base] });
  const join = async (s, name, access) => {
    const { data: { code } } = await h.api('POST', '/invite');
    const r = await s.api('POST', '/join', { code, host: h.base, name, addresses: [s.base], ...access });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  await join(a, 'Alpha', { level: 'admin' });
  await join(b, 'Beta', { level: 'collaborator', folders: [repo], grantRole: 'viewer' });
  setConfig(b, { roleAccessEnabled: true }); // grants become active; B's own phone login is not needed again
  await until(async () => (await a.api('GET', '')).data.room.members.length === 3);
  // B made a grant for each other member; A learns the full list from H.
  await until(async () => (await h.to(b, 'GET', '/api/files/places')).status === 200, 8000);
  return { h, a, b, repo };
}
