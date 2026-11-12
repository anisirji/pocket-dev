import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();

function repo(dir, subject) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), `${subject}\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', subject);
}

test('the Git tab opens a repository outside repoRoots by hand, and only that exact repository', { timeout: 120000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-gitopen-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scanned = path.join(root, 'scanned'), work = path.join(root, 'deep', 'er', 'work'), other = path.join(root, 'other'), plain = path.join(root, 'plain');
  for (const dir of [scanned, work, other, plain]) fs.mkdirSync(dir, { recursive: true });
  repo(work, 'work commit');
  repo(other, 'other commit');
  fs.symlinkSync(other, path.join(work, 'escape'));
  process.env.POCKET_DEV_REPO_ROOTS = scanned;
  t.after(() => { delete process.env.POCKET_DEV_REPO_ROOTS; });

  const s = await startServer(t);
  const A = await s.login();
  const open = (folder) => s.request('POST', '/api/git/open', { cookie: A.cookie, body: { path: folder } });
  const graph = (repoPath) => s.request('GET', `/api/git/graph?repo=${encodeURIComponent(repoPath)}`, { cookie: A.cookie });
  const listed = async () => (await s.request('GET', '/api/git/repos', { cookie: A.cookie })).data.map((r) => r.path);
  const saved = () => JSON.parse(fs.readFileSync(path.join(s.root, 'config.json'), 'utf8')).gitRepos;

  assert.equal((await graph(work)).status, 403, 'a repository nobody opened is refused');
  assert.deepEqual(await listed(), []);

  const notRepo = await open(plain);
  assert.equal(notRepo.status, 400);
  assert.match(notRepo.data.error, /Not in a git repository/);
  assert.equal(saved(), undefined, 'a folder outside any repository is not remembered');
  assert.equal((await graph(plain)).status, 403);
  assert.equal((await open('relative/path')).status, 400, 'a relative path is refused');
  assert.equal((await open(path.join(root, 'missing'))).status, 404);

  const opened = await open(path.join(work, 'src'));
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.deepEqual(opened.data, { name: 'work', path: work }, 'a chat or terminal folder inside a repository opens its top level');
  assert.deepEqual(saved(), [work]);
  assert.deepEqual(await listed(), [work]);
  const commits = await graph(work);
  assert.equal(commits.status, 200);
  assert.deepEqual(commits.data.commits.map((c) => c.subject), ['work commit']);

  for (const sneaky of [`${work}/../../../other`, `${work}/src/..`, `${work}/src`, path.join(work, 'escape'), `${work}/`]) {
    assert.equal((await graph(sneaky)).status, 403, `${sneaky} is not the opened path`);
  }

  const viaLink = await open(path.join(work, 'escape'));
  assert.deepEqual(viaLink.data, { name: 'other', path: other }, 'a picked symlink is stored as the folder it points to');
  assert.deepEqual(saved(), [other, work], 'the newest pick comes first');
  assert.equal((await graph(path.join(work, 'escape'))).status, 403, 'the symlink path itself still does not open anything');
  assert.equal((await graph(other)).status, 200);

  assert.equal((await s.request('POST', '/api/git/open', { body: { path: work } })).status, 401, 'opening needs a logged-in device');
});
