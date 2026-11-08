import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-gitb-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'origin.git'), work = path.join(root, 'work'), other = path.join(root, 'other');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'T'); git(work, 'config', 'user.email', 't@t'); git(work, 'checkout', '-q', '-b', 'main');
  write(work, 'a.txt', 'one\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'first'); git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'branch', 'feature');
  // A branch that exists only on the remote.
  git(root, 'clone', '-q', remote, other);
  git(other, 'config', 'user.name', 'O'); git(other, 'config', 'user.email', 'o@o');
  git(other, 'checkout', '-q', '-b', 'remote-only'); write(other, 'r.txt', 'r\n');
  git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'remote work'); git(other, 'push', '-q', 'origin', 'remote-only');
  git(work, 'fetch', '-q');
  return { root, work };
}

test('switch branch and start a new one from a commit: clean tree only, and bad names are refused', { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  process.env.POCKET_DEV_REPO_ROOTS = f.root;
  t.after(() => { delete process.env.POCKET_DEV_REPO_ROOTS; });
  const s = await startServer(t);
  const A = await s.login();
  const call = (route, body, method = 'POST') => s.request(method, `/api/git/${route}?repo=${encodeURIComponent(f.work)}`, { cookie: A.cookie, body });
  const here = () => git(f.work, 'branch', '--show-current');

  assert.equal((await call('switch', { name: 'feature' })).data.branch, 'feature');
  assert.equal(here(), 'feature');

  write(f.work, 'a.txt', 'dirty\n');
  const refused = await call('switch', { name: 'main' });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /uncommitted changes/);
  assert.equal(here(), 'feature', 'a dirty tree is never carried to another branch');
  git(f.work, 'checkout', '--', 'a.txt');

  assert.equal((await call('switch', { name: 'origin/remote-only' })).data.branch, 'remote-only', 'a remote-only branch gets a tracking branch');
  assert.equal(git(f.work, 'rev-parse', '--abbrev-ref', 'remote-only@{upstream}'), 'origin/remote-only');
  git(f.work, 'switch', '-q', 'main');
  assert.equal((await call('switch', { name: 'origin/remote-only' })).data.branch, 'remote-only', 'with the local branch already made, the remote name just switches to it');

  for (const name of ['--detach', '', 'nope', 'refs/heads/../x']) assert.equal((await call('switch', { name })).status, 400, `"${name}" is refused`);
  assert.equal((await call('switch', { name: 5 })).status, 400);

  const first = git(f.work, 'rev-parse', 'main');
  git(f.work, 'switch', '-q', 'main');
  const made = await call('branch', { name: 'from-first', from: first });
  assert.equal(made.data.branch, 'from-first');
  assert.equal(here(), 'from-first');
  assert.equal((await call('branch', { name: 'from-first', from: first })).status, 409, 'a taken name is refused');
  for (const name of ['bad name', 'a..b', '-x', '', 'x.lock']) assert.equal((await call('branch', { name, from: first })).status, 400, `"${name}" is not a branch name`);
  assert.equal((await call('branch', { name: 'ok', from: 'zzzz' })).status, 400);
  assert.equal((await call('branch', { name: 'ok', from: 'deadbeef' })).status, 400, 'an unknown commit is refused');

  // Changes come along only when the new branch starts where HEAD already is.
  write(f.work, 'a.txt', 'work in progress\n');
  const other = git(f.work, 'rev-parse', 'feature');
  const head = git(f.work, 'rev-parse', 'HEAD');
  if (other !== head) assert.equal((await call('branch', { name: 'elsewhere', from: other })).status, 409);
  assert.equal((await call('branch', { name: 'carry', from: head })).status, 200);
  assert.equal(git(f.work, 'status', '--porcelain'), 'M a.txt', 'the work in progress came along');
});

test('stash: create with untracked files, list, apply, pop, drop, and refusals', { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  process.env.POCKET_DEV_REPO_ROOTS = f.root;
  t.after(() => { delete process.env.POCKET_DEV_REPO_ROOTS; });
  const s = await startServer(t);
  const A = await s.login();
  const call = (route, body, method = 'POST') => s.request(method, `/api/git/${route}?repo=${encodeURIComponent(f.work)}`, { cookie: A.cookie, body });
  const list = async () => (await call('stashes', undefined, 'GET')).data;

  assert.deepEqual(await list(), []);
  assert.equal((await call('stash', {})).status, 400, 'nothing to stash');

  write(f.work, 'a.txt', 'changed\n'); write(f.work, 'new.txt', 'new\n');
  assert.equal((await call('stash', { message: 'half done' })).status, 200);
  assert.equal(git(f.work, 'status', '--porcelain'), '', 'a stash leaves a clean tree, untracked files included');
  const [one] = await list();
  assert.equal(one.index, 0);
  assert.equal(one.message, 'half done');
  assert.equal(one.branch, 'main');
  assert.equal(one.base, git(f.work, 'rev-parse', 'HEAD'));

  write(f.work, 'a.txt', 'second\n');
  await call('stash', {});
  const two = await list();
  assert.equal(two.length, 2);
  assert.match(two[0].message, /./, 'a stash without a message still reads');

  assert.equal((await call('stash/apply', { index: 1 })).status, 200);
  assert.equal(fs.readFileSync(path.join(f.work, 'a.txt'), 'utf8'), 'changed\n');
  assert.equal((await list()).length, 2, 'apply keeps the stash');
  git(f.work, 'checkout', '--', 'a.txt'); fs.rmSync(path.join(f.work, 'new.txt'));

  assert.equal((await call('stash/pop', { index: 0 })).status, 200);
  assert.equal((await list()).length, 1, 'pop removes it');
  git(f.work, 'checkout', '--', 'a.txt');

  assert.equal((await call('stash/drop', { index: 0 })).status, 200);
  assert.deepEqual(await list(), []);
  for (const index of [-1, 1.5, '0', 'x', 5000, undefined]) assert.equal((await call('stash/drop', { index })).status, 400, `${index} is refused`);
  assert.equal((await call('stash/pop', { index: 0 })).status, 409, 'popping nothing says so');

  // Changes on top of a stash that touches the same file: refused in one line, nothing is lost.
  write(f.work, 'a.txt', 'mine\n');
  await call('stash', {});
  write(f.work, 'a.txt', 'different\n');
  const overlap = await call('stash/apply', { index: 0 });
  assert.equal(overlap.status, 409);
  assert.match(overlap.data.error, /^Your uncommitted changes overlap with the stash \(a\.txt\)\. Commit or stash them first\.$/);
  assert.equal(fs.readFileSync(path.join(f.work, 'a.txt'), 'utf8'), 'different\n');
  assert.equal((await list()).length, 1);

  // A stash made before the file changed on the branch: a real conflict, named in one line, and the stash is kept.
  git(f.work, 'commit', '-q', '-am', 'meanwhile');
  const conflict = await call('stash/apply', { index: 0 });
  assert.equal(conflict.status, 409);
  assert.match(conflict.data.error, /^The stash conflicts with the current files: a\.txt\. .*the stash is kept\.$/s);
  assert.equal((await list()).length, 1, 'a refused apply keeps the stash');
});
