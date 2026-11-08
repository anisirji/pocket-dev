import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readNetwork, networkError, ipv6Prefix, createSameNetwork } from '../network.js';
import { createTunnel } from '../tunnel.js';

const config = (network) => ({ read: () => ({ network }) });
const OFF = { wifi: true, internet: { kind: 'off', hostname: null } };

test('a missing or unusable network setting means Wi-Fi only with internet off', () => {
  for (const value of [undefined, null, 'quick', 7, [], {}, { wifi: 'yes' }, { internet: { kind: 'tunnel' } }, { internet: { kind: 'domain' } },
    { internet: { kind: 'domain', hostname: 'not a host' } }, { internet: { kind: 'domain', hostname: '10.0.0.5' } }]) {
    assert.deepEqual(readNetwork(config(value)), OFF, JSON.stringify(value));
  }
  assert.deepEqual(readNetwork(config({ wifi: false, internet: { kind: 'off' } })), OFF, 'Wi-Fi off with internet off would reach nothing');
  assert.deepEqual(readNetwork(config({ wifi: false, internet: { kind: 'quick', hostname: 'ignored.example.com' } })), { wifi: false, internet: { kind: 'quick', hostname: null } });
  assert.deepEqual(readNetwork(config({ internet: { kind: 'domain', hostname: 'Pocket.Example.com' } })), { wifi: true, internet: { kind: 'domain', hostname: 'pocket.example.com' } });
});

test('saving refuses a lockout, a bad hostname and a domain without a token', () => {
  const domain = (hostname) => ({ wifi: true, internet: { kind: 'domain', hostname } });
  assert.equal(networkError(OFF, { hasToken: false }), null);
  assert.match(networkError({ wifi: false, internet: { kind: 'off' } }, { hasToken: false }), /Turn on internet access before/);
  assert.equal(networkError({ wifi: false, internet: { kind: 'quick' } }, { hasToken: false }), null);
  assert.match(networkError(domain('pocket'), { hasToken: true }), /hostname/);
  assert.match(networkError(domain('pocket.example.com'), { hasToken: false }), /token/);
  assert.equal(networkError(domain('pocket.example.com'), { hasToken: true }), null);
  assert.match(networkError({ wifi: 'true', internet: { kind: 'off' } }, { hasToken: false }), /wifi/);
  assert.match(networkError({ wifi: true, internet: { kind: 'auto' } }, { hasToken: false }), /off, quick, domain/);
});

test('an IPv6 address is matched by its /64 and IPv4 is never mistaken for it', () => {
  assert.equal(ipv6Prefix('2001:db8:1:2:3:4:5:6'), '2001:0db8:0001:0002');
  assert.equal(ipv6Prefix('2001:DB8::1'), '2001:0db8:0000:0000');
  assert.equal(ipv6Prefix('::ffff:203.0.113.5'), null);
  assert.equal(ipv6Prefix('203.0.113.5'), null);
});

test('same-network: IPv6 by /64, IPv4 by the public address, unknown when the trace fails', async () => {
  const interfaces = () => ({
    lo0: [{ family: 'IPv6', address: '::1', internal: true }, { family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv6', address: '2001:db8:aaaa:bbbb:1234:5678:9abc:def0', internal: false }],
  });
  let traces = 0;
  const net = createSameNetwork({ interfaces, trace: async () => { traces++; return '203.0.113.5'; } });
  assert.equal(await net.hint('2001:db8:aaaa:bbbb:ffff::1'), true);
  assert.equal(await net.hint('2001:db8:aaaa:bbbc::1'), false);
  assert.equal(await net.hint('203.0.113.5'), true);
  assert.equal(await net.hint('203.0.113.6'), false);
  assert.equal(traces, 1, 'the public address is cached');
  assert.equal(net.key('2001:db8:aaaa:bbbb::1'), net.key('2001:db8:aaaa:bbbb:9::9'), 'one key per /64');
  assert.notEqual(net.key('203.0.113.5'), net.key('203.0.113.6'));
  assert.match(net.key('203.0.113.5'), /^[0-9a-f]{12}$/);

  const failing = createSameNetwork({ interfaces: () => ({ en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }] }), trace: async () => { throw new Error('offline'); } });
  assert.equal(await failing.hint('203.0.113.5'), null);
  assert.equal(await failing.hint('2001:db8::1'), null, 'no global IPv6 on the Mac means no answer, not a mismatch');
});

function fakeTunnel(overrides = {}) {
  const spawned = [];
  const spawnProcess = (file, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { proc.killed = true; proc.emit('exit', null, 'SIGTERM'); };
    spawned.push({ file, args, options, proc });
    return proc;
  };
  const events = [];
  const net = { wifi: true, internet: { kind: 'off', hostname: null } };
  const tunnel = createTunnel({
    port: 7777, isConnected: () => true, network: () => net, token: () => 'eyJhIjoiYmNkZWYiLCJ0IjoidG9rZW4ifQ',
    log: (type, fields) => events.push({ type, ...fields }), spawnProcess, executable: () => '/fake/cloudflared', stopMs: 10, ...overrides,
  });
  return { tunnel, spawned, events, net };
}

test('internet off refuses to start a tunnel', async () => {
  const { tunnel, spawned } = fakeTunnel();
  await assert.rejects(tunnel.start(), /Internet access is off/);
  assert.equal(spawned.length, 0);
});

test('a domain tunnel runs with the token in TUNNEL_TOKEN only, and is ready at its hostname once registered', async () => {
  const { tunnel, spawned, events, net } = fakeTunnel();
  net.internet = { kind: 'domain', hostname: 'pocket.example.com' };
  assert.deepEqual(await tunnel.start(), { status: 'starting', kind: 'domain', url: null, error: null });
  const [{ args, options, proc }] = spawned;
  assert.deepEqual(args, ['tunnel', '--no-autoupdate', 'run']);
  assert.equal(options.env.TUNNEL_TOKEN, 'eyJhIjoiYmNkZWYiLCJ0IjoidG9rZW4ifQ');
  assert.equal(args.join(' ').includes('eyJ'), false, 'the token never appears in argv');
  proc.stderr.emit('data', 'INF Starting tunnel tunnelID=1234\nINF Registered tunnel conn');
  assert.equal(tunnel.view().status, 'starting', 'half a line is not a registration');
  proc.stderr.emit('data', 'ection connIndex=0 location=fra\n');
  assert.deepEqual(tunnel.view(), { status: 'connected', kind: 'domain', url: 'https://pocket.example.com', error: null });
  assert.deepEqual(events, [{ type: 'remote-started', kind: 'domain', url: 'https://pocket.example.com' }]);
  assert.equal(JSON.stringify(events).includes('eyJ'), false, 'the token never reaches the log');
  await tunnel.stop();
  assert.equal(proc.killed, true);
  assert.deepEqual(tunnel.view(), { status: 'off', kind: null, url: null, error: null });
});

test('a domain tunnel without a saved token refuses, and cloudflared’s last line explains an exit', async () => {
  const missing = fakeTunnel({ token: () => null });
  missing.net.internet = { kind: 'domain', hostname: 'pocket.example.com' };
  await assert.rejects(missing.tunnel.start(), /No tunnel token/);
  const { tunnel, spawned, net } = fakeTunnel();
  net.internet = { kind: 'domain', hostname: 'pocket.example.com' };
  await tunnel.start();
  spawned[0].proc.stderr.emit('data', 'ERR Unauthorized: Failed to get tunnel\n');
  spawned[0].proc.emit('exit', 1, null);
  assert.equal(tunnel.view().status, 'error');
  assert.match(tunnel.view().error, /exit 1.*Unauthorized: Failed to get tunnel/);
});

test('a Quick link keeps its random address and its on-demand start', async () => {
  const { tunnel, spawned, net } = fakeTunnel();
  net.internet = { kind: 'quick', hostname: null };
  await tunnel.start();
  const [{ args, options, proc }] = spawned;
  assert.deepEqual(args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7777']);
  assert.equal('TUNNEL_TOKEN' in options.env, false);
  proc.stderr.emit('data', 'INF |  https://brave-words-here.trycloudflare.com  |\nINF Registered tunnel connection connIndex=0\n');
  assert.deepEqual(tunnel.view(), { status: 'connected', kind: 'quick', url: 'https://brave-words-here.trycloudflare.com', error: null });
});

test('a missing cloudflared is reported with the install command instead of spawning', async () => {
  const { tunnel, spawned, net } = fakeTunnel({ executable: () => null });
  net.internet = { kind: 'quick', hostname: null };
  const view = await tunnel.start();
  assert.equal(view.status, 'error');
  assert.match(view.error, /brew install cloudflared/);
  assert.equal(spawned.length, 0);
});
