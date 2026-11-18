import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createTunnel } from './tunnel.js';

const KEY_MS = 60_000;
const SESSION_MS = 12 * 60 * 60_000;
const COOKIE = 'pd_port';
const KEY_PARAM = 'pd-port-key';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The tunnel's own headers never reach the dev server.
const DROPPED = /^(x-forwarded-.*|cf-.*|forwarded|x-real-ip|cdn-loop)$/;

const quickTunnel = (port) => createTunnel({ port, isConnected: () => true, network: () => ({ internet: { kind: 'quick' } }), token: () => null });

// A forwarded port opened from outside the home network. Each port gets its own Quick link, so a dev server keeps its
// root paths, and the link points at a gate on 127.0.0.1 instead of the dev server. The gate lets a request through only
// with a cookie it issued, and it issues one only for a one-time key that a logged-in owner device asked for. The key
// lasts a minute; the cookie is HttpOnly and Secure, lasts at most 12 hours, and stops working when that device is
// logged out or blocked, when internet access is turned off, or when the forward closes. Open WebSockets are checked
// again every few seconds, and turning internet access off ends every port's Quick link.
export function createRemotePorts({ isActive, allowed, log = () => {}, tunnelFor = quickTunnel, sweepMs = 5000 }) {
  const gates = new Map();

  function cookieOf(req) {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  }
  const authorized = (gate, req) => {
    const secret = cookieOf(req);
    const session = secret && gate.sessions.get(hash(secret));
    return Boolean(session && session.expires > Date.now() && allowed() && isActive(session.deviceId));
  };

  function upstreamHeaders(headers, port) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!DROPPED.test(k)) out[k] = v;
    const cookies = String(headers.cookie ?? '').split(';').map((c) => c.trim()).filter((c) => c && !c.startsWith(`${COOKIE}=`));
    if (cookies.length) out.cookie = cookies.join('; ');
    else delete out.cookie;
    // Dev servers such as Vite refuse an unknown Host, so the request arrives as it would on the computer itself.
    out.host = `localhost:${port}`;
    if (out.origin) out.origin = `http://localhost:${port}`;
    return out;
  }

  function page(res, status, text) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pocket Dev</title><body style="font:16px system-ui;padding:24px;background:#0b0e14;color:#e6e6e6"><p>${text}</p>`);
  }

  function redeem(gate, url, res) {
    const key = url.searchParams.get(KEY_PARAM);
    const entry = gate.keys.get(hash(key));
    gate.keys.delete(hash(key));
    if (!entry || entry.expires < Date.now() || !allowed() || !isActive(entry.deviceId)) {
      return page(res, 403, 'This link has expired. Open the port again from the Ports screen in Pocket Dev.');
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    gate.sessions.set(hash(secret), { deviceId: entry.deviceId, expires: Date.now() + SESSION_MS });
    url.searchParams.delete(KEY_PARAM);
    const path = url.pathname.startsWith('//') ? '/' : url.pathname + url.search;
    const next = JSON.stringify(path).replace(/</g, '\\u003c');
    // Lax, not Strict: an app's OAuth callback or a pasted link arrives from another site and must still carry it.
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': `${COOKIE}=${secret}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`,
    });
    res.end(`<!doctype html><meta charset="utf-8"><title>Pocket Dev</title><script>location.replace(${next})</script>`);
  }

  function handle(gate, req, res) {
    const url = new URL(req.url, 'http://gate');
    if (url.searchParams.has(KEY_PARAM)) return redeem(gate, url, res);
    if (!authorized(gate, req)) return page(res, 401, `Port ${gate.port} is behind your Pocket Dev login. Open it from the Ports screen in Pocket Dev.`);
    const up = http.request({ host: 'localhost', port: gate.port, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, gate.port) }, (ur) => {
      const headers = { ...ur.headers };
      const local = new RegExp(`^http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${gate.port}(?=/|$)`);
      if (typeof headers.location === 'string') headers.location = headers.location.replace(local, '') || '/';
      res.writeHead(ur.statusCode, ur.statusMessage, headers);
      ur.pipe(res);
    });
    up.on('error', () => {
      if (res.headersSent) return res.destroy();
      page(res, 502, `Nothing is answering on port ${gate.port} on the computer. Start the dev server, then reload.`);
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  function upgrade(gate, req, socket, head) {
    if (!authorized(gate, req)) return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const up = net.connect({ host: 'localhost', port: gate.port }, () => {
      const lines = Object.entries(upstreamHeaders(req.headers, gate.port)).flatMap(([k, v]) => [].concat(v).map((x) => `${k}: ${x}`));
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    gate.sockets.set(socket, req);
    const stop = () => { gate.sockets.delete(socket); up.destroy(); socket.destroy(); };
    up.on('error', stop);
    socket.on('error', stop);
    up.on('close', stop);
    socket.on('close', stop);
  }

  async function start(gate) {
    gate.server.listen(0, '127.0.0.1');
    await once(gate.server, 'listening');
    if (gate.closed) throw new Error('The forward was closed.');
    gate.tunnel = tunnelFor(gate.server.address().port);
    await gate.tunnel.start();
    for (;;) {
      if (gate.closed) throw new Error('The forward was closed.');
      const view = gate.tunnel.view();
      if (view.status === 'connected') return view.url;
      if (view.status !== 'starting') throw new Error(view.error || 'The internet link for this port stopped.');
      await sleep(200);
    }
  }

  function sweep(gate) {
    if (!allowed()) return close(gate.port);
    const now = Date.now();
    for (const [k, entry] of gate.keys) if (entry.expires < now) gate.keys.delete(k);
    for (const [k, session] of gate.sessions) if (session.expires < now) gate.sessions.delete(k);
    for (const [socket, req] of gate.sockets) if (!authorized(gate, req)) socket.destroy();
  }

  // Resolves to a link that logs `deviceId` in to the port's gate once, within a minute.
  async function open(port, deviceId, retry = true) {
    if (!allowed()) throw new Error('Internet access is off, so a port cannot be opened over the internet.');
    let gate = gates.get(port);
    if (!gate) {
      gate = { port, keys: new Map(), sessions: new Map(), sockets: new Map(), tunnel: null };
      gate.server = http.createServer((req, res) => handle(gate, req, res));
      gate.server.on('upgrade', (req, socket, head) => upgrade(gate, req, socket, head));
      gate.sweeper = setInterval(() => sweep(gate), sweepMs).unref();
      gate.ready = start(gate);
      gates.set(port, gate);
      const started = gate;
      gate.ready.catch(() => { if (gates.get(port) === started) close(port); });
    }
    const url = await gate.ready;
    // cloudflared can exit after it connected; that address is gone, so start the port's link again.
    if (gate.tunnel.view().status !== 'connected' && retry) {
      close(port);
      return open(port, deviceId, false);
    }
    const key = crypto.randomBytes(24).toString('base64url');
    gate.keys.set(hash(key), { deviceId, expires: Date.now() + KEY_MS });
    log('port-remote-opened', { port, deviceId, url });
    return `${url}/?${KEY_PARAM}=${key}`;
  }

  function close(port) {
    const gate = gates.get(port);
    if (!gate) return;
    gates.delete(port);
    gate.closed = true;
    clearInterval(gate.sweeper);
    gate.tunnel?.dispose();
    gate.server.close();
    gate.server.closeAllConnections?.();
    for (const s of gate.sockets.keys()) s.destroy();
  }

  return { open, close, closeAll: () => { for (const port of [...gates.keys()]) close(port); }, isOpen: (port) => gates.has(port) };
}
