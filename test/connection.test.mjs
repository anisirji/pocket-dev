import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../public/connection.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(t, options = {}) {
  const window = new EventTarget(), document = new EventTarget();
  document.hidden = false;
  const navigator = { onLine: true };
  const timers = new Map(), sockets = [], states = [], messages = [];
  let now = 0, nextId = 0;
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    send(raw) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  }
  vm.runInNewContext(source, {
    window, document, navigator, WebSocket, AbortController,
    setTimeout: (fn, ms) => { timers.set(++nextId, { at: now + ms, fn }); return nextId; },
    clearTimeout: (id) => timers.delete(id),
  });
  const connection = new window.PocketDevConnection({ url: () => 'ws://fixture', onState: (s) => states.push(s), onMessage: (m) => messages.push(m), ...options });
  t.after(() => connection.dispose());
  async function tick(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await flush();
    }
    now = end;
    await flush();
  }
  return { window, document, navigator, connection, sockets, states, messages, timers, tick };
}

function draftStore(storage = new Map()) {
  const window = {};
  vm.runInNewContext(source, { window, crypto: webcrypto, Uint8Array });
  return new window.PocketDevDrafts({
    getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key),
  });
}

test('a lost response body or send timeout remains an error so the draft can be retried', async () => {
  const chatSource = fs.readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
  const requests = chatSource.slice(chatSource.indexOf('  async function api('), chatSource.indexOf('  let optionsPromise'));
  let abortRequest, clearCount = 0;
  const runtime = {
    Blob, AbortController, location: { replace: () => assert.fail('unexpected redirect') },
    setTimeout: (fn) => { abortRequest = fn; return 1; }, clearTimeout: () => clearCount++,
    fetch: async () => ({ ok: true, status: 202, json: async () => { throw new DOMException('Lost response body', 'AbortError'); } }),
  };
  vm.createContext(runtime);
  vm.runInContext(`${requests}\nthis.send = sendWithTimeout;`, runtime);
  await assert.rejects(runtime.send('/message', { text: 'keep this' }), /Lost response body/);
  assert.equal(clearCount, 1);
  runtime.fetch = (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError'))));
  const pending = runtime.send('/message', { text: 'keep this too' });
  abortRequest();
  await assert.rejects(pending, /Timed out/);
  assert.equal(clearCount, 2);
});

test('drafts restore after a reload, stay separate by chat, and retain retry identity', () => {
  const storage = new Map();
  const first = draftStore(storage);
  first.save('codex', 'Codex draft', [{ name: 'uploaded.png', path: '/tmp/uploaded.png' }, { name: 'still uploading', path: null }]);
  first.save('claude', 'Claude draft', []);
  const sent = first.submission('codex');
  const restored = draftStore(storage);
  assert.equal(restored.get('codex').text, 'Codex draft');
  assert.equal(restored.get('claude').text, 'Claude draft');
  assert.equal(restored.get('codex').files.length, 1, 'only uploaded files survive a page reload');
  assert.equal(restored.submission('codex').clientMessageId, sent.clientMessageId, 'a lost response can be retried without a second message');
  restored.save('codex', 'A different message', []);
  assert.notEqual(restored.submission('codex').clientMessageId, sent.clientMessageId);
});

test('a late send acknowledgement preserves another chat and anything typed or attached since sending', () => {
  const drafts = draftStore();
  const oldFile = { name: 'first', path: '/tmp/first' };
  const newFile = { name: 'second', path: '/tmp/second' };
  drafts.save('a', 'send this', [oldFile]);
  const sent = drafts.submission('a');
  drafts.save('b', 'another chat draft', []);
  drafts.save('a', 'keep this new text', [oldFile, newFile]);
  const remaining = drafts.acknowledge('a', sent);
  assert.equal(remaining.text, 'keep this new text');
  assert.equal(remaining.files.length, 1);
  assert.equal(remaining.files[0], newFile);
  assert.equal(drafts.get('b').text, 'another chat draft');
  const next = drafts.submission('a');
  drafts.acknowledge('a', next);
  assert.equal(drafts.get('a').text, '');
  assert.equal(drafts.get('a').files.length, 0);
});

test('unavailable or corrupt session storage does not prevent using drafts', () => {
  const storage = new Map([['pd.chat.draft.a', '{bad json']]);
  const drafts = draftStore(storage);
  assert.equal(drafts.get('a').text, '');
  const window = {};
  vm.runInNewContext(source, { window });
  const unavailable = new window.PocketDevDrafts(undefined);
  unavailable.save('a', 'works without storage', []);
  assert.equal(unavailable.get('a').text, 'works without storage');
});

test('unlock replaces an apparently open socket and ignores its late events', async (t) => {
  const f = fixture(t, { waitForHello: true });
  await flush();
  const old = f.sockets[0];
  old.open(); old.receive({ t: 'hello' });
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(old.readyState, 3);
  await f.tick(60000);
  assert.equal(f.sockets.length, 1, 'no background reconnect loop');
  f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange'));
  await flush();
  const fresh = f.sockets[1]; fresh.open();
  assert.notEqual(f.connection.state, 'connected', 'Chat waits for its authoritative snapshot');
  old.receive({ t: 'event', event: 'stale permission' });
  old.onclose({ code: 1000 });
  fresh.receive({ t: 'hello', chat: { pending: false } });
  assert.equal(f.connection.state, 'connected');
  assert.equal(f.messages.some((m) => m.t === 'event'), false);
  assert.equal(f.sockets.length, 2);
});

test('network loss pauses retries, online reconnects, and no user input is replayed', async (t) => {
  const f = fixture(t);
  await flush(); f.sockets[0].open();
  assert.equal(f.connection.send({ t: 'in', d: 'one command' }), true);
  f.navigator.onLine = false; f.window.dispatchEvent(new Event('offline'));
  assert.equal(f.connection.state, 'offline');
  assert.equal(f.connection.send({ t: 'in', d: 'offline command' }), false);
  await f.tick(60000);
  assert.equal(f.sockets.length, 1);
  f.navigator.onLine = true; f.window.dispatchEvent(new Event('online'));
  await flush(); f.sockets[1].open();
  assert.deepEqual(f.sockets[1].sent, []);
  assert.equal(f.connection.state, 'connected');
});

test('heartbeat replaces a half-open connection and consumes pong without passing it to the UI', async (t) => {
  const f = fixture(t);
  await flush(); f.sockets[0].open();
  await f.tick(15000);
  assert.deepEqual(f.sockets[0].sent, [{ t: 'ping' }]);
  f.sockets[0].receive({ t: 'pong' });
  assert.deepEqual(f.messages, []);
  await f.tick(15000);
  await f.tick(10000);
  assert.equal(f.connection.state, 'reconnecting');
  await f.tick(1000);
  assert.equal(f.sockets.length, 2);
});

test('handshake timeout retries, and a superseded authentication check cannot create a socket', async (t) => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  let checks = 0;
  const f = fixture(t, { beforeConnect: () => ++checks === 1 ? pending : undefined });
  f.window.dispatchEvent(new Event('online'));
  await flush();
  assert.equal(f.sockets.length, 1);
  resolve(); await flush();
  assert.equal(f.sockets.length, 1);
  await f.tick(15000);
  await f.tick(1000);
  assert.equal(f.sockets.length, 2);
});

test('suspending cancels the pending authentication request', async (t) => {
  let signal;
  const f = fixture(t, { beforeConnect: (s) => { signal = s; return new Promise(() => {}); } });
  assert.equal(signal.aborted, false);
  f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(signal.aborted, true);
  await f.tick(60000);
  assert.equal(f.sockets.length, 0);
});

test('power pause requires an explicit resume, and disposal cancels listeners and timers', async (t) => {
  const f = fixture(t, { onClose: () => false });
  await flush(); f.sockets[0].open(); f.sockets[0].close();
  f.window.dispatchEvent(new Event('online'));
  f.window.dispatchEvent(new Event('pageshow'));
  await f.tick(60000);
  assert.equal(f.sockets.length, 1);
  f.connection.resume(); await flush();
  assert.equal(f.sockets.length, 2);
  f.connection.dispose();
  f.window.dispatchEvent(new Event('online'));
  await f.tick(60000);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.timers.size, 0);
});
