import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// public/machine.js installs its browser wrappers only when there is a document; here it only exposes PocketMachine.
const ctx = { URL };
vm.runInNewContext(fs.readFileSync(new URL('../public/machine.js', import.meta.url), 'utf8'), ctx);
const { sayFor, rewriteUrl, storageKey, allowedViews, blockedFor, sortDevices, stateText } = ctx.PocketMachine;
const BASE = 'https://phone.example.test/';
const ID = '41231418761633a4';

test('API and socket paths go through /m/<device> on a remote device', () => {
  assert.equal(rewriteUrl(ID, '/api/files/list?path=%2Fa', BASE), `/m/${ID}/api/files/list?path=%2Fa`);
  assert.equal(rewriteUrl(ID, '/ws/chat/abc', BASE), `/m/${ID}/ws/chat/abc`);
  assert.equal(rewriteUrl(ID, 'wss://phone.example.test/ws/messages?after=3', BASE), `wss://phone.example.test/m/${ID}/ws/messages?after=3`);
  assert.equal(rewriteUrl(ID, 'https://phone.example.test/api/chat/x/image/a.png', BASE), `https://phone.example.test/m/${ID}/api/chat/x/image/a.png`);
});

test('nothing changes on this device, or for pages, other hosts, forwarded paths and this device\'s own routes', () => {
  assert.equal(rewriteUrl(null, '/api/files/list', BASE), '/api/files/list');
  for (const url of ['/login.html', '/files.js', '/vendor/xterm/xterm.js', `/m/${ID}/api/status`, 'https://other.example/api/x', '//other.example/api/x',
    '/api/room/devices', '/api/login', '/api/logout', '/api/devices/3', '/api/settings', '/api/network', '/api/local/power', 'mailto:a@b.c']) {
    assert.equal(rewriteUrl(ID, url, BASE), url, url);
  }
  assert.equal(rewriteUrl(ID, '/api/roomy', BASE), `/m/${ID}/api/roomy`, 'only the room prefix itself stays local');
});

test('storage keys: unchanged on this device, namespaced per remote device, the choice itself global', () => {
  assert.equal(storageKey(null, 'pd.files.sort'), 'pd.files.sort');
  assert.equal(storageKey(ID, 'pd.files.sort'), `m.${ID}:pd.files.sort`);
  assert.equal(storageKey(ID, 'pd.terminal.draft.t1'), `m.${ID}:pd.terminal.draft.t1`);
  assert.notEqual(storageKey(ID, 'pd.view'), storageKey('aaaa', 'pd.view'));
  assert.equal(storageKey(ID, 'pd.machine'), 'pd.machine');
  assert.equal(storageKey(ID, 'pd.machine.devices'), 'pd.machine.devices');
});

test('a collaborator rank only gets Files and Messages, and calls outside them are not sent', () => {
  assert.deepEqual([...allowedViews('collaborator')], ['files', 'messages']);
  assert.deepEqual([...allowedViews('admin')], ['terminal', 'git', 'chat', 'files', 'messages']);
  assert.equal(blockedFor('collaborator', ID, '/api/sessions', BASE), true);
  assert.equal(blockedFor('collaborator', ID, '/api/power/vitals', BASE), true);
  assert.equal(blockedFor('collaborator', ID, '/api/files/places', BASE), false);
  assert.equal(blockedFor('collaborator', ID, '/api/messages/files/9', BASE), false);
  assert.equal(blockedFor('collaborator', ID, '/api/room/devices', BASE), false, 'this device\'s own routes are never blocked');
  assert.equal(blockedFor('admin', ID, '/api/sessions', BASE), false);
  assert.equal(blockedFor('collaborator', null, '/api/sessions', BASE), false);
});

test('the device list puts this device first, then online ones, and explains an offline one', () => {
  const list = sortDevices([{ name: 'Z', online: true }, { name: 'B', online: false }, { name: 'Me', online: true, self: true }, { name: 'A', online: true }]);
  assert.equal(list.map((d) => d.name).join(),'Me,A,Z,B');
  assert.equal(stateText({ online: false, rank: 'admin' }), 'Not answering right now');
  assert.match(stateText({ online: true, rank: 'collaborator' }), /files and messages/);
});

test('status wording names the remote device instead of the Mac', () => {
  assert.equal(sayFor('Beta', 'Mac not responding'), 'Beta not responding');
  assert.equal(sayFor('Beta', 'Checking Mac…'), 'Checking Beta…');
  assert.equal(sayFor('Beta', 'The Mac may sleep'), 'Beta may sleep');
  assert.equal(sayFor('Beta', 'Available on the Mac’s home disk'), 'Available on Beta’s home disk');
  assert.equal(sayFor('Beta', 'Type your Mac password in the new terminal.'), 'Type the password for Beta in the new terminal.');
  assert.equal(sayFor('Beta', 'Open the lid on the Mac'), 'Open the lid on Beta');
  assert.equal(sayFor('Beta', 'MacBook'), 'MacBook', 'a word that only starts with Mac is left alone');
});
