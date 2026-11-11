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
  for (const file of ['paths.js', 'config.js', 'config-keys.js', 'network.js', 'platform.js', 'platform-service.js', 'package.json']) fs.copyFileSync(path.join(REPO, file), path.join(pkg, file));
  fs.mkdirSync(path.join(pkg, 'chat'));
  fs.copyFileSync(path.join(REPO, 'chat', 'env.js'), path.join(pkg, 'chat', 'env.js'));
  for (const file of ['pocket-dev.js', 'cli.js']) fs.copyFileSync(path.join(REPO, 'bin', file), path.join(pkg, 'bin', file));
  const state = path.join(root, 'state');
  const env = { ...process.env, POCKET_DEV_STATE_DIR: state };
  delete env.POCKET_DEV_CONFIG;
  const cli = (...args) => spawnSync(process.execPath, [path.join(pkg, 'bin', 'pocket-dev.js'), ...args], { env, encoding: 'utf8', input: '' });
  return { root, pkg, state, cli, env, configFile: path.join(state, 'config.json') };
}

const TOKEN = 'eyJhIjoiMDEyMzQ1Njc4OSIsInQiOiJmYWtlLXR1bm5lbC10b2tlbiIsInMiOiJzZWNyZXQifQ';

test('internet: saved without a running server, the token from stdin or a file only, never printed', (t) => {
  const { root, cli, env, state, configFile } = fixture(t);
  const network = () => JSON.parse(fs.readFileSync(configFile, 'utf8')).network;
  assert.equal(cli('internet', 'quick').status, 0);
  assert.deepEqual(network(), { wifi: true, internet: { kind: 'quick', hostname: null } });
  const status = cli('internet', 'status');
  assert.match(status.stdout, /Internet access: quick\n/);
  assert.match(status.stdout, /not running/);

  assert.equal(cli('internet', 'domain', '--hostname', 'pocket.example.com').status, 2, 'a domain needs its token');
  assert.equal(cli('internet', 'domain', '--hostname', 'pocket.example.com', '--token', TOKEN).status, 2, 'never as an argument');
  assert.equal(network().internet.kind, 'quick', 'a refused command changes nothing');
  const piped = spawnSync(process.execPath, [path.join(root, 'pkg', 'bin', 'pocket-dev.js'), 'internet', 'domain', '--hostname', 'Pocket.Example.com', '--token-stdin'], { env, encoding: 'utf8', input: `${TOKEN}\n` });
  assert.equal(piped.status, 0, piped.stderr);
  assert.deepEqual(network(), { wifi: true, internet: { kind: 'domain', hostname: 'pocket.example.com' } });
  const tokenFile = path.join(state, 'tunnel-token');
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), `${TOKEN}\n`);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(piped.stdout.includes(TOKEN), false);
  assert.match(piped.stdout, /Tunnel token: saved/);
  assert.equal(cli('internet', 'status').stdout.includes(TOKEN), false);

  const other = path.join(root, 'other-token');
  fs.writeFileSync(other, `${TOKEN}xyz\n`);
  assert.equal(cli('internet', 'domain', '--token-file', other).status, 0, 'the saved hostname is kept');
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), `${TOKEN}xyz\n`);
  assert.equal(cli('internet', 'domain', '--hostname', 'nodots', '--token-file', other).status, 2);
  assert.equal(cli('internet', 'off').status, 0);
  assert.equal(network().internet.kind, 'off');
  assert.ok(fs.existsSync(tokenFile), 'turning off keeps the token for next time');
  assert.equal(cli('internet', 'auto').status, 2);
});

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
  for (const key of ['port', 'adminPort', 'awake', 'requireApproval', 'maxDevices', 'approveFromDevices', 'chatIdleMinutes', 'allowedHosts', 'internet']) assert.match(help.stdout, new RegExp(`\\b${key}\\b`));
});

test('service logs with no log says so and exits non-zero; an unknown action prints usage', (t) => {
  const { cli, env, root } = fixture(t);
  env.LOG = path.join(root, 'missing.log');
  const logs = cli('service', 'logs');
  assert.equal(logs.status, 1);
  assert.match(logs.stderr, /There is no log yet at .*missing\.log/);
  const bad = cli('service', 'bogus');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: pocket-dev service/);
});

test('an unknown command points at --help', (t) => {
  const { cli } = fixture(t);
  assert.match(cli('nope').stderr, /See 'pocket-dev --help'/);
});

test('package.json has a unique second command name for the same program', () => {
  const { bin } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(bin['pocketdev-app'], bin['pocket-dev']);
});
