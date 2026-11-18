import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EVENTS_MAX = 1500;
const TITLE_MAX = 80;
const PERSIST_DELAY_MS = 1000;
export const QUEUE_MAX = 20;

const PERSISTED = ['id', 'tool', 'cwd', 'settings', 'sessionId', 'title', 'createdAt', 'updatedAt', 'grants', 'seq', 'events', 'failed', 'turnStartedAt', 'acceptedInputs', 'handoffSeq', 'handoffFrom', 'handoffDigest', 'sessionRefs', 'nativeReleased', 'nativeSessionStartSeq'];

// One conversation. Status is derived from three independent facts (engine awake, turn running, open requests)
// so it can never disagree with them.
export class Chat {
  constructor(data, file) {
    Object.assign(this, {
      title: 'New chat', sessionId: null, grants: [], seq: 0, events: [], failed: false, turnStartedAt: null, acceptedInputs: [], handoffSeq: null, handoffFrom: null, handoffDigest: null, sessionRefs: [], nativeReleased: false, nativeSessionStartSeq: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    }, data);
    this.file = file;
    this.engine = null;
    this.pendingModel = null;
    this.waking = false;
    this.turn = null;
    this.queue = [];
    this.afterTurn = null;
    this.requests = new Map();
    this.clients = new Set();
    this.closed = false;
    this.lastActive = Date.now();
    this.persistTimer = null;
    this.listener = null; // room replication: event(id), meta(), removed()
  }

  static create(fields, dir) {
    const id = crypto.randomBytes(6).toString('hex');
    return new Chat({ id, ...fields }, path.join(dir, `${id}.json`));
  }

  // A turn that was running when the server died can never finish, and its open requests can never be answered.
  static load(file) {
    const chat = new Chat(JSON.parse(fs.readFileSync(file, 'utf8')), file);
    for (const ev of chat.events) {
      if (ev.streaming) ev.streaming = false;
      // The queue lived in memory, so a message still waiting when the server stopped was never sent.
      if (ev.queued) Object.assign(ev, { queued: false, notSent: true });
      if ((ev.type === 'permission-request' || ev.type === 'question') && !ev.resolution) ev.resolution = { cancelled: true };
      if ((ev.type === 'tool-run' || ev.type === 'file-edit') && ev.status === 'running') ev.status = 'error';
    }
    if (chat.turnStartedAt) {
      chat.turnStartedAt = null;
      chat.failed = true;
      chat.emit({ type: 'error', message: 'Pocket Dev restarted while this turn was running.' });
    }
    return chat;
  }

  get status() {
    if (this.closed) return 'closed';
    const first = this.requests.values().next().value;
    if (first) return first.event.type === 'question' ? 'waiting-answer' : 'waiting-permission';
    if (this.turn) return 'running';
    if (this.failed) return 'error';
    if (!this.engine && this.sessionId) return 'sleeping';
    return 'idle';
  }

  view() {
    const { id, tool, title, cwd, settings, sessionId, createdAt, updatedAt, waking } = this;
    const pendingId = this.requests.keys().next().value ?? null;
    return {
      id, tool, title, cwd, settings, sessionId, createdAt, updatedAt, waking,
      sessionRefs: this.sessionRefs, nativeReleased: this.nativeReleased,
      queued: this.queue.length, status: this.status, runningSince: this.turn?.startedAt ?? null, pending: pendingId !== null, pendingId,
      capabilities: { queueEdit: true },
    };
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  touch() {
    this.updatedAt = this.lastActive = Date.now();
    this.schedulePersist();
    this.listener?.meta();
  }

  changed() {
    this.touch();
    this.broadcast({ t: 'chat', chat: this.view() });
    this.persist();
  }

  find(id) {
    return this.events.find((ev) => ev.id === id);
  }

  emit(fields) {
    // An answer records which engine wrote it, so a chat that changed engines reads correctly afterwards.
    const ev = { id: fields.id ?? crypto.randomBytes(6).toString('hex'), seq: ++this.seq, at: Date.now(), ...(fields.type === 'assistant-text' ? { tool: this.tool } : {}), ...fields };
    this.events.push(ev);
    // Text is the durable conversation. Bound diagnostic events without discarding messages.
    let excess = this.events.length - EVENTS_MAX;
    if (excess > 0) this.events = this.events.filter((event) => {
      if (excess > 0 && !['user-text', 'assistant-text'].includes(event.type)) { excess--; return false; }
      return true;
    });
    this.broadcast({ t: 'event', event: ev });
    this.touch();
    this.listener?.event(ev.id);
    return ev;
  }

  update(id, patch) {
    const ev = this.find(id);
    if (!ev) return null;
    Object.assign(ev, patch);
    this.broadcast({ t: 'event', event: ev });
    this.touch();
    this.listener?.event(id);
    return ev;
  }

  delta(id, field, d) {
    const ev = this.find(id);
    if (!ev || !d) return;
    ev[field] = (ev[field] ?? '') + d;
    this.broadcast({ t: 'delta', id, field, d });
    this.touch();
    this.listener?.event(id);
  }

  setTitleFrom(text) {
    if (this.title !== 'New chat' || !text.trim()) return;
    const line = text.trim().replace(/\s+/g, ' ');
    this.title = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
  }

  setSession(sessionId) {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.rememberSession();
    this.changed();
  }

  rememberSession() {
    if (this.sessionId && !this.sessionRefs.some((ref) => ref.tool === this.tool && ref.id === this.sessionId)) {
      this.sessionRefs.push({ tool: this.tool, id: this.sessionId });
    }
  }

  // Native files remain the provider's resume source; these events are Pocket Dev's own durable copy for display and
  // cross-provider handoff. Stable native keys plus ordered matching avoid duplicating turns written through Pocket Dev.
  importNativeHistory(messages, note) {
    this.rememberSession();
    const session = `${this.tool}:${this.sessionId}`;
    const occurrences = new Map();
    const normalized = (text) => String(text ?? '').trim();
    const native = messages.filter((message) => ['user', 'assistant'].includes(message.role) && normalized(message.text)).map((message) => {
      const signature = JSON.stringify([message.role, message.text, message.time ?? null]);
      const occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);
      const key = crypto.createHash('sha256').update(`${session}:${signature}:${occurrence}`).digest('hex');
      return { message, key, type: message.role === 'user' ? 'user-text' : 'assistant-text' };
    });
    const known = new Map(this.events.filter((event) => event.nativeKey).map((event) => [event.nativeKey, event]));
    const candidates = this.events.filter((event) => !event.nativeKey && event.seq > this.nativeSessionStartSeq
      && ['user-text', 'assistant-text'].includes(event.type) && !event.queued && !event.notSent && !event.removed
      && (event.type !== 'assistant-text' || !event.tool || event.tool === this.tool));
    let candidateAt = 0;
    let changed = false;
    for (const item of native) {
      item.event = known.get(item.key);
      if (item.event) continue;
      const found = candidates.findIndex((event, index) => index >= candidateAt && event.type === item.type
        && normalized(event.text) === normalized(item.message.text));
      if (found >= 0) {
        item.event = candidates[found];
        candidateAt = found + 1;
        item.event.nativeKey = item.key;
        changed = true;
      }
    }
    const cutoffId = this.events.find((event) => event.seq === this.handoffSeq)?.id;
    const startId = this.events.find((event) => event.seq === this.nativeSessionStartSeq)?.id;
    let reordered = false;
    for (let index = 0; index < native.length; index++) {
      const item = native[index];
      if (item.event) continue;
      const at = Date.parse(item.message.time);
      item.event = { id: crypto.randomBytes(6).toString('hex'), seq: ++this.seq, at: Number.isFinite(at) ? at : Date.now(),
        type: item.type, text: item.message.text, tool: this.tool, nativeKey: item.key, imported: true };
      const next = native.slice(index + 1).find((later) => later.event && this.events.includes(later.event));
      if (next) { this.events.splice(this.events.indexOf(next.event), 0, item.event); reordered = true; }
      else this.events.push(item.event);
      changed = true;
    }
    if (note && !this.events.some((event) => event.nativeNote === session)) {
      this.events.push({ id: crypto.randomBytes(6).toString('hex'), seq: ++this.seq, at: Date.now(), type: 'status', text: note, nativeNote: session });
      changed = true;
    }
    if (reordered) {
      this.events.forEach((event, index) => { event.seq = index + 1; });
      this.seq = this.events.length;
      if (cutoffId) this.handoffSeq = this.events.find((event) => event.id === cutoffId).seq;
      if (startId) this.nativeSessionStartSeq = this.events.find((event) => event.id === startId).seq;
    }
    if (changed) {
      this.changed();
      this.broadcast({ t: 'hello', chat: this.view(), events: this.events });
    }
    return changed;
  }

  startTurn() {
    this.turn = { startedAt: Date.now(), interrupted: false };
    this.turnStartedAt = this.turn.startedAt;
    this.failed = false;
    this.changed();
  }

  endTurn({ status, durationMs, costUsd, usage }) {
    if (!this.turn) return;
    const interrupted = this.turn.interrupted;
    this.turn = null;
    this.turnStartedAt = null;
    this.failed = status === 'failed';
    this.cancelRequests();
    for (const ev of this.events) if (ev.status === 'running') this.update(ev.id, { status: 'stopped' });
    const finalStatus = interrupted && status !== 'done' ? 'interrupted' : status;
    this.emit({ type: 'result', status: finalStatus, durationMs, costUsd, usage });
    this.changed();
    this.afterTurn?.(finalStatus);
  }

  // Messages typed while a turn runs wait here and go out one per turn, in order.
  enqueue({ text, files }) {
    const ev = this.emit({ type: 'user-text', text, attachments: files.map((f) => f.path), queued: true });
    this.queue.push({ eventId: ev.id, text, files });
    this.changed();
    return ev;
  }

  // The waiting bubble is replaced by a fresh message at the end of the conversation, where it actually went out.
  dequeue() {
    const next = this.queue.shift();
    if (!next) return null;
    this.update(next.eventId, { queued: false, removed: true });
    this.emit({ type: 'user-text', text: next.text, attachments: next.files.map((f) => f.path) });
    this.changed();
    return next;
  }

  unqueue(eventId) {
    const i = this.queue.findIndex((q) => q.eventId === eventId);
    if (i === -1) return false;
    this.queue.splice(i, 1);
    this.update(eventId, { queued: false, removed: true });
    this.changed();
    return true;
  }

  // The queued input and its visible event change together, without changing order or attachments.
  editQueued(eventId, text, expectedText) {
    const next = this.queue.find((q) => q.eventId === eventId);
    if (!next) return 'missing';
    if (next.text !== expectedText && next.text !== text) return 'conflict';
    if (!text.trim() && !next.files.length) return 'empty';
    next.text = text;
    this.update(eventId, { text });
    this.changed();
    return 'saved';
  }

  // After a failed turn the rest are not sent on their own: they stay in the chat marked not sent.
  holdQueue() {
    for (const q of this.queue) this.update(q.eventId, { queued: false, notSent: true });
    this.queue.length = 0;
    this.changed();
  }

  get imageDir() {
    return this.file.replace(/\.json$/, '.images');
  }

  fail(message) {
    this.emit({ type: 'error', message });
    if (this.turn) this.endTurn({ status: 'failed', durationMs: Date.now() - this.turn.startedAt });
    else this.changed();
  }

  // Engines call ask() and wait; the phone answers through answer(). An abort signal or interrupt cancels it.
  ask(fields, signal) {
    const requestId = crypto.randomBytes(6).toString('hex');
    const event = this.emit({ ...fields, requestId, resolution: null });
    return new Promise((resolve) => {
      const finish = (resolution) => {
        if (!this.requests.has(requestId)) return;
        this.requests.delete(requestId);
        this.update(event.id, { resolution });
        this.changed();
        resolve(resolution);
      };
      this.requests.set(requestId, { event, finish });
      signal?.addEventListener('abort', () => finish({ cancelled: true }), { once: true });
      this.changed();
    });
  }

  pendingRequest(requestId) {
    return this.requests.get(requestId)?.event ?? null;
  }

  answer(requestId, resolution) {
    this.requests.get(requestId)?.finish(resolution);
  }

  cancelRequests() {
    for (const { finish } of [...this.requests.values()]) finish({ cancelled: true });
  }

  addGrant(grant) {
    if (!this.grants.includes(grant)) this.grants.push(grant);
  }

  removeGrant(grant) {
    this.grants = this.grants.filter((g) => g !== grant);
  }

  schedulePersist() {
    if (this.persistTimer || this.closed) return;
    this.persistTimer = setTimeout(() => this.persist(), PERSIST_DELAY_MS);
  }

  persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.closed) return;
    const data = Object.fromEntries(PERSISTED.map((k) => [k, this[k]]));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  remove() {
    this.listener?.removed();
    this.closed = true;
    clearTimeout(this.persistTimer);
    this.cancelRequests();
    this.broadcast({ t: 'closed' });
    for (const ws of this.clients) ws.close(1000, 'chat closed');
    this.queue.length = 0;
    fs.rmSync(this.file, { force: true });
    fs.rmSync(this.imageDir, { recursive: true, force: true });
  }
}
