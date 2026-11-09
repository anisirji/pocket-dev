import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'prepublish']) {
    assert.equal(pkg.scripts[hook], undefined, `${hook} runs during npm install and can fail it (a Git install runs it in a folder that may be gone)`);
  }
  assert.equal(fs.existsSync(path.join(REPO, 'scripts', 'postinstall.js')), false);
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/node-pty'].optional, true);
  assert.ok(lock.packages[''].optionalDependencies['node-pty']);
  assert.equal(lock.packages[''].hasInstallScript, undefined);
});

test('the package ships the files the installed app needs', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO, encoding: 'utf8' });
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  for (const needed of ['bin/pocket-dev.js', 'bin/cli.js', 'doctor.js', 'pty-loader.js', 'public/terminals-off.js', 'docs/SETUP.md']) assert.ok(files.includes(needed), needed);
});
