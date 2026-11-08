import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-gitc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'origin.git'), work = path.join(root, 'work'), other = path.join(root, 'other');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, work);
  for (const dir of [work]) { git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'checkout', '-q', '-b', 'main'); }
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'first'); git(work, 'push', '-q', '-u', 'origin', 'main');
  return { root, remote, work, other };
}

test('commit & push from the Git tab: stages everything, never forces, and tells the truth about a refused push', { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  process.env.POCKET_DEV_REPO_ROOTS = f.root;
  t.after(() => { delete process.env.POCKET_DEV_REPO_ROOTS; });
  const s = await startServer(t);
  const A = await s.login();
  const call = (route, body, method = 'POST') => s.request(method, `/api/git/${route}?repo=${encodeURIComponent(f.work)}`, { cookie: A.cookie, body });
  const remoteSubject = () => git(f.remote, 'log', '-1', '--format=%s', 'main');

  assert.equal((await call('commit', { message: 'x', push: true })).status, 400, 'a clean tree has nothing to commit');
  assert.match((await call('commit', { message: 'x', push: true })).data.error, /Nothing to commit/);

  fs.writeFileSync(path.join(f.work, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(f.work, 'new.txt'), 'new\n');
  const noMessage = await call('commit', { message: '   ', push: true });
  assert.equal(noMessage.status, 400);
  assert.equal(git(f.work, 'log', '--format=%s').split('\n').length, 1, 'an empty message commits nothing');

  const both = await call('commit', { message: 'Change a and add new', push: true });
  assert.equal(both.status, 200, JSON.stringify(both.data));
  assert.equal(both.data.committed, true);
  assert.equal(both.data.pushed, true);
  assert.equal(both.data.branch, 'main');
  assert.equal(remoteSubject(), 'Change a and add new', 'the remote has the commit');
  assert.equal(git(f.work, 'status', '--porcelain'), '', 'the untracked file went in too');
  assert.doesNotMatch(git(f.work, 'log', '-1', '--format=%B'), /co-authored-by/i, 'no trailer is added');

  fs.writeFileSync(path.join(f.work, 'a.txt'), 'three\n');
  const only = await call('commit', { message: 'Local only', push: false });
  assert.deepEqual([only.data.committed, only.data.pushed], [true, false]);
  assert.equal(remoteSubject(), 'Change a and add new');
  assert.equal((await call('push', {})).data.pushed, true);
  assert.equal(remoteSubject(), 'Local only');
  assert.match((await call('push', {})).data.error, /Nothing to push/);

  // The remote moves on: the push is refused, the commit stays, and nothing is forced.
  git(f.root, 'clone', '-q', f.remote, f.other);
  git(f.other, 'config', 'user.name', 'O'); git(f.other, 'config', 'user.email', 'o@o');
  fs.writeFileSync(path.join(f.other, 'other.txt'), 'x\n');
  git(f.other, 'add', '.'); git(f.other, 'commit', '-q', '-m', 'someone else'); git(f.other, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(f.work, 'a.txt'), 'four\n');
  const refused = await call('commit', { message: 'Mine', push: true });
  assert.equal(refused.status, 200);
  assert.equal(refused.data.committed, true);
  assert.equal(refused.data.pushed, false);
  assert.ok(refused.data.pushError, 'git’s refusal is passed on');
  assert.equal(remoteSubject(), 'someone else', 'the remote was not overwritten');
  assert.equal(git(f.work, 'log', '-1', '--format=%s'), 'Mine', 'the local commit is kept');

  // A branch the remote has never seen is pushed with an upstream.
  git(f.work, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
  git(f.work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(f.work, 'feature.txt'), 'f\n');
  const fresh = await call('commit', { message: 'Feature work', push: true });
  assert.equal(fresh.data.pushed, true, JSON.stringify(fresh.data));
  assert.equal(git(f.work, 'rev-parse', '--abbrev-ref', 'feature@{upstream}'), 'origin/feature');
  assert.equal(git(f.remote, 'log', '-1', '--format=%s', 'feature'), 'Feature work');
});
