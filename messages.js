import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { STATE_DIR } from './paths.js';
import { sameOrigin, fromConnector } from './transport.js';
import { rangeOf, disposition } from './files.js';
import { thumbnailOf } from './chat/tool-images.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const TEXT_MAX = 64 * 1024;
// Cloudflare's free plan rejects request bodies over 100 MB with its own page, so the connector route stops there.
// On the Wi-Fi route a file can be any size; the disk reserve protects the Mac instead.
const CONNECTOR_FILE_MAX = 100 * MB;
// After a refusal the body is read and dropped instead of cut off, so the browser sees the error (see upload in
// server.js). Past this much it is cut off anyway.
const DRAIN_MAX = 200 * MB;
const DISK_CHECK_BYTES = 16 * MB;
// While free space is under the reserve, only files over LARGE_FILE wait; text and smaller files still go, down to a
// floor that keeps the disk from filling completely.
const LARGE_FILE = 50 * MB;
const DEFAULT_RESERVE_GB = 5;
const DISK_FLOOR = 500 * MB;
const FILES_PER_MESSAGE = 20;
const BODY_MAX = 512 * 1024;
const PENDING_MS = 60 * 60_000;
const ORIGINAL_PREVIEW_MAX = 8 * MB;
const GUEST_GONE = 'Your collaborator access expired or was revoked.';

// Types are read from the file's first bytes, never from its name or the uploader's claim, because every role can
// upload and an inline response runs on the Pocket Dev origin. Only these play or show in the page; everything else,
// SVG and HTML included, downloads as application/octet-stream. HEIC shows through its JPEG thumbnail only.
const INLINE = {
  'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/ogg': 'audio', 'audio/wav': 'audio',
};
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'MSNV']);

export function detectType(head) {
  const ascii = (from, to) => head.toString('latin1', from, to);
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ') return 'audio/mp4';
    if (MP4_BRANDS.has(brand)) return 'video/mp4';
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && head.includes('webm')) return 'video/webm';
  if (ascii(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return 'application/octet-stream';
}
const kindOf = (type) => INLINE[type] ?? (type === 'image/heic' ? 'image' : 'file');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const sizeText = (n) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.max(0.1, n / MB).toFixed(1)} MB`);
const overInternet = (size) => `Over the internet you can send files up to 100 MB. This file is ${size ? sizeText(size) : 'larger'}. Connect on the same Wi-Fi as the Mac to send it.`;
// null on the Wi-Fi route and the Admin page, where any size goes.
const fileMaxFor = (req, mac) => (!mac && fromConnector(req) ? CONNECTOR_FILE_MAX : null);

function uploadName(header) {
  let name = '';
  try { name = decodeURIComponent(header ?? ''); } catch {}
  name = name.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim().slice(-200);
  return name || 'file';
}

function readBody(req) {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    return Promise.reject(httpError(415, 'Send the body as JSON with content-type: application/json.'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) { reject(httpError(413, 'A message can hold at most 64 KB of text. Send longer text as a file.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(httpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const isMessage = (m) => Number.isSafeInteger(m?.seq) && Number.isFinite(m.at) && typeof m.text === 'string'
  && typeof m.from?.key === 'string' && (m.to === null || typeof m.to?.key === 'string') && Array.isArray(m.files);

// One JSON message per line. Appends are cheap; a delete or hide rewrites the file.
function openStore(file) {
  let list = [];
  try {
    list = fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      try { const m = JSON.parse(line); return isMessage(m) ? [m] : []; } catch { return []; }
    });
    fs.chmodSync(file, 0o600);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  function save() {
    fs.writeFileSync(`${file}.tmp`, list.map((m) => JSON.stringify(m) + '\n').join(''), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  return {
    list: () => list,
    get: (seq) => list.find((m) => m.seq === seq),
    // seq follows the clock, so a reconnecting page's cursor from before Clear all never hides newer messages.
    add(fields) {
      const now = Date.now();
      const m = { seq: Math.max((list.at(-1)?.seq ?? 0) + 1, now), at: now, ...fields };
      list.push(m);
      fs.appendFileSync(file, JSON.stringify(m) + '\n', { mode: 0o600 });
      return m;
    },
    remove(gone) {
      const set = new Set(gone);
      list = list.filter((m) => !set.has(m));
      save();
    },
    save,
  };
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

const MAC = { key: 'mac', kind: 'mac', name: 'Mac', since: 0 };
const isOwner = (p) => p.kind === 'mac' || p.kind === 'device';
const deviceParticipant = (d) => ({ key: `device:${d.id}`, kind: 'device', name: d.name, since: 0, code: d.id.slice(-4) });
const grantParticipant = (g) => ({ key: `grant:${g.id}`, kind: g.role === 'developer' ? 'collaborator' : 'guest', name: g.label, since: g.createdAt });
const identity = ({ key, kind, name }) => ({ key, kind, name });

// Everyone in Messages: the Mac (the Admin page), each owner device, and each collaborator or guest grant in use.
// `rejectUpgrade(socket, status, text)` is the server's upgrade refusal; `wss` pings and closes its sockets.
// `statfs` is fs.promises.statfs, replaceable in tests.
export function createMessages({ auth, collaborators, config, wss, rejectUpgrade, stateDir = STATE_DIR, statfs = fsp.statfs }) {
  const dir = privateDir(path.join(stateDir, 'messages'));
  const filesDir = privateDir(path.join(dir, 'files'));
  const thumbsDir = privateDir(path.join(dir, 'thumbs'));
  const store = openStore(path.join(dir, 'messages.jsonl'));
  const reserve = () => {
    const gb = config.read().messagesReserveGB;
    return (Number.isInteger(gb) && gb >= 0 ? gb : DEFAULT_RESERVE_GB) * GB;
  };
  async function freeBytes() {
    const { bavail, bsize } = await statfs(filesDir);
    return bavail * bsize;
  }
  async function limits(req, mac) {
    const free = await freeBytes();
    return { fileMax: fileMaxFor(req, mac), largeFile: LARGE_FILE, lowSpace: free < reserve(), freeBytes: free, reserveBytes: reserve() };
  }
  // The refusal for a file of `size` bytes so far (`more` still to come), or null.
  async function diskRefusal(size, more = 0) {
    const free = await freeBytes();
    if (size + more > LARGE_FILE && free < reserve()) {
      return `Your Mac is low on space (${sizeText(free)} free). Files over 50 MB are paused until there's more than ${sizeText(reserve())} free. Text and files up to 50 MB still work.`;
    }
    if (free - more < DISK_FLOOR) return `Your Mac is almost out of space (${sizeText(free)} free). Free up space on the Mac or delete messages.`;
    return null;
  }

  // Collaborator and guest pages see people by this id, never by device id, whose last four digits are the device code.
  const secretFile = path.join(dir, 'secret');
  let secret;
  try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch {}
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, secret + '\n', { mode: 0o600 });
  }
  const pub = (key) => crypto.createHmac('sha256', secret).update(key).digest('hex').slice(0, 16);

  // Uploaded but not sent yet: id -> { owner, at, meta }. A restart forgets them, so their files go at startup.
  const pending = new Map();
  const referenced = new Set(store.list().flatMap((m) => m.files.map((f) => f.id)));
  let usage = 0;
  for (const name of fs.readdirSync(filesDir)) {
    if (referenced.has(name)) usage += fs.statSync(path.join(filesDir, name)).size;
    else fs.rmSync(path.join(filesDir, name), { force: true });
  }

  function dropFile(f) {
    fs.rmSync(path.join(filesDir, f.id), { force: true });
    fs.rmSync(path.join(thumbsDir, `thumb-${f.id}.jpg`), { force: true });
    usage -= f.size;
  }
  function sweepPending() {
    for (const [id, p] of pending) {
      if (Date.now() - p.at < PENDING_MS) continue;
      pending.delete(id);
      dropFile(p.meta);
    }
  }

  async function people() {
    const { devices, roleAccessEnabled } = auth.admin.state();
    const owners = devices.filter((d) => d.status === 'active' && (!roleAccessEnabled || d.role === 'admin')).map(deviceParticipant);
    const { body } = await collaborators.ownerApi('GET', '/api/collaborators');
    return [MAC, ...owners, ...body.collaborators.filter((g) => g.status === 'active').map(grantParticipant)];
  }

  const canSee = (v) => (m) => m.at >= v.since && !m.hiddenFor?.includes(v.key)
    && (m.to === null || m.to.key === v.key || m.from.key === v.key);
  const personView = (v) => (p) => ({ id: pub(p.key), name: p.name, kind: p.kind, ...(isOwner(v) && p.code && { code: p.code }) });
  function messageView(m, v) {
    const mine = m.from.key === v.key;
    return {
      seq: m.seq, at: m.at, text: m.text, mine, canDelete: mine || isOwner(v),
      chat: m.to === null ? 'everyone' : pub(mine ? m.to.key : m.from.key),
      from: { id: pub(m.from.key), name: m.from.name, kind: m.from.kind },
      to: m.to && { id: pub(m.to.key), name: m.to.name, kind: m.to.kind },
      files: m.files.map(({ id, name, size, kind }) => ({ id, name, size, kind })),
    };
  }
  async function directory(v) {
    return { you: personView(v)(v), people: (await people()).filter((p) => p.key !== v.key).map(personView(v)) };
  }
  function sync(v, after) {
    const seen = store.list().filter(canSee(v));
    return { messages: seen.filter((m) => m.seq > after).map((m) => messageView(m, v)), keep: seen.map((m) => m.seq) };
  }

  const sockets = new Map();
  function deliver(m) {
    for (const [ws, v] of sockets) {
      if (ws.readyState === ws.OPEN && canSee(v)(m)) ws.send(JSON.stringify({ t: 'message', message: messageView(m, v) }));
    }
  }
  // Called before the messages change, while their viewers can still be worked out.
  function retract(list, only = () => true) {
    for (const [ws, v] of sockets) {
      const seqs = list.filter(canSee(v)).map((m) => m.seq);
      if (seqs.length && only(v) && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'removed', seqs }));
    }
  }
  function removeMessages(list) {
    retract(list);
    store.remove(list);
    for (const m of list) for (const f of m.files) dropFile(f);
  }

  // People are matched by id; the Mac's CLI may also name a device by its code or anyone by name.
  async function findPerson(v, query, loose) {
    const others = (await people()).filter((p) => p.key !== v.key);
    const exact = others.find((p) => pub(p.key) === query) ?? (loose && others.find((p) => p.code === query));
    if (exact) return exact;
    const named = loose ? others.filter((p) => p.name.toLowerCase() === String(query).toLowerCase()) : [];
    if (named.length === 1) return named[0];
    if (named.length > 1) throw httpError(409, `${named.length} people are named "${query}". Use a device code: ${named.map((p) => p.code ?? '(none)').join(', ')}.`);
    throw httpError(404, `Nobody in Messages matches "${query}".`);
  }

  async function send({ v, req, mac }) {
    const body = await readBody(req);
    const { text = '', files: ids = [] } = body;
    if (typeof text !== 'string') throw httpError(400, 'text must be a string.');
    if (Buffer.byteLength(text) > TEXT_MAX) throw httpError(413, 'A message can hold at most 64 KB of text. Send longer text as a file.');
    if (!Array.isArray(ids) || ids.length > FILES_PER_MESSAGE) throw httpError(400, `Attach up to ${FILES_PER_MESSAGE} files to one message.`);
    const files = [...new Set(ids)].map((id) => {
      const p = pending.get(id);
      if (p?.owner !== v.key) throw httpError(400, 'An attachment is missing. Attach it again.');
      return p.meta;
    });
    if (!text.trim() && !files.length) throw httpError(400, 'Write a message or attach a file.');
    const to = body.to == null || body.to === 'everyone' ? null : await findPerson(v, body.to, mac);
    for (const f of files) pending.delete(f.id);
    const m = store.add({ from: identity(v), to: to && identity(to), text, files });
    deliver(m);
    return [201, messageView(m, v)];
  }

  async function upload({ v, req, res, mac }) {
    sweepPending();
    const max = fileMaxFor(req, mac);
    const refuse = (status, error) => {
      res.setHeader('connection', 'close');
      return [status, { error }];
    };
    const declared = Number(req.headers['content-length']) || 0;
    const low = await diskRefusal(0, declared);
    let refusal = max !== null && declared > max ? [413, overInternet(declared)] : low && [507, low];
    if (refusal && declared > DRAIN_MAX) return refuse(...refusal);
    const id = crypto.randomBytes(12).toString('hex');
    const part = path.join(filesDir, `${id}.part`);
    const handle = await fsp.open(part, 'wx', 0o600);
    let size = 0, unchecked = 0, refusedAt = 0;
    try {
      await pipeline(req, async function* (chunks) {
        for await (const chunk of chunks) {
          size += chunk.length;
          if (refusal) {
            if (size - refusedAt > DRAIN_MAX) throw new Error(refusal[1]);
            continue;
          }
          if (max !== null && size > max) refusal = [413, overInternet(declared)];
          unchecked += chunk.length;
          if (!refusal && (unchecked >= DISK_CHECK_BYTES || (size > LARGE_FILE && size - chunk.length <= LARGE_FILE))) {
            unchecked = 0;
            const full = await diskRefusal(size);
            if (full) refusal = [507, full];
          }
          if (refusal) refusedAt = size;
          else yield chunk;
        }
      }, handle.createWriteStream());
    } catch (err) {
      await fsp.rm(part, { force: true });
      if (refusal) return refuse(...refusal);
      throw err;
    }
    if (refusal) {
      await fsp.rm(part, { force: true });
      return refuse(...refusal);
    }
    const head = Buffer.alloc(64);
    const rfd = fs.openSync(part, 'r');
    const n = fs.readSync(rfd, head, 0, head.length, 0);
    fs.closeSync(rfd);
    fs.renameSync(part, path.join(filesDir, id));
    usage += size;
    const type = detectType(head.subarray(0, n));
    const meta = { id, name: uploadName(req.headers['x-filename']), size, type, kind: kindOf(type) };
    pending.set(id, { owner: v.key, at: Date.now(), meta });
    return [201, { id, name: meta.name, size, kind: meta.kind }];
  }

  // A file is reachable only through a message its requester can see; nothing here takes a path.
  function attachment(v, id) {
    for (const m of store.list()) {
      const f = m.files.find((x) => x.id === id);
      if (f) return canSee(v)(m) ? f : null;
    }
    return null;
  }

  async function stream(req, res, file, type, disp, headers) {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) throw httpError(404, 'Not found');
    const out = {
      ...headers, 'content-type': type, 'content-disposition': disp, 'accept-ranges': 'bytes', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox',
    };
    const range = rangeOf(req.headers.range, st.size);
    if (range.status === 416) {
      res.writeHead(416, { ...out, 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    if (range.status === 206) out['content-range'] = `bytes ${range.start}-${range.end}/${st.size}`;
    out['content-length'] = st.size === 0 ? 0 : range.end - range.start + 1;
    res.writeHead(range.status, out);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    await pipeline(fs.createReadStream(file, { start: range.start, end: range.end }), res);
  }

  function serveFile({ v, req, res, url, match, headers }) {
    const f = attachment(v, match[1]);
    if (!f) throw httpError(404, 'Not found');
    const inline = Boolean(INLINE[f.type]) && url.searchParams.get('download') !== '1';
    return stream(req, res, path.join(filesDir, f.id), inline ? f.type : 'application/octet-stream', disposition(inline ? 'inline' : 'attachment', f.name), headers);
  }

  // thumbnailOf treats an existing file as done, so a second request during sips would read a half-written JPEG.
  const thumbs = new Map();
  async function serveThumb({ v, req, res, match, headers }) {
    const f = attachment(v, match[1]);
    if (f?.kind !== 'image') throw httpError(404, 'Not found');
    const source = path.join(filesDir, f.id);
    let thumb = null;
    if (f.type !== 'image/gif') {
      if (!thumbs.has(f.id)) thumbs.set(f.id, thumbnailOf(thumbsDir, f.id, source).finally(() => thumbs.delete(f.id)));
      thumb = await thumbs.get(f.id);
    }
    if (thumb) {
      fs.chmodSync(thumb, 0o600);
      return stream(req, res, thumb, 'image/jpeg', 'inline', headers);
    }
    if (!INLINE[f.type] || f.size > ORIGINAL_PREVIEW_MAX) throw httpError(404, 'No preview for this image');
    return stream(req, res, source, f.type, 'inline', headers);
  }

  function visibleMessage(v, match) {
    const m = store.get(Number(match[1]));
    if (!m || !canSee(v)(m)) throw httpError(404, 'No such message');
    return m;
  }

  function remove({ v, match }) {
    const m = visibleMessage(v, match);
    if (!isOwner(v) && m.from.key !== v.key) throw httpError(403, 'Only the sender or the owner can delete this message. Hide it instead.');
    removeMessages([m]);
    return [204];
  }

  function hide({ v, match }) {
    const m = visibleMessage(v, match);
    retract([m], (viewer) => viewer.key === v.key);
    m.hiddenFor = [...(m.hiddenFor ?? []), v.key];
    store.save();
    return [204];
  }

  const chatOf = (m) => (m.to === null ? 'everyone' : [pub(m.from.key), pub(m.to.key)].sort().join('.'));
  async function storage() {
    const chats = new Map();
    for (const m of store.list()) {
      const id = chatOf(m);
      const c = chats.get(id) ?? { id, title: m.to === null ? 'Everyone' : `${m.from.name} and ${m.to.name}`, count: 0, bytes: 0 };
      c.count++;
      c.bytes += m.files.reduce((n, f) => n + f.size, 0);
      chats.set(id, c);
    }
    return [200, { usage, ...(await limits(null, true)), chats: [...chats.values()] }];
  }

  async function clear({ req }) {
    const { chat } = await readBody(req);
    if (chat !== undefined && typeof chat !== 'string') throw httpError(400, 'chat must be a chat id.');
    const gone = store.list().filter((m) => chat === undefined || chatOf(m) === chat);
    removeMessages(gone);
    auth.admin.log('messages-cleared', { chat: chat === undefined ? 'all' : chat === 'everyone' ? 'everyone' : 'direct', count: gone.length });
    return [200, { removed: gone.length, usage }];
  }

  const ROUTES = [
    ['GET', /^$/, async ({ v, req, url, mac }) => [200, {
      ...(await directory(v)), limits: await limits(req, mac), ...sync(v, Number(url.searchParams.get('after')) || 0),
    }]],
    ['GET', /^people$/, async ({ v }) => [200, await directory(v)]],
    ['POST', /^$/, send],
    ['POST', /^files$/, upload],
    ['GET', /^files\/([0-9a-f]{24})$/, serveFile],
    ['HEAD', /^files\/([0-9a-f]{24})$/, serveFile],
    ['GET', /^files\/([0-9a-f]{24})\/thumb$/, serveThumb],
    ['DELETE', /^(\d+)$/, remove],
    ['POST', /^(\d+)\/hide$/, hide],
    ['GET', /^storage$/, storage, 'mac'],
    ['POST', /^clear$/, clear, 'mac'],
  ];

  // Phone and guest requests (identified by their cookie), and the Admin page's (`mac`, with its security `headers`).
  async function handleApi(req, res, { mac = false, headers = {} } = {}) {
    const json = (status, body) => {
      res.writeHead(status, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const rest = url.pathname.replace(/^\/api\/messages\/?/, '');
      let v = MAC;
      if (!mac) {
        const guest = collaborators.guest(req);
        if (guest) {
          if (!guest.active) throw httpError(403, GUEST_GONE);
          // Registered like a file transfer, so revoking or expiring the grant cuts a download short.
          collaborators.scope(req, res);
          v = grantParticipant(guest.grant);
        } else {
          const device = auth.deviceFor(req);
          if (!device) throw httpError(401, 'Not logged in');
          v = deviceParticipant(device);
        }
      }
      for (const [method, re, handler, only] of ROUTES) {
        const match = req.method === method && re.exec(rest);
        if (!match) continue;
        if (only === 'mac' && !mac) throw httpError(403, 'Only the Admin page on the Mac can do this.');
        const reply = await handler({ v, req, res, url, match, mac, headers });
        if (reply) json(...reply);
        return;
      }
      json(404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) json(err.status ?? 400, { error: err.message });
      else res.destroy();
    }
  }

  function handleUpgrade(req, socket, head) {
    if (!sameOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    const guest = collaborators.guest(req);
    const device = guest ? null : auth.deviceFor(req);
    if (guest && !guest.active) return rejectUpgrade(socket, 403, 'Forbidden');
    if (!guest && !device) return rejectUpgrade(socket, 401, 'Unauthorized');
    const v = guest ? grantParticipant(guest.grant) : deviceParticipant(device);
    const after = Number(new URL(req.url, 'http://localhost').searchParams.get('after')) || 0;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Revoking, blocking or lockdown closes the socket: auth tracks device sockets, and a grant's transfers end with it.
      try {
        if (guest) collaborators.scope(req, { destroy: () => ws.terminate(), once: (event, fn) => ws.once(event, fn) });
        else auth.trackSocket(device, ws);
      } catch {
        return ws.close(4403, GUEST_GONE);
      }
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg?.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
      });
      sockets.set(ws, v);
      ws.on('close', () => sockets.delete(ws));
      Promise.all([directory(v), limits(req, false)]).then(([dir, lim]) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'hello', ...dir, limits: lim, ...sync(v, after) }));
      }, () => ws.close(1011, 'Could not load messages'));
    });
  }

  return { handleApi, handleUpgrade };
}
