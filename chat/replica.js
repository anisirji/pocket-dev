import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IMAGE_FILE_RE, CONTENT_TYPE, ATTACHMENT_NAME_RE, ATTACHMENT_TYPES } from './tool-images.js';
import { BLOB_MAX } from '../room-sync.js';

const FLUSH_MS = Number(process.env.POCKET_DEV_CHAT_SYNC_MS) || 500;
const MAX_WAIT_MS = FLUSH_MS * 4;
const CHANGE_MAX = 40_000; // a sync push body may not pass 64 KB
const RESCAN_MS = Number(process.env.POCKET_DEV_TASK_SYNC_MS) || 30_000;
const httpError = (status, message) => Object.assign(new Error(message), { status });
const levelOf = (info, device) => info?.members.find((m) => m.deviceId === device)?.level;

// Chats shared in a room. The device that owns a chat is its only writer; every other room device keeps a read-only
// mirror in the "chats" sync-log channel. Keys: "<device>/<chatId>" (the chat) and "<device>/<chatId>/<eventId>" (one
// event). Only settled values go out: a streaming event waits until it is done, and a burst of changes is sent once after
// a short quiet time. A device whose owner gave the others the admin level shares its chats with all of them; a device at
// collaborator level shares none (collaborators never get AI chats). Pictures and attachments travel as metadata inside
// the event (`blobs`), and the bytes are fetched when somebody opens one.
export function createChatReplica({ room, roomSync, chats, stateDir }) {
  const blobDir = path.join(stateDir, 'room-chat-blobs');
  const mine = () => room.deviceId();
  const eligible = () => levelOf(room.peers(), mine()) === 'admin';

  // ---- the owning device ----
  const states = new Map(); // chatId -> { dirty, full, timer, first, running, known, seen }
  const stateOf = (id) => {
    if (!states.has(id)) states.set(id, { dirty: new Set(), full: true, timer: null, first: 0, running: false, known: null, seen: 0 });
    return states.get(id);
  };
  const sums = new Map(); // file -> { key, sha256 }

  async function hashOf(file, st) {
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = sums.get(file);
    if (hit?.key === key) return hit.sha256;
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    sums.set(file, { key, sha256 });
    return sha256;
  }
  async function blobMeta(file, type) {
    const st = file && fs.statSync(file, { throwIfNoEntry: false });
    if (!st?.isFile() || !type) return { missing: true };
    if (st.size > BLOB_MAX) return { size: st.size, type, tooLarge: true };
    return { size: st.size, type, sha256: await hashOf(file, st) };
  }
  async function describe(chat, ev) {
    const copy = { ...ev };
    const blobs = {};
    if (ev.type === 'user-text' && Array.isArray(ev.attachments)) {
      copy.attachments = ev.attachments.map((p) => path.basename(p));
      for (const [i, p] of ev.attachments.entries()) blobs[`att:${ev.id}.${i}`] = await blobMeta(p, ATTACHMENT_TYPES[path.extname(p).toLowerCase()]);
    }
    if (Array.isArray(ev.images)) {
      for (const name of ev.images) blobs[`img:${name}`] = await blobMeta(IMAGE_FILE_RE.test(name) ? path.join(chat.imageDir, name) : null, CONTENT_TYPE[path.extname(name).slice(1)]);
    }
    if (Object.keys(blobs).length) copy.blobs = blobs;
    for (let i = 0; i < 20 && JSON.stringify(copy).length > CHANGE_MAX; i++) {
      const [field] = Object.entries(copy).filter(([, v]) => typeof v === 'string').sort((a, b) => b[1].length - a[1].length)[0] ?? [];
      if (!field) break;
      copy[field] = copy[field].slice(0, Math.floor(copy[field].length / 2));
      copy.truncated = true;
    }
    return copy;
  }

  const keyOf = (chatId, evId) => `${mine()}/${chatId}${evId ? `/${evId}` : ''}`;
  // Events already shared, so ones that left the 1500-event window can be removed from the mirrors.
  function knownOf(chatId, st) {
    if (!st.known) {
      const prefix = `${keyOf(chatId)}/`;
      st.known = new Set([...channel.log().state().keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
    }
    return st.known;
  }
  function put(key, value) {
    const log = channel.log();
    const prev = log.get(key);
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(value)) return false;
    log.append({ type: 'chat', key, value });
    return true;
  }
  const metaOf = (chat) => ({ id: chat.id, deviceId: mine(), tool: chat.tool, title: chat.title, cwd: chat.cwd, status: chat.status, createdAt: chat.createdAt, updatedAt: chat.updatedAt });

  async function flush(chat) {
    const st = stateOf(chat.id);
    st.timer = null; st.first = 0;
    if (st.running || chat.closed || !eligible()) return;
    st.running = true;
    try {
      const full = st.full;
      st.full = false;
      st.seen = chat.updatedAt;
      const ids = full ? chat.events.map((e) => e.id) : [...st.dirty];
      st.dirty.clear();
      const known = knownOf(chat.id, st);
      let wrote = false;
      for (const id of ids) {
        const ev = chat.find(id);
        if (!ev || ev.streaming) continue;
        if (put(keyOf(chat.id, id), await describe(chat, ev))) wrote = true;
        known.add(id);
      }
      const present = new Set(chat.events.map((e) => e.id));
      for (const id of [...known]) {
        if (present.has(id)) continue;
        channel.log().remove('chat', keyOf(chat.id, id));
        known.delete(id);
        wrote = true;
      }
      if (put(keyOf(chat.id), metaOf(chat))) wrote = true;
      if (wrote) channel.changed();
    } finally {
      st.running = false;
      if (st.dirty.size) schedule(chat);
    }
  }
  function schedule(chat) {
    const st = stateOf(chat.id);
    if (st.running && st.timer) return;
    st.first ||= Date.now();
    clearTimeout(st.timer);
    st.timer = setTimeout(() => flush(chat).catch(() => {}), Math.max(0, Math.min(FLUSH_MS, st.first + MAX_WAIT_MS - Date.now())));
    st.timer.unref?.();
  }
  function removed(chat) {
    const st = stateOf(chat.id);
    clearTimeout(st.timer);
    states.delete(chat.id);
    if (!channel.inRoom() || !eligible()) return;
    const log = channel.log();
    const prefix = `${keyOf(chat.id)}`;
    const keys = [...log.state().keys()].filter((k) => k === prefix || k.startsWith(`${prefix}/`));
    for (const k of keys) log.remove('chat', k);
    if (keys.length) channel.changed();
  }
  function track(chat) {
    chat.listener = {
      event: (id) => { stateOf(chat.id).dirty.add(id); schedule(chat); },
      meta: () => schedule(chat),
      removed: () => removed(chat),
    };
    schedule(chat);
  }
  // A device that joins a room later shares the chats it already has; also catches anything a flush missed.
  function scanAll() {
    if (!eligible()) return;
    for (const chat of chats.values()) {
      const st = stateOf(chat.id);
      if (st.seen !== chat.updatedAt || st.full) { st.full = true; schedule(chat); }
    }
  }
  function start() {
    setTimeout(scanAll, 500).unref();
    setInterval(scanAll, RESCAN_MS).unref();
  }

  // Bytes of a picture or attachment of one of this device's chats.
  async function shareBlob({ chat: chatId, id }) {
    const chat = chats.get(chatId);
    if (!chat || typeof id !== 'string') throw httpError(404, 'Not found');
    let file = null, type = null;
    if (id.startsWith('img:') && IMAGE_FILE_RE.test(id.slice(4))) {
      file = path.join(chat.imageDir, id.slice(4));
      type = CONTENT_TYPE[path.extname(id).slice(1)];
    } else if (id.startsWith('att:') && ATTACHMENT_NAME_RE.test(id.slice(4))) {
      const [, evId, n] = ATTACHMENT_NAME_RE.exec(id.slice(4));
      const ev = chat.find(evId);
      file = ev?.type === 'user-text' ? ev.attachments?.[Number(n)] : null;
      type = file && ATTACHMENT_TYPES[path.extname(file).toLowerCase()];
    }
    const st = type && fs.statSync(file, { throwIfNoEntry: false });
    if (!st?.isFile()) throw httpError(404, 'Not found');
    if (st.size > BLOB_MAX) throw httpError(413, 'Too large to copy to another device.');
    return { type, data: await fs.promises.readFile(file) };
  }

  // ---- the mirrors ----
  const mirror = new Map(); // "<device>/<chatId>" -> { meta, events: Map }
  let built = false;
  function take(key) {
    const parts = key.split('/');
    if (parts.length < 2 || parts.length > 3) return;
    const value = channel.log().get(key);
    const chatKey = `${parts[0]}/${parts[1]}`;
    if (parts.length === 2) {
      if (value === undefined) mirror.delete(chatKey);
      else mirror.set(chatKey, { meta: value, events: mirror.get(chatKey)?.events ?? new Map() });
      return;
    }
    // An event can arrive before its chat; keep it until the chat shows up.
    const entry = mirror.get(chatKey) ?? { meta: null, events: new Map() };
    if (value === undefined) entry.events.delete(parts[2]); else entry.events.set(parts[2], value);
    if (entry.meta || entry.events.size) mirror.set(chatKey, entry);
  }
  function build() {
    if (built) return;
    built = true;
    for (const key of channel.log().state().keys()) take(key);
  }
  const clearMirror = () => { mirror.clear(); built = false; fs.rmSync(blobDir, { recursive: true, force: true }); };

  const channel = roomSync.register('chats', {
    shares: (origin, _to, info) => levelOf(info, origin) === 'admin',
    accept: (c, info) => c.type === 'chat' && c.key.startsWith(`${c.device}/`) && levelOf(info, c.device) === 'admin'
      && (c.deleted || (c.value && typeof c.value === 'object')),
    onApplied: (added) => { if (built) for (const c of added) if (c.type === 'chat') take(c.key); },
    onClear: clearMirror,
    blob: shareBlob,
  });

  function visible() {
    build();
    const info = room.peers();
    if (!info) return [];
    return [...mirror.values()].filter((e) => e.meta && e.meta.deviceId !== mine() && levelOf(info, e.meta.deviceId) === 'admin');
  }
  const summary = (e) => ({
    deviceId: e.meta.deviceId, deviceName: room.peers().members.find((m) => m.deviceId === e.meta.deviceId)?.name, chatId: e.meta.id,
    title: e.meta.title, tool: e.meta.tool, cwd: e.meta.cwd, status: e.meta.status, createdAt: e.meta.createdAt, updatedAt: e.meta.updatedAt,
    eventCount: e.events.size, readOnly: true,
  });
  const find = (deviceId, chatId) => visible().find((e) => e.meta.deviceId === deviceId && e.meta.id === chatId) || (() => { throw httpError(404, 'No such chat.'); })();

  async function blobOf(deviceId, chatId, id) {
    const entry = find(deviceId, chatId);
    const meta = [...entry.events.values()].map((e) => e.blobs?.[id]).find(Boolean);
    if (!meta || meta.missing) throw httpError(404, 'No such file.');
    if (meta.tooLarge) throw httpError(413, 'This file is too large to copy here. Open it on the device that has it.');
    const cached = path.join(blobDir, meta.sha256);
    if (!fs.existsSync(cached)) {
      const b = await channel.fetchBlob(deviceId, { chat: chatId, id });
      if (crypto.createHash('sha256').update(b.data).digest('hex') !== meta.sha256) throw httpError(502, 'The copy did not match the original.');
      fs.mkdirSync(blobDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${cached}.part`, b.data, { mode: 0o600 });
      fs.renameSync(`${cached}.part`, cached);
    }
    return { type: meta.type, file: cached };
  }

  // GET /api/room/chats, /api/room/chats/:device/:chat, /api/room/chats/:device/:chat/blob/:id  (login already checked)
  async function handleApi(req, res, url, sendJson) {
    const [, , , , deviceId, chatId, action, blobId] = url.pathname.split('/');
    try {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Mirrored chats are read-only.' });
      if (!room.peers()) throw httpError(409, 'This device is not in a room.');
      if (!deviceId) return sendJson(res, 200, { chats: visible().map(summary).sort((a, b) => b.updatedAt - a.updatedAt) });
      if (!chatId) throw httpError(404, 'Not found');
      if (!action) {
        const entry = find(deviceId, chatId);
        return sendJson(res, 200, { ...summary(entry), events: [...entry.events.values()].sort((a, b) => a.seq - b.seq) });
      }
      if (action === 'blob' && blobId) {
        const { type, file } = await blobOf(deviceId, chatId, decodeURIComponent(blobId));
        const inline = type?.startsWith('image/');
        res.writeHead(200, { 'content-type': inline ? type : 'application/octet-stream', 'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', ...(inline ? {} : { 'content-disposition': 'attachment' }) });
        return fs.createReadStream(file).pipe(res);
      }
      throw httpError(404, 'Not found');
    } catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
  }

  return { track, start, handleApi };
}
