import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The CLI runs from a copy of its own files, so the migration test moves a fixture config.json and never the real one.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'pkg');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  for (const file of ['paths.js', 'config.js', 'config-keys.js', 'package.json']) fs.copyFileSync(path.join(REPO, file), path.join(pkg, file));
  fs.copyFileSync(path.join(REPO, 'bin', 'pocket-dev.js'), path.join(pkg, 'bin', 'pocket-dev.js'));
  const state = path.join(root, 'state');
  const env = { ...process.env, POCKET_DEV_STATE_DIR: state };
  delete env.POCKET_DEV_CONFIG;
  const cli = (...args) => spawnSync(process.execPath, [path.join(pkg, 'bin', 'pocket-dev.js'), ...args], { env, encoding: 'utf8' });
  return { pkg, state, cli, configFile: path.join(state, 'config.json') };
}

test('config set validates, saves privately, and unset restores the default', (t) => {
  const { cli, configFile } = fixture(t);
  assert.equal(cli('config', 'set', 'maxDevices', '5').status, 0);
  assert.equal(cli('config', 'get', 'maxDevices').stdout.trim(), '5');
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).maxDevices, 5);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

  assert.equal(cli('config', 'set', 'allowedHosts', 'a.example.com, b.example.com').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).allowedHosts, ['a.example.com', 'b.example.com']);

  assert.equal(cli('config', 'unset', 'maxDevices').status, 0);
  assert.equal(cli('config', 'get', 'maxDevices').stdout.trim(), '(not set)');
});

test('config set refuses bad values and keys the app owns, without writing', (t) => {
  const { cli, configFile } = fixture(t);
  cli('config', 'set', 'maxDevices', '5');
  const before = fs.readFileSync(configFile, 'utf8');
  for (const args of [['port', '80'], ['port', 'abc'], ['awake', 'sometimes'], ['maxDevices', '99'], ['requireApproval', 'yes'], ['passwordHash', 'x'], ['bogus', '1']]) {
    const result = cli('config', 'set', ...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.ok(result.stderr.trim(), `${args.join(' ')} explains itself`);
  }
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
});

test('config list hides the password hash; config get refuses it', (t) => {
  const { cli, configFile } = fixture(t);
  cli('config', 'path');
  fs.writeFileSync(configFile, JSON.stringify({ passwordHash: 'scrypt$secret-salt$secret-hash', port: 7777 }));
  const listed = cli('config', 'list').stdout;
  assert.doesNotMatch(listed, /secret/);
  assert.match(listed, /"passwordHash": "<set>"/);
  assert.notEqual(cli('config', 'get', 'passwordHash').status, 0);
});

test('a config.json left in the package folder moves to the state folder once', (t) => {
  const { pkg, cli, configFile } = fixture(t);
  fs.writeFileSync(path.join(pkg, 'config.json'), JSON.stringify({ port: 9191, maxDevices: 3 }));

  assert.equal(cli('config', 'get', 'port').stdout.trim().split('\n').pop(), '9191');
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(pkg, 'config.json')), 'old file is moved aside');
  assert.ok(fs.existsSync(path.join(pkg, 'config.json.migrated')), 'old file is kept as a backup');

  cli('config', 'set', 'maxDevices', '7');
  fs.writeFileSync(path.join(pkg, 'config.json'), JSON.stringify({ port: 1111 }));
  assert.equal(cli('config', 'get', 'port').stdout.trim(), '9191', 'an existing state config is never overwritten');
});

test('unknown commands fail with usage; help lists every settable key', (t) => {
  const { cli } = fixture(t);
  assert.equal(cli('nope').status, 2);
  const help = cli('help');
  assert.equal(help.status, 0);
  for (const key of ['port', 'adminPort', 'awake', 'requireApproval', 'maxDevices', 'chatIdleMinutes', 'allowedHosts']) assert.match(help.stdout, new RegExp(`\\b${key}\\b`));
});
