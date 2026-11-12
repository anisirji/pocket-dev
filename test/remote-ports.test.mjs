import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createRemotePorts } from '../remote-ports.js';
import { startServer, until } from './helpers/server.mjs';

// A dev server that reports what reached it, with a WebSocket endpoint like a hot-reload channel.
async function devServer(t, host = '127.0.0.1') {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/go') { res.writeHead(302, { location: `http://localhost:${server.address().port}/landed` }); return res.end(); }
    if (req.url === '/go4') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/` }); return res.end(); }
    res.end(`dev page ${req.url}`);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => { seen.push({ ws: true, headers: req.headers }); ws.on('message', (m) => ws.send(`echo ${m}`)); });
  server.listen(0, host);
  await once(server, 'listening');
  t.after(() => { wss.close(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { port: server.address().port, seen };
}

function fakeTunnel() {
  const made = [];
  const tunnelFor = (gatePort) => {
    const url = `https://port-${made.length + 1}.trycloudflare.com`;
    const tunnel = { gatePort, killed: false, status: 'connected', start: async () => {}, view: () => ({ status: tunnel.status, url }), dispose() { this.killed = true; } };
    made.push(tunnel);
    return tunnel;
  };
  return { made, tunnelFor };
}

function get(gatePort, path, { cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: gatePort, path, headers: { host: 'port-1.trycloudflare.com', 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-proto': 'https', ...(cookie && { cookie }), ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}
const keyOf = (link) => new URL(link).searchParams.get('pd-port-key');

test('a port opened over the internet answers only a device that redeemed its one-time key', async (t) => {
  const dev = await devServer(t);
  const active = new Set(['dev1']);
  let internet = true;
  const { made, tunnelFor } = fakeTunnel();
  const remote = createRemotePorts({ isActive: (id) => active.has(id), allowed: () => internet, tunnelFor });
  t.after(() => remote.closeAll());

  const link = await remote.open(dev.port, 'dev1');
  assert.match(link, /^https:\/\/port-1\.trycloudflare\.com\/\?pd-port-key=[\w-]{32}$/);
  const gate = made[0].gatePort;

  const stranger = await get(gate, '/');
  assert.equal(stranger.status, 401);
  assert.match(stranger.body, /behind your Pocket Dev login/);
  assert.equal((await get(gate, '/?pd-port-key=guessed')).status, 403);
  assert.equal(dev.seen.length, 0, 'nothing reaches the dev server without a login');

  const landing = await get(gate, `/app?x=1&pd-port-key=${keyOf(link)}`);
  assert.equal(landing.status, 200);
  const setCookie = landing.headers['set-cookie'][0];
  assert.match(setCookie, /^pd_port=[\w-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=43200$/);
  assert.match(landing.body, /location\.replace\("\/app\?x=1"\)/, 'the key leaves the address bar');
  assert.equal((await get(gate, `/?pd-port-key=${keyOf(link)}`)).status, 403, 'a key works once');

  const cookie = `${setCookie.split(';')[0]}; app_session=abc`;
  const page = await get(gate, '/hello', { cookie, headers: { origin: 'https://port-1.trycloudflare.com' } });
  assert.equal(page.status, 200);
  assert.equal(page.body, 'dev page /hello');
  const reached = dev.seen.at(-1).headers;
  assert.equal(reached.host, `localhost:${dev.port}`, 'the dev server sees its own address, so a Host check passes');
  assert.equal(reached.origin, `http://localhost:${dev.port}`);
  assert.equal(reached.cookie, 'app_session=abc', 'the gate cookie stays at the gate; the app keeps its own');
  assert.equal(Object.keys(reached).some((k) => /^(cf-|x-forwarded-)/.test(k)), false);
  assert.equal((await get(gate, '/go', { cookie })).headers.location, '/landed', 'a redirect to the dev server stays on the link');
  assert.equal((await get(gate, '/go4', { cookie })).headers.location, '/');

  const ws = new WebSocket(`ws://127.0.0.1:${gate}/hmr`, { headers: { cookie, host: 'port-1.trycloudflare.com' } });
  await once(ws, 'open');
  ws.send('ping');
  assert.equal(String((await once(ws, 'message'))[0]), 'echo ping', 'hot reload sockets pass through');
  ws.close();
  const refused = new WebSocket(`ws://127.0.0.1:${gate}/hmr`);
  const [err] = await once(refused, 'error');
  assert.match(err.message, /401/);

  internet = false;
  assert.equal((await get(gate, '/hello', { cookie })).status, 401, 'turning internet access off shuts the gate');
  internet = true;
  active.delete('dev1');
  assert.equal((await get(gate, '/hello', { cookie })).status, 401, 'a logged-out device loses the port');

  remote.close(dev.port);
  assert.equal(made[0].killed, true, 'closing the forward ends its Quick link');
  await assert.rejects(get(gate, '/hello', { cookie }));
});

test('keys expire after a minute and cannot be minted with internet access off', async (t) => {
  const dev = await devServer(t);
  const { made, tunnelFor } = fakeTunnel();
  let internet = true;
  const remote = createRemotePorts({ isActive: () => true, allowed: () => internet, tunnelFor });
  t.after(() => remote.closeAll());
  const realNow = Date.now;
  const link = await remote.open(dev.port, 'dev1');
  Date.now = () => realNow() + 61_000;
  try {
    assert.equal((await get(made[0].gatePort, `/?pd-port-key=${keyOf(link)}`)).status, 403);
  } finally { Date.now = realNow; }
  assert.equal(made.length, 1);
  await remote.open(dev.port, 'dev1');
  assert.equal(made.length, 1, 'a second open reuses the port\'s Quick link');
  internet = false;
  await assert.rejects(remote.open(dev.port, 'dev1'), /Internet access is off/);
});

test('the server hands a login link for a forwarded port only to a logged-in device, and closing the forward ends it', { timeout: 60000 }, async (t) => {
  const dev = await devServer(t, '::1');
  const s = await startServer(t, { network: { wifi: true, internet: { kind: 'quick' } } });
  const { cookie } = await s.login();
  assert.equal((await s.request('POST', `/api/forwards/${dev.port}/remote`, { body: {} })).status, 401);
  assert.equal((await s.request('POST', `/api/forwards/${dev.port}/remote`, { cookie, body: {} })).status, 404, 'only a forwarded port');
  assert.equal((await s.request('POST', '/api/forwards', { cookie, body: { port: dev.port } })).status, 201);
  const opened = await s.request('POST', `/api/forwards/${dev.port}/remote`, { cookie, body: {} });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.match(opened.data.url, /^https:\/\/quick-fixture-\d+\.trycloudflare\.com\/\?pd-port-key=/);
  const argv = s.recorded('argv').trim().split('\n');
  assert.deepEqual(argv.slice(0, 3), ['tunnel', '--no-autoupdate', '--url']);
  const gate = Number(new URL(argv[3]).port);
  assert.equal(new URL(argv[3]).hostname, '127.0.0.1', 'the Quick link points at the gate, never at the dev server');
  assert.notEqual(gate, dev.port);
  assert.equal((await get(gate, '/')).status, 401);
  const landing = await get(gate, `/?pd-port-key=${keyOf(opened.data.url)}`);
  const portCookie = landing.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get(gate, '/x', { cookie: portCookie })).body, 'dev page /x');
  assert.equal((await s.request('GET', '/api/info', { cookie })).data.remote, false);
  const log = (await s.local('GET', '/api/log')).data;
  assert.ok(log.some((e) => e.type === 'port-remote-opened' && e.port === dev.port));
  assert.equal((await s.request('DELETE', `/api/forwards/${dev.port}`, { cookie })).status, 204);
  await until(async () => (await get(gate, '/x', { cookie: portCookie }).catch(() => null)) === null);
});

test('open sockets end when their device logs out, and internet access off ends the Quick link', async (t) => {
  const dev = await devServer(t);
  const active = new Set(['dev1']);
  let internet = true;
  const { made, tunnelFor } = fakeTunnel();
  const remote = createRemotePorts({ isActive: (id) => active.has(id), allowed: () => internet, tunnelFor, sweepMs: 30 });
  t.after(() => remote.closeAll());
  const gate = async () => {
    const link = await remote.open(dev.port, 'dev1');
    const port = made.at(-1).gatePort;
    const cookie = (await get(port, `/?pd-port-key=${keyOf(link)}`)).headers['set-cookie'][0].split(';')[0];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`, { headers: { cookie } });
    await once(ws, 'open');
    return ws;
  };
  const ws = await gate();
  active.delete('dev1');
  await once(ws, 'close');
  active.add('dev1');
  const second = await gate();
  internet = false;
  await once(second, 'close');
  assert.equal(made.at(-1).killed, true, 'turning internet access off stops the port\'s cloudflared');
  assert.equal(remote.isOpen(dev.port), false);
});

test('a port whose cloudflared exited after connecting gets a new Quick link', async (t) => {
  const dev = await devServer(t);
  const { made, tunnelFor } = fakeTunnel();
  const remote = createRemotePorts({ isActive: () => true, allowed: () => true, tunnelFor });
  t.after(() => remote.closeAll());
  assert.match(await remote.open(dev.port, 'dev1'), /port-1\./);
  made[0].status = 'error';
  assert.match(await remote.open(dev.port, 'dev1'), /port-2\./);
  assert.equal(made[0].killed, true);
});
