import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EVENTS_MAX = 1500;
const TITLE_MAX = 80;
const PERSIST_DELAY_MS = 1000;

const PERSISTED = ['id', 'tool', 'cwd', 'model', 'mode', 'sessionId', 'title', 'createdAt', 'updatedAt', 'grants', 'seq', 'events', 'failed', 'turnStartedAt'];

// One conversation. Status is derived from three independent facts (engine awake, turn running, open requests)
// so it can never disagree with them.
export class Chat {
  constructor(data, file) {
    Object.assign(this, {
      title: 'New chat', sessionId: null, grants: [], seq: 0, events: [], failed: false, turnStartedAt: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    }, data);
    this.file = file;
    this.engine = null;
    this.waking = false;
    this.turn = null;
    this.requests = new Map();
    this.clients = new Set();
    this.closed = false;
    this.lastActive = Date.now();
    this.persistTimer = null;
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
    const { id, tool, title, cwd, model, mode, sessionId, createdAt, updatedAt, waking } = this;
    const pendingId = this.requests.keys().next().value ?? null;
    return {
      id, tool, title, cwd, model, mode, sessionId, createdAt, updatedAt, waking,
      status: this.status, runningSince: this.turn?.startedAt ?? null, pending: pendingId !== null, pendingId,
    };
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  touch() {
    this.updatedAt = this.lastActive = Date.now();
    this.schedulePersist();
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
    const ev = { id: fields.id ?? crypto.randomBytes(6).toString('hex'), seq: ++this.seq, at: Date.now(), ...fields };
    this.events.push(ev);
    if (this.events.length > EVENTS_MAX) this.events.splice(0, this.events.length - EVENTS_MAX);
    this.broadcast({ t: 'event', event: ev });
    this.touch();
    return ev;
  }

  update(id, patch) {
    const ev = this.find(id);
    if (!ev) return null;
    Object.assign(ev, patch);
    this.broadcast({ t: 'event', event: ev });
    this.touch();
    return ev;
  }

  delta(id, field, d) {
    const ev = this.find(id);
    if (!ev || !d) return;
    ev[field] = (ev[field] ?? '') + d;
    this.broadcast({ t: 'delta', id, field, d });
    this.touch();
  }

  setTitleFrom(text) {
    if (this.title !== 'New chat' || !text.trim()) return;
    const line = text.trim().replace(/\s+/g, ' ');
    this.title = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
  }

  setSession(sessionId) {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.changed();
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
    this.emit({ type: 'result', status: interrupted && status !== 'done' ? 'interrupted' : status, durationMs, costUsd, usage });
    this.changed();
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
    this.closed = true;
    clearTimeout(this.persistTimer);
    this.cancelRequests();
    this.broadcast({ t: 'closed' });
    for (const ws of this.clients) ws.close(1000, 'chat closed');
    fs.rmSync(this.file, { force: true });
  }
}
