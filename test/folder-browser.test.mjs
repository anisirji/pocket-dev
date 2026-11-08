import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFolderBrowser } from '../folder-browser.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-folders-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  for (const name of ['Desktop', 'Documents', 'Downloads', 'project 2', 'project 10', '.hidden', '<img onerror=bad>']) fs.mkdirSync(path.join(home, name), { recursive: true });
  fs.writeFileSync(path.join(home, 'notes.txt'), 'file');
  fs.symlinkSync(path.join(home, 'project 2'), path.join(home, 'project link'));
  fs.symlinkSync(path.join(root, 'missing'), path.join(home, 'broken'));
  const browse = createFolderBrowser({ home, config: { read: () => ({ folders: [path.join(home, 'project 2')] }) } });
  const get = (params = {}) => browse(new URL(`http://fixture/api/folders/browse?${new URLSearchParams(params)}`));
  return { root, home, get };
}

test('folder navigation lists directories and directory links, with natural sorting and useful locations', async (t) => {
  const { home, get } = fixture(t);
  const result = await get();
  assert.equal(result.path, fs.realpathSync(home));
  assert.ok(result.entries.some((e) => e.name === 'project link'));
  assert.ok(!result.entries.some((e) => ['notes.txt', 'broken', '.hidden'].includes(e.name)));
  const projects = result.entries.filter((e) => /^project \d/.test(e.name));
  assert.deepEqual(projects.map((e) => e.name), ['project 2', 'project 10']);
  assert.ok(result.shortcuts.some((e) => e.name === 'Home' && e.path === result.path));
  assert.ok(result.shortcuts.some((e) => e.name === 'Desktop'));
  assert.equal(result.breadcrumbs.at(-1).path, result.path);
  const child = await get({ path: path.join(home, 'project 2') });
  assert.equal(child.parent, result.path);
  assert.deepEqual(child.entries, []);
});

test('hidden folders, search, tilde paths and filenames containing markup stay usable as data', async (t) => {
  const { home, get } = fixture(t);
  assert.ok((await get({ hidden: '1' })).entries.some((e) => e.name === '.hidden'));
  assert.deepEqual((await get({ q: 'PROJECT 10' })).entries.map((e) => e.name), ['project 10']);
  assert.equal((await get({ path: '~/Desktop' })).path, fs.realpathSync(path.join(home, 'Desktop')));
  assert.ok((await get()).entries.some((e) => e.name === '<img onerror=bad>'));
});

test('a typed file, deleted directory and invalid path produce actionable errors', async (t) => {
  const { home, get } = fixture(t);
  await assert.rejects(get({ path: path.join(home, 'notes.txt') }), (err) => err.status === 400 && /file/.test(err.message));
  await assert.rejects(get({ path: path.join(home, 'gone') }), (err) => err.status === 404);
  await assert.rejects(get({ path: '\0' }), (err) => err.status === 400);
});

test('search can find a folder beyond the bounded first page', async (t) => {
  const { home, get } = fixture(t);
  for (let n = 0; n < 2005; n++) fs.mkdirSync(path.join(home, `many-${n}`));
  const result = await get();
  assert.equal(result.entries.length, 2000);
  assert.equal(result.truncated, true);
  assert.deepEqual((await get({ q: 'many-2004' })).entries.map((e) => e.name), ['many-2004']);
});

test('the production phone dispatcher refuses guests and unauthenticated callers before browsing', async () => {
  const vm = await import('node:vm');
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function handleApi('), source.indexOf('const handleGit ='));
  let allowed = false, guest = false, scans = 0;
  const runtime = {
    MUTATING: new Set(['POST', 'PUT', 'PATCH', 'DELETE']), CSRF_HEADER: 'x-pocket-dev',
    collaborators: { guest: () => guest ? { active: true } : null },
    auth: { handleApi: async () => null, deviceFor: () => allowed ? { id: 'owner' } : null },
    readJson: async () => ({}),
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    browseFolders: async () => { scans++; return { path: '/owner' }; },
  };
  vm.runInNewContext(`${handler}\nthis.handle = handleApi;`, runtime);
  const call = () => runtime.handle({ method: 'GET', headers: {} }, {}, new URL('http://fixture/api/folders/browse'));
  assert.equal((await call()).status, 401);
  allowed = true;
  assert.equal((await call()).status, 200);
  guest = true;
  assert.equal((await call()).status, 403);
  assert.equal(scans, 1, 'only the owner request reaches filesystem navigation');
});

test('folders sort by name, date modified or date created, ascending or descending', async (t) => {
  const { home, get } = fixture(t);
  const dir = path.join(home, 'sorted');
  for (const name of ['b', 'a', 'c']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.utimesSync(path.join(dir, 'a'), 3, 3);
  fs.utimesSync(path.join(dir, 'b'), 1, 1);
  fs.utimesSync(path.join(dir, 'c'), 2, 2);
  const names = async (params) => (await get({ path: dir, ...params })).entries.map((e) => e.name);
  assert.deepEqual(await names(), ['a', 'b', 'c']);
  assert.deepEqual(await names({ order: 'desc' }), ['c', 'b', 'a']);
  assert.deepEqual(await names({ sort: 'modified' }), ['b', 'c', 'a']);
  assert.deepEqual(await names({ sort: 'modified', order: 'desc' }), ['a', 'c', 'b']);
  assert.equal((await names({ sort: 'created' })).length, 3);
  assert.deepEqual(await names({ sort: 'bogus' }), ['a', 'b', 'c']);
  assert.deepEqual(Object.keys((await get({ path: dir, sort: 'modified' })).entries[0]), ['name', 'path']);
});
