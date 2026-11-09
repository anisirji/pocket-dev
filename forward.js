import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { sameOrigin } from './transport.js';

const CONNECT_MS = 3000;
const IDLE_MS = 60_000;
const CACHE_MS = 20_000;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
// Never passed on: this device's login, how the browser reached this device, and any room credential a client tried to smuggle in.
const LOCAL = /^(cookie|host|origin|referer|x-forwarded-.*|cf-.*|x-real-ip|forwarded|x-room-.*)$/;
const PATH = /^\/m\/([0-9a-f]{4,64})(\/.*)?$/;

// Working on another device through the room. The phone logs in on one device (the front); `/m/<deviceId>/<path>` on the
// front is passed to that device. The room is a star, so a member reaches another member through the host (one hop) and
// the host reaches everyone directly. The target decides what the originating member may do (room.authPeerRequest).
export function createForward({ room, auth, collaborators, sendJson }) {
  const good = new Map(); // deviceId -> { url, at }: the address that answered last

  // Called for every request first. Returns null for an ordinary request, an error to refuse, and otherwise marks `req` as
  // coming from a room member: admin level becomes a virtual owner device, collaborator level a guest (see collaborators.guest).
  function identify(req) {
    if (req.headers['x-room-secret'] === undefined && req.headers['x-room-sender'] === undefined) return null;
    try { req.roomPeer = room.authPeerRequest(req.headers); } catch (err) { return { status: err.status || 403, error: err.message }; }
    if (req.roomPeer.level === 'admin') req.roomDevice = { id: `room-${req.roomPeer.origin}`, name: req.roomPeer.name, status: 'active', role: 'admin', via: 'room', tokenHashes: [] };
    return null;
  }

  const probe = (url) => new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(CONNECT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  async function reach(r) {
    const known = good.get(r.deviceId);
    if (known && Date.now() - known.at < CACHE_MS && r.addresses.includes(known.url.origin)) return known.url;
    for (const address of r.addresses) {
      const url = new URL(address);
      if (await probe(url)) { good.set(r.deviceId, { url, at: Date.now() }); return url; }
    }
    good.delete(r.deviceId);
    return null;
  }

  // Who is asking and where it goes. `origin` is the member the target will rank; a request already carrying a room
  // credential (the host relaying for a member) keeps its origin, and may only be relayed by the host, once.
  function plan(req, targetId, rest) {
    if (rest.startsWith('/m/')) return { status: 508, error: 'Forwarding stops after one hop through the host.' };
    if (req.roomPeer) {
      if (!req.roomPeer.relay) return { status: 508, error: 'Forwarding stops after one hop through the host.' };
      if (targetId === req.roomPeer.origin) return { status: 508, error: 'A device cannot forward to itself.' };
      if (targetId === room.deviceId()) return { status: 508, error: 'This request already arrived at the device it is for.' };
      return { origin: req.roomPeer.origin };
    }
    if (req.headers['x-pocket-dev'] !== '1' && MUTATING.has(req.method)) return { status: 403, error: 'This page is older than the server. Reload Pocket Dev and try again.' };
    if (MUTATING.has(req.method) && !sameOrigin(req)) return { status: 403, error: 'Cross-origin request refused.' };
    if (collaborators.guest(req)) return { status: 403, error: 'Collaborators cannot work on other devices.' };
    const device = auth.deviceFor(req);
    if (!device) return { status: 401, error: 'Not logged in' };
    return { origin: room.deviceId(), device };
  }

  function prepare(req, targetId, rest) {
    const p = plan(req, targetId, rest);
    if (p.error) return p;
    let r;
    try { r = room.route(targetId); } catch (err) { return { status: err.status || 400, error: err.message }; }
    return { ...p, route: r };
  }

  function headersFor(req, p, url, rest, upgrade) {
    const dropped = new Set(String(req.headers.connection ?? '').split(',').map((v) => v.trim().toLowerCase()));
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (LOCAL.test(k) || (!upgrade && (HOP.has(k) || dropped.has(k)))) continue;
      if (upgrade && (k === 'content-length' || k === 'transfer-encoding')) continue;
      out[k] = v;
    }
    if (req.headers.origin) out.origin = url.origin;
    out.host = url.host;
    Object.assign(out, { 'x-pocket-dev': '1', 'x-room-id': p.route.roomId, 'x-room-sender': p.route.sender, 'x-room-secret': p.route.secret, 'x-room-from': p.origin });
    return out;
  }
  const pathFor = (p, targetId, rest, search) => `${p.route.relayTo ? `/m/${p.route.relayTo}` : ''}${rest}${search}`;
  const unreachable = (p) => ({ status: 502, error: `${p.route.name} is not reachable right now.`, deviceId: p.route.deviceId });

  async function http_(req, res, url) {
    const [, targetId, rest = '/'] = PATH.exec(url.pathname) ?? [];
    if (!targetId) return sendJson(res, 404, { error: 'Not found' });
    const p = prepare(req, targetId, rest);
    if (p.error) return sendJson(res, p.status, { error: p.error });
    const base = await reach(p.route);
    if (!base) { const u = unreachable(p); return sendJson(res, u.status, { error: u.error, deviceId: u.deviceId }); }
    const lib = base.protocol === 'https:' ? https : http;
    const fail = (err) => {
      good.delete(p.route.deviceId);
      if (!res.headersSent) sendJson(res, 502, { error: `${p.route.name} did not answer: ${err.message}`, deviceId: p.route.deviceId });
      else res.destroy();
    };
    const up = lib.request({ protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || undefined, method: req.method,
      path: pathFor(p, targetId, rest, url.search), headers: headersFor(req, p, base, rest, false), timeout: IDLE_MS }, (ur) => {
      const headers = {};
      const dropped = new Set(String(ur.headers.connection ?? '').split(',').map((v) => v.trim().toLowerCase()));
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k) && !dropped.has(k) && k !== 'set-cookie') headers[k] = v;
      // A redirect to a path on the target stays on the target: the browser only knows this device's address.
      if (typeof headers.location === 'string' && headers.location.startsWith('/') && !headers.location.startsWith('//') && !headers.location.startsWith('/m/')) headers.location = `/m/${targetId}${headers.location}`;
      res.writeHead(ur.statusCode, ur.statusMessage, headers);
      ur.on('error', () => res.destroy());
      ur.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timed out')));
    up.on('error', fail);
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  function upgrade(req, socket, head, url, reject) {
    const [, targetId, rest = '/'] = PATH.exec(url.pathname) ?? [];
    if (!targetId) return reject(socket, 404, 'Not Found');
    const p = prepare(req, targetId, rest);
    if (!p.error && !req.roomPeer && !sameOrigin(req)) Object.assign(p, { status: 403, error: 'Forbidden' });
    if (p.error) return reject(socket, p.status, p.error.replace(/[\r\n]/g, ' '));
    reach(p.route).then((base) => {
      if (!base) return reject(socket, 502, 'Bad Gateway');
      const lib = base.protocol === 'https:' ? https : http;
      const up = lib.request({ protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || undefined, method: 'GET',
        path: pathFor(p, targetId, rest, url.search), headers: headersFor(req, p, base, rest, true) });
      up.setTimeout(CONNECT_MS * 3, () => up.destroy(new Error('timed out')));
      // A closed front device login or kicked front closes the pipe: the socket is registered like any other of the device.
      if (p.device) auth.trackSocket(p.device, { on: (e, f) => socket.on(e, f), terminate: () => socket.destroy() });
      up.on('upgrade', (ur, usock, uhead) => {
        usock.setTimeout(0);
        let text = `HTTP/1.1 101 Switching Protocols\r\n`;
        for (let i = 0; i < ur.rawHeaders.length; i += 2) if (!/^set-cookie$/i.test(ur.rawHeaders[i])) text += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`;
        socket.write(`${text}\r\n`);
        if (uhead.length) socket.write(uhead);
        if (head.length) usock.write(head);
        usock.pipe(socket); socket.pipe(usock);
        const stop = () => { usock.destroy(); socket.destroy(); };
        usock.on('error', stop); socket.on('error', stop); usock.on('close', stop); socket.on('close', stop);
      });
      up.on('response', (ur) => { ur.resume(); reject(socket, ur.statusCode, ur.statusMessage || 'Refused'); });
      up.on('error', () => { good.delete(p.route.deviceId); reject(socket, 502, 'Bad Gateway'); });
      up.end();
    }, () => reject(socket, 502, 'Bad Gateway'));
  }

  return { identify, http: http_, upgrade, isForward: (pathname) => pathname.startsWith('/m/') };
}
