import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

test('Node older than 22: a short clear message and exit 1, before anything else loads', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'pocket-dev.js'), 'version'], { encoding: 'utf8', env: { ...process.env, POCKET_DEV_FAKE_NODE: '18.19.1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Pocket Dev needs Node 22 or newer, and this computer has Node 18\.19\.1\./);
  assert.match(r.stderr, /nodejs\.org\/en\/download/);
  assert.equal(r.stdout, '');
});

test('the bin file starts with the node shebang, has no BOM or CRLF, and its first statements are plain old syntax', () => {
  const text = fs.readFileSync(path.join(REPO, 'bin', 'pocket-dev.js'), 'utf8');
  assert.ok(text.startsWith('#!/usr/bin/env node\n'));
  assert.ok(!text.includes('\r'));
  const head = text.split('import(')[0];
  assert.doesNotMatch(head, /^\s*import\s/m, 'a static import would load before the version check');
  assert.doesNotMatch(head, /=>|\blet\b|\bconst\b|\basync\b/, 'the check uses only syntax old Node can parse');
  assert.equal(pkg.bin['pocket-dev'], 'bin/pocket-dev.js');
});

test('node-pty is optional, so a failed build or download cannot fail an install', () => {
  assert.equal(pkg.dependencies['node-pty'], undefined);
  assert.ok(pkg.optionalDependencies['node-pty']);
  assert.equal(pkg.scripts.preinstall, undefined);
  assert.equal(pkg.scripts.install, undefined);
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/node-pty'].optional, true);
  assert.ok(lock.packages[''].optionalDependencies['node-pty']);
});

test('the package ships the files the installed app needs', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO, encoding: 'utf8' });
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  for (const needed of ['bin/pocket-dev.js', 'bin/cli.js', 'doctor.js', 'pty-loader.js', 'public/terminals-off.js', 'scripts/postinstall.js', 'docs/SETUP.md']) assert.ok(files.includes(needed), needed);
});

// ---- postinstall never fails ----------------------------------------------------------------------------------------

function tree(t, withPty) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd post install-'));
  t.after(() => { try { fs.chmodSync(root, 0o700); for (const d of fs.readdirSync(root)) try { fs.chmodSync(path.join(root, d), 0o700); } catch {} } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'postinstall.js'), path.join(root, 'scripts', 'postinstall.js'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', version: '1.0.0' }));
  if (withPty) {
    const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`);
    fs.mkdirSync(prebuilds, { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'node-pty', 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.0.0', main: 'x.js' }));
    fs.writeFileSync(path.join(prebuilds, 'spawn-helper'), '#!/bin/sh\n', { mode: 0o644 });
  }
  return root;
}
const post = (root) => spawnSync(process.execPath, [path.join(root, 'scripts', 'postinstall.js')], { encoding: 'utf8' });

test('postinstall with no node-pty: exits 0 and says how to add it later', (t) => {
  const r = post(tree(t, false));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /pocket-dev doctor --fix/);
  assert.equal(r.stderr, '');
});

test('postinstall in a folder with a space in its path makes the helper executable and exits 0', (t) => {
  const root = tree(t, true);
  const r = post(root);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  if (process.platform !== 'win32') {
    const helper = path.join(root, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    assert.equal(fs.statSync(helper).mode & 0o111, 0o111);
  }
});

test('postinstall with unreadable folders still exits 0', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const root = tree(t, true);
  const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds'), modules = path.join(root, 'node_modules');
  try {
    fs.chmodSync(prebuilds, 0o000);
    assert.equal(post(root).status, 0);
    fs.chmodSync(modules, 0o000);
    const r = post(root);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  } finally {
    fs.chmodSync(modules, 0o700);
    fs.chmodSync(prebuilds, 0o700);
  }
});

test('postinstall with a broken node-pty package.json still exits 0', (t) => {
  const root = tree(t, true);
  fs.writeFileSync(path.join(root, 'node_modules', 'node-pty', 'package.json'), '{ not json');
  assert.equal(post(root).status, 0);
});
