import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPty, terminalsError, REPAIR_COMMAND } from '../pty-loader.js';

test('node-pty loads when it is there', async () => {
  const fake = { spawn() {} };
  const status = await loadPty({ importer: async () => ({ default: fake }), env: {} });
  assert.equal(status.available, true);
  assert.equal(status.pty, fake);
  assert.equal(status.reason, null);
});

test('a missing module is reported in plain words with the repair command, and never throws', async () => {
  const status = await loadPty({ importer: async () => { throw Object.assign(new Error("Cannot find package 'node-pty' imported from /x/terminals.js"), { code: 'ERR_MODULE_NOT_FOUND' }); }, env: {} });
  assert.equal(status.available, false);
  assert.match(status.reason, /not installed/);
  assert.equal(status.command, REPAIR_COMMAND);
  assert.match(status.hint, /pocket-dev doctor --fix/);
  assert.match(terminalsError(status), /^Terminals are not available on this computer: the terminal component \(node-pty\) is not installed\. .*pocket-dev doctor --fix/);
});

test('a load error from the compiled part is reported, whatever it says', async () => {
  const wrongNode = await loadPty({ importer: async () => { throw new Error('The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115'); }, env: {} });
  assert.match(wrongNode.reason, /does not match this version of Node/);
  const noBinary = await loadPty({ importer: async () => { throw new Error('Cannot find module \'../build/Release/pty.node\''); }, env: {} });
  assert.match(noBinary.reason, /without its compiled part/);
  const odd = await loadPty({ importer: async () => { throw 'boom'; }, env: {} });
  assert.equal(odd.available, false);
  assert.match(odd.reason, /could not load \(boom\)/);
});

test('a module without spawn counts as broken', async () => {
  const status = await loadPty({ importer: async () => ({}), env: {} });
  assert.equal(status.available, false);
  assert.match(status.reason, /incomplete/);
});

test('POCKET_DEV_FORCE_NO_PTY switches terminals off without importing node-pty', async () => {
  let imported = false;
  const status = await loadPty({ importer: async () => { imported = true; return { spawn() {} }; }, env: { POCKET_DEV_FORCE_NO_PTY: '1' } });
  assert.equal(status.available, false);
  assert.equal(imported, false);
  assert.match(status.reason, /switched off/);
});

test('the real node-pty loads here', async () => {
  const status = await loadPty({ env: {} });
  assert.equal(status.available, true, status.reason);
});

test('fixHelperPermissions makes a non-executable spawn-helper executable and leaves Windows alone', async (t) => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { fixHelperPermissions } = await import('../pty-loader.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-helper-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pty = path.join(root, 'node_modules', 'node-pty');
  fs.mkdirSync(path.join(pty, 'prebuilds', 'darwin-arm64'), { recursive: true });
  fs.writeFileSync(path.join(pty, 'package.json'), '{"name":"node-pty","version":"1.0.0"}');
  const helper = path.join(pty, 'prebuilds', 'darwin-arm64', 'spawn-helper');
  fs.writeFileSync(helper, '#!/bin/sh\n', { mode: 0o644 });
  const from = new URL(`file://${root}/x.js`).href;
  assert.deepEqual(fixHelperPermissions('win32', from), []);
  assert.deepEqual(fixHelperPermissions('darwin', from), [helper]);
  assert.equal(fs.statSync(helper).mode & 0o111, 0o111);
  assert.deepEqual(fixHelperPermissions('darwin', from), [], 'idempotent');
  assert.deepEqual(fixHelperPermissions('darwin', new URL('file:///nonexistent/x.js').href), [], 'no node-pty: nothing, no throw');
});
