import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, normalizeCode, isCode, formatCode, parseInvite, inviteProblem, inviteLine, isLoopbackHost, isLoopbackAddress, hostAddress, joinError } from '../public/room-invite.js';

test('the code alphabet has nothing that looks like something else', () => {
  assert.equal(CODE_ALPHABET.length, 31);
  for (const c of '0O1IL') assert.equal(CODE_ALPHABET.includes(c), false);
});

test('codes are read case-insensitively, with or without hyphen and spaces', () => {
  for (const t of ['ABCD-EFGH', 'abcd-efgh', 'abcdefgh', ' ab cd  ef-gh ']) assert.equal(normalizeCode(t), 'ABCDEFGH');
  assert.equal(formatCode('abcdefgh'), 'ABCD-EFGH');
  assert.equal(isCode('abcd-efgh'), true);
  assert.equal(isCode('ABCD-EFG0'), false, 'zero is not in the alphabet');
  assert.equal(isCode('ABCD-EFG'), false);
});

test('an invite is read from a URL plus code, host:port plus code, host:port/code, or a code alone', () => {
  const want = { host: 'http://192.168.1.24:58765', code: 'ABCDEFGH' };
  for (const t of [
    '192.168.1.24:58765  ABCD-EFGH', '192.168.1.24:58765 abcd efgh', '  192.168.1.24:58765\tabcdefgh  ', '192.168.1.24:58765/ABCD-EFGH',
    '192.168.1.24:58765/abcdefgh/', 'http://192.168.1.24:58765 ABCD-EFGH', 'http://192.168.1.24:58765/ABCD-EFGH', 'http://192.168.1.24:58765/ ABCD-EFGH\n',
    'HTTP://192.168.1.24:58765//abcd-efgh', '192.168.1.24:58765, ABCD-EFGH',
  ]) assert.deepEqual(parseInvite(t), want, JSON.stringify(t));
  assert.deepEqual(parseInvite('https://mac.example.com/ABCD-EFGH'), { host: 'https://mac.example.com', code: 'ABCDEFGH' });
  assert.deepEqual(parseInvite('mac.example.com abcd-efgh'), { host: 'https://mac.example.com', code: 'ABCDEFGH' });
  assert.deepEqual(parseInvite('abcd-efgh'), { host: '', code: 'ABCDEFGH' });
  assert.deepEqual(parseInvite('192.168.1.24:58765'), { host: 'http://192.168.1.24:58765', code: '' });
  assert.deepEqual(parseInvite(''), { host: '', code: '' });
  assert.deepEqual(parseInvite(inviteLine('http://192.168.1.24:58765', 'abcdefgh')), want);
});

test('the invite line drops http:// and shows the hyphenated code', () => {
  assert.equal(inviteLine('http://192.168.1.24:58765', 'abcdefgh'), '192.168.1.24:58765  ABCD-EFGH');
  assert.equal(inviteLine('https://x.trycloudflare.com/', 'ABCDEFGH'), 'https://x.trycloudflare.com  ABCD-EFGH');
});

test('loopback names are recognised', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST.', '::1', '[::1]', '0.0.0.0']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['192.168.1.24', '10.0.0.5', 'mac.local', 'example.com']) assert.equal(isLoopbackHost(h), false, h);
  assert.equal(isLoopbackAddress(hostAddress('127.0.0.1:7777')), true);
  assert.equal(isLoopbackAddress(hostAddress('localhost:7777')), true);
});

test('problems with the entered invite are explained before any request', () => {
  assert.match(inviteProblem({ host: 'http://192.168.1.2:1', code: '' }), /8-character code/);
  assert.match(inviteProblem({ host: '', code: 'ABCDEFGH' }), /address of the host/);
  const loop = inviteProblem({ host: 'http://127.0.0.1:7777', code: 'ABCDEFGH', knownHost: 'http://192.168.1.24:7777' });
  assert.match(loop, /127\.0\.0\.1 means this device itself\. Use the Wi-Fi address of the host, like 192\.168\.1\.24:7777/);
  assert.match(loop, /host said it is 192\.168\.1\.24:7777/);
  assert.match(inviteProblem({ host: 'http://localhost:7777', code: 'ABCDEFGH' }), /means this device itself/);
  assert.equal(inviteProblem({ host: 'http://127.0.0.1:7777', code: 'ABCDEFGH', allowLoopback: true }), '');
  assert.equal(inviteProblem({ host: 'http://192.168.1.24:7777', code: 'ABCDEFGH' }), '');
});

test('join errors name the address tried and the likely causes, and tell wrong, expired and used codes apart', () => {
  const unreachable = joinError('Could not reach the host at http://192.168.1.24:7777.');
  assert.match(unreachable, /192\.168\.1\.24:7777/);
  assert.match(unreachable, /same Wi-Fi/);
  assert.match(unreachable, /firewall/);
  assert.match(unreachable, /port/);
  assert.match(joinError('That code is not right. Check it and try again.'), /wrong/);
  assert.match(joinError('That code has expired. Ask the host for a new code.'), /expired/);
  assert.match(joinError('That code was already used. Ask the host for a new code.'), /already used/);
  assert.match(joinError('x', { offline: true }), /offline/);
});
