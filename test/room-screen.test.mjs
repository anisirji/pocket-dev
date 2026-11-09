import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberState, levelText, sortMembers, lastSeenText, hostAddress, joinProblem, friendlyError } from '../public/room-screen.js';

test('member state reads status or online, treats this device as online, and says unknown otherwise', () => {
  assert.equal(memberState({ deviceId: 'a' }, 'a'), 'online');
  assert.equal(memberState({ deviceId: 'b', status: 'offline' }, 'a'), 'offline');
  assert.equal(memberState({ deviceId: 'b', online: true }, 'a'), 'online');
  assert.equal(memberState({ deviceId: 'b', online: false }, 'a'), 'offline');
  assert.equal(memberState({ deviceId: 'b' }, 'a'), 'unknown');
});

test('levels and ordering use plain words', () => {
  assert.match(levelText({ level: 'admin' }), /^Admin/);
  assert.equal(levelText({ level: 'collaborator', folders: ['/Users/x/Code/app', '/tmp/'] }), 'Collaborator: app, tmp');
  const sorted = sortMembers([{ deviceId: 'm2', joinedAt: 3 }, { deviceId: 'h', joinedAt: 5 }, { deviceId: 'm1', joinedAt: 2 }], 'h');
  assert.deepEqual(sorted.map((m) => m.deviceId), ['h', 'm1', 'm2']);
  assert.equal(lastSeenText(0), 'no answer');
  assert.equal(lastSeenText(1000, 1000 + 5 * 60_000), 'seen 5 min ago');
});

test('host addresses typed by hand become full addresses', () => {
  assert.equal(hostAddress(' 192.168.1.5:7681/ '), 'http://192.168.1.5:7681');
  assert.equal(hostAddress('laptop.example.com'), 'https://laptop.example.com');
  assert.equal(hostAddress('http://x.test'), 'http://x.test');
  assert.equal(hostAddress(''), '');
});

test('join form problems and server errors are explained without jargon', () => {
  assert.match(joinProblem({ code: '', host: 'h', level: 'admin', folders: [] }), /code/);
  assert.match(joinProblem({ code: 'c', host: '', level: 'admin', folders: [] }), /address/);
  assert.match(joinProblem({ code: 'c', host: 'h', level: 'collaborator', folders: [' '] }), /folder/);
  assert.equal(joinProblem({ code: 'c', host: 'h', level: 'admin', folders: [] }), '');
  assert.match(friendlyError('That join code is not valid. Ask the host for a new one.'), /wrong or has expired/);
  assert.match(friendlyError('fetch failed'), /Could not reach/);
  assert.match(friendlyError('anything', { offline: true }), /phone is offline/);
  assert.equal(friendlyError('Only the host can do this.'), 'Only the host can do this.');
});
