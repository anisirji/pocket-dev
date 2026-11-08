import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createCollaborators } from '../collaborators.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-collaborators-'));
  const repo = path.join(root, 'project'), stateDir = path.join(root, 'state');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'Project');
  const settings = { roleAccessEnabled: true, fileRoots: [root] };
  let clock = Date.now(), owners = 1, maxDevices = 5;
  const events = [];
  const auth = {
    lookup: (req) => req.owner,
    activeCount: () => owners,
    admin: { log: (type, fields) => events.push({ type, fields }), state: () => ({ maxDevices }), enableRoles: () => ({ status: 200 }) },
  };
  const config = { read: () => settings };
  const args = { config, auth, urls: () => ({ lan: 'http://fixture:7777' }), stateDir, now: () => clock };
  const manager = createCollaborators(args);
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const body = { label: 'Sam', role: 'viewer', repository: repo, duration: 3600, extraFolders: [], ai: false };
  const create = async (fields = {}) => (await manager.ownerApi('POST', '/api/collaborators', { ...body, ...fields })).body;
  const invite = async (grant) => {
    const { body } = await manager.ownerApi('POST', `/api/collaborators/${grant.id}/invite`);
    return new URLSearchParams(new URL(body.url).hash.slice(1)).get('token');
  };
  const accept = (token) => {
    const result = manager.accept({ headers: {}, socket: {} }, { token });
    return { headers: { cookie: result.headers['set-cookie'].split(';')[0] } };
  };
  return { root, repo, manager, body, args, events, settings, create, invite, accept,
    advance: (ms) => { clock += ms; }, capacity: (count, max = 5) => { owners = count; maxDevices = max; } };
}

test('invite expiry, capacity and existing-session conflicts never consume a usable invitation or evict Admins', async (t) => {
  const f = fixture(t), grant = await f.create();
  const token = await f.invite(grant);
  assert.throws(() => f.manager.accept({ headers: {}, owner: {} }, { token }), (e) => e.status === 409);
  f.capacity(5);
  assert.throws(() => f.accept(token), (e) => e.status === 409);
  f.capacity(1);
  const guest = f.accept(token);
  assert.equal(f.manager.currentAccess(guest).role, 'viewer');
  assert.throws(() => f.accept(token), (e) => e.status === 410);
  const next = await f.invite(await f.create({ label: 'Later' }));
  f.advance(600001);
  assert.throws(() => f.accept(next), (e) => e.status === 410);
  assert.equal(f.manager.sessionCount(), 1);
});

test('expiry and revoked grants fail closed, including after role edits and a restart', async (t) => {
  const f = fixture(t), grant = await f.create();
  const guest = f.accept(await f.invite(grant));
  const restarted = createCollaborators(f.args);
  t.after(() => restarted.close());
  assert.equal(restarted.currentAccess(guest).role, 'viewer', 'redeemed access survives server restart');
  f.advance(3600001);
  assert.throws(() => f.manager.currentAccess(guest), (e) => e.status === 403);
  assert.equal(f.manager.sessionCount(), 0);
  await f.manager.ownerApi('PATCH', `/api/collaborators/${grant.id}`, f.body);
  assert.throws(() => f.manager.currentAccess(guest), (e) => e.status === 403, 'expired cookies cannot acquire renewed access');
  const replacement = f.accept(await f.invite(grant));
  await f.manager.ownerApi('DELETE', `/api/collaborators/${grant.id}`);
  assert.throws(() => f.manager.currentAccess(replacement), (e) => e.status === 403);
});

test('access changes stop existing transfers, invalidate invitations and invalidate old request scopes', async (t) => {
  const f = fixture(t), grant = await f.create();
  const guest = f.accept(await f.invite(grant));
  const response = new EventEmitter(); response.destroy = () => { response.destroyed = true; response.emit('close'); };
  const scope = f.manager.scope(guest, response);
  const unused = await f.invite(grant);
  assert.equal(response.destroyed, undefined, 'issuing an invitation must not interrupt existing work');
  await f.manager.ownerApi('PATCH', `/api/collaborators/${grant.id}`, { ...f.body, label: 'Updated' });
  assert.equal(response.destroyed, true);
  assert.throws(scope.assertActive, (e) => e.status === 403);
  assert.throws(() => f.accept(unused), (e) => e.status === 410);
  assert.equal(f.manager.currentAccess(guest).label, 'Updated');
});

test('missing, retargeted and removed owner roots deny guest access without falling back to home', async (t) => {
  const f = fixture(t), grant = await f.create();
  const guest = f.accept(await f.invite(grant));
  const moved = path.join(f.root, 'moved');
  fs.renameSync(f.repo, moved);
  assert.throws(() => f.manager.currentAccess(guest));
  fs.symlinkSync(moved, f.repo);
  assert.throws(() => f.manager.currentAccess(guest), (e) => e.status === 403);
  fs.unlinkSync(f.repo); fs.renameSync(moved, f.repo);
  f.settings.fileRoots = [path.join(f.root, 'not-found')];
  assert.throws(() => f.manager.currentAccess(guest), (e) => e.status === 403);
});

test('Developer copies exclude links and common credentials, enforce write modes and do not expose host execution', async (t) => {
  const f = fixture(t);
  const extra = path.join(f.root, 'assets'); fs.mkdirSync(extra); fs.writeFileSync(path.join(extra, 'asset.txt'), 'asset');
  for (const name of ['.env', '.ENV.production', '.npmrc', 'private.key', 'credentials.json']) fs.writeFileSync(path.join(f.repo, name), 'private');
  fs.symlinkSync(extra, path.join(f.repo, 'linked-assets'));
  const grant = await f.create({ role: 'developer', extraFolders: [{ path: extra, mode: 'read' }] });
  assert.equal(fs.readFileSync(path.join(grant.workspace, 'project', 'README.md'), 'utf8'), 'Project');
  assert.deepEqual(fs.readdirSync(path.join(grant.workspace, 'project')), ['README.md']);
  assert.equal(grant.roots[0].readOnly, false);
  assert.equal(grant.roots[1].readOnly, true);
  assert.equal(grant.ai, false);
  const guest = f.accept(await f.invite(grant));
  const scope = f.manager.scope(guest, new EventEmitter());
  assert.equal(scope.blocked(path.join(grant.workspace, 'project', 'README.md')), false);
  assert.equal(scope.blocked(path.join(grant.workspace, 'project', '.ENV')), true);
  await assert.rejects(f.create({ role: 'developer', ai: true }), (e) => e.status === 409);
  await assert.rejects(f.create({ extraFolders: [{ path: extra, mode: 'write' }] }), (e) => e.status === 400);
  await assert.rejects(f.create({ extraFolders: [{ path: f.repo, mode: 'read' }] }), (e) => e.status === 400);
});

test('unused invitations disappear on restart and neither raw session tokens nor invite tokens are persisted', async (t) => {
  const f = fixture(t), grant = await f.create();
  const token = await f.invite(grant), guest = f.accept(token);
  const unused = await f.invite(grant);
  const restarted = createCollaborators(f.args);
  t.after(() => restarted.close());
  assert.throws(() => restarted.accept({ headers: {} }, { token: unused }), (e) => e.status === 410);
  const stored = fs.readFileSync(path.join(f.args.stateDir, 'collaborators.json'), 'utf8');
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(guest.headers.cookie.split('=')[1]), false);
  assert.equal((fs.statSync(path.join(f.args.stateDir, 'collaborators.json')).mode & 0o777), 0o600);
  assert.equal(JSON.stringify(f.events).includes(token), false);
});

test('revocation or lockdown wins over an earlier access update still preparing a project copy', async (t) => {
  for (const action of ['revoke', 'lockdown']) {
    const f = fixture(t), grant = await f.create();
    const guest = f.accept(await f.invite(grant));
    const preparing = f.manager.ownerApi('PATCH', `/api/collaborators/${grant.id}`, { ...f.body, role: 'developer' });
    if (action === 'lockdown') f.manager.lockdown();
    else await f.manager.ownerApi('DELETE', `/api/collaborators/${grant.id}`);
    await assert.rejects(preparing, (err) => err.status === 409);
    const summary = await f.manager.ownerApi('GET', '/api/collaborators');
    assert.equal(summary.body.collaborators[0].status, 'revoked');
    assert.throws(() => f.manager.currentAccess(guest), (err) => err.status === 403);
  }
});
