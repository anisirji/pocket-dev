import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Chat } from '../chat/chat.js';

const source = fs.readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
// Exercise the production view functions together with the real server queue.
// No browser layout or external model is needed for these lifecycle checks.
const queueView = source.slice(source.indexOf('  function renderQueue()'), source.indexOf('  async function removeQueued('));
const messageView = source.slice(source.indexOf("    'user-text': (ev) => {"), source.indexOf("    'assistant-text':"));
const composer = source.slice(source.indexOf('  function renderComposer()'), source.indexOf('  function renderFiles()'));
const draftView = source.slice(source.indexOf('  function persistQueueEdit('), source.indexOf('  function resetLog()'));
const serverSource = fs.readFileSync(new URL('../chat/index.js', import.meta.url), 'utf8');
const patchRoute = serverSource.slice(serverSource.indexOf("    'PATCH :id/queue':"), serverSource.indexOf("    'DELETE :id/queue':"));
class Element {
  constructor(tag, className, text = '') { Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, scrollTop: 0, replacements: 0, value: '', classList: { remove() {} } }); }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  replaceChildren(...nodes) { this.children = nodes; this.replacements++; }
  focus() { this.focused = true; }
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-queue-ui-'));
  const chat = Chat.create({ tool: 'codex', cwd: dir, settings: {} }, dir);
  t.after(() => { chat.remove(); fs.rmSync(dir, { recursive: true, force: true }); });
  const queue = new Element('div', 'chat-queue');
  const el = (tag, cls, text) => new Element(tag, cls, text);
  const elements = new Map();
  const stored = new Map(), savedDrafts = new Map();
  const runtime = {
    convo: { id: chat.id, chat: chat.view(), online: true, events: chat.events, files: [] },
    ui: { queue, input: el('textarea'), send: el('button'), attach: el('button') }, queueKey: '', removingQueued: new Set(), queueEdits: new Map(), TOOLS: { codex: 'Codex', claude: 'Claude' },
    q: (selector) => { if (!elements.has(selector)) elements.set(selector, el('div')); return elements.get(selector); },
    isBusy: () => true, growInput: () => {},
    renderFiles: () => runtime.renderComposer(),
    drafts: { get: (id) => savedDrafts.get(id) || { text: '', files: [] }, save: (id, text, files) => { const draft = { text, files }; savedDrafts.set(id, draft); return draft; } },
    draftStorage: { getItem: (k) => stored.get(k), setItem: (k, v) => stored.set(k, v), removeItem: (k) => stored.delete(k) },
    setChat: (view) => { runtime.convo.chat = view; }, notices: [], noticeOptions: [], notice: (text, options) => { runtime.notices.push(text); runtime.noticeOptions.push(options); },
    QUEUE_UPDATE_MESSAGE: 'Queued-message editing needs a Pocket Dev update. Your edit stays in this tab.',
    readJson: async (req) => req, TEXT_MAX: 60000,
    BadRequest: class extends Error { constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; } },
    el, baseName: (p) => path.basename(p), keepFocus: () => {},
    button: (cls, text, onclick) => Object.assign(el('button', cls, text), { onclick }),
    removeQueued: (id) => { chat.unqueue(id); runtime.renderQueue(); },
    IMAGE_EXT: /\.(png|jpg)$/i, attachedImage: () => el('img', 'chat-user-img'), copyButton: () => el('button', 'chat-copy'),
  };
  vm.createContext(runtime);
  vm.runInContext(`${draftView}\n${composer}\n${queueView}\nObject.assign(this, {renderQueue, renderComposer, editQueued, saveQueuedEdit, finishQueueEdit, saveDraft, restoreQueueEdit, reconcileQueueEdit}); this.patchRoute = ({${patchRoute}})['PATCH :id/queue']; this.renderUser = ({${messageView}})['user-text'];`, runtime);
  runtime.sendWithTimeout = async (url, body, method) => {
    assert.equal(url, `/api/chat/${chat.id}/queue`);
    assert.equal(method, 'PATCH');
    return (await runtime.patchRoute(body, chat))[1];
  };
  return { chat, queue, runtime };
}

test('waiting messages stay in the bottom tray during replies and enter the log in full only when picked up', (t) => {
  const { chat, queue, runtime } = fixture(t);
  chat.startTurn();
  const text = 'Keep the entire queued message, including all of these details. '.repeat(30);
  const waiting = chat.enqueue({ text, files: [] });
  runtime.renderQueue();
  const row = queue.children[0];
  assert.equal(queue.hidden, false);
  assert.equal(row.children[1].textContent, text, 'CSS truncates only the visible preview, never the stored message');
  assert.equal(runtime.renderUser(waiting).hidden, true, 'queued messages are excluded from the scrolling log');
  chat.emit({ type: 'assistant-text', text: 'Streaming an unrelated reply' });
  runtime.renderQueue();
  assert.equal(queue.children[0], row, 'streaming must not rebuild the tray or interrupt Remove');
  chat.dequeue();
  runtime.renderQueue();
  assert.equal(queue.hidden, true);
  assert.equal(runtime.renderUser(waiting).hidden, true, 'the old queued placeholder stays hidden');
  const sent = runtime.renderUser(chat.events.at(-1));
  assert.equal(sent.hidden, undefined);
  assert.equal(sent.children[0].textContent, text, 'the picked-up message appears in full');
});

test('multiple queued messages keep their order, include attachment previews, and can be removed independently', (t) => {
  const { chat, queue, runtime } = fixture(t);
  chat.enqueue({ text: '', files: [{ path: '/tmp/specification.pdf', size: 1 }] });
  chat.enqueue({ text: 'Second message', files: [{ path: '/tmp/image.png', size: 1 }] });
  runtime.renderQueue();
  assert.equal(queue.children.length, 2);
  assert.equal(queue.children[0].children[0].textContent, 'Queued 1/2');
  assert.equal(queue.children[0].children[1].textContent, 'specification.pdf');
  assert.equal(queue.children[1].children[1].textContent, 'Second message · 1 attached');
  queue.children[0].children[3].onclick();
  assert.equal(queue.children.length, 1);
  assert.equal(queue.children[0].children[0].textContent, 'Queued');
  assert.equal(chat.dequeue().text, 'Second message');
});

test('failed queued messages leave the tray and remain visible as Not sent', (t) => {
  const { chat, queue, runtime } = fixture(t);
  const waiting = chat.enqueue({ text: 'Keep this after failure', files: [] });
  runtime.renderQueue();
  chat.holdQueue();
  runtime.renderQueue();
  assert.equal(queue.hidden, true);
  const shown = runtime.renderUser(waiting);
  assert.equal(shown.hidden, undefined);
  assert.equal(shown.children[0].textContent, 'Keep this after failure');
  assert.match(shown.children[1].textContent, /Not sent/);
});

test('offline queues remain visible with removal disabled, retain scroll, and do not leak into another chat', (t) => {
  const { chat, queue, runtime } = fixture(t);
  chat.enqueue({ text: 'Waiting', files: [] });
  queue.scrollTop = 32;
  runtime.convo.online = false;
  runtime.renderQueue();
  assert.equal(queue.hidden, false);
  assert.equal(queue.children[0].children[2].disabled, true);
  assert.equal(queue.scrollTop, 32);
  runtime.convo.online = true;
  runtime.renderQueue();
  assert.equal(queue.children[0].children[2].disabled, false);
  assert.equal(queue.attributes['aria-label'], 'Codex queued messages');
  runtime.convo = { id: 'other-chat', chat: { tool: 'claude' }, online: true, events: [], files: [] };
  runtime.renderQueue();
  assert.equal(queue.hidden, true);
  assert.equal(queue.children.length, 0);
});

test('Edit and Save change the queued input in place, keep attachments, and restore an unrelated composer draft', async (t) => {
  const { chat, queue, runtime: r } = fixture(t);
  const a = chat.enqueue({ text: 'Original first', files: [{ path: '/tmp/design.pdf', size: 123 }] });
  chat.enqueue({ text: 'Second', files: [] });
  r.ui.input.value = 'A separate draft';
  r.convo.files = [{ path: '/tmp/draft.txt', name: 'draft.txt' }];
  r.renderQueue();
  queue.children[0].children[2].onclick();
  assert.equal(r.ui.input.value, 'Original first');
  assert.equal(r.ui.send.textContent, 'Save');
  assert.equal(r.ui.attach.disabled, true);
  assert.equal(r.ui.input.focused, true);
  r.ui.input.value = 'Updated first\nWith all details';
  await r.saveQueuedEdit();
  assert.equal(r.queueEdits.size, 0);
  assert.equal(r.ui.input.value, 'A separate draft');
  assert.equal(r.convo.files[0].path, '/tmp/draft.txt');
  assert.equal(chat.find(a.id).text, 'Updated first\nWith all details');
  const next = chat.dequeue();
  assert.equal(next.text, 'Updated first\nWith all details');
  assert.equal(next.files[0].path, '/tmp/design.pdf');
  assert.equal(chat.dequeue().text, 'Second');
});

test('Cancel leaves queued text unchanged and streaming does not overwrite an edit', (t) => {
  const { chat, runtime: r } = fixture(t);
  const a = chat.enqueue({ text: 'Original', files: [] });
  r.ui.input.value = 'Unsent composer draft';
  r.editQueued(a.id);
  r.ui.input.value = 'Still typing';
  r.saveDraft();
  chat.emit({ type: 'assistant-text', text: 'A streaming update' });
  r.renderQueue();
  assert.equal(r.ui.input.value, 'Still typing');
  assert.equal(r.queueEdits.get(chat.id).text, 'Still typing');
  r.finishQueueEdit(chat.id, r.queueEdits.get(chat.id));
  assert.equal(r.ui.input.value, 'Unsent composer draft');
  assert.equal(chat.dequeue().text, 'Original');
});

test('a picked-up message cannot be edited, and unsaved changes can be kept without sending a new message', async (t) => {
  const { chat, runtime: r } = fixture(t);
  const a = chat.enqueue({ text: 'Original', files: [] });
  r.ui.input.value = 'Separate draft';
  r.editQueued(a.id);
  r.ui.input.value = 'My changed message';
  assert.equal(chat.dequeue().text, 'Original');
  r.renderQueue();
  assert.equal(r.ui.send.textContent, 'Keep draft');
  await r.saveQueuedEdit();
  assert.equal(r.ui.input.value, 'Separate draft\n\nMy changed message');
  assert.equal(chat.queue.length, 0);
  assert.equal(chat.events.at(-1).text, 'Original');
});

test('late pickup, lost save responses and conflicting edits preserve the edit draft', async (t) => {
  const { chat, runtime: r } = fixture(t);
  const a = chat.enqueue({ text: 'Original', files: [] });
  r.editQueued(a.id);
  r.ui.input.value = 'My edit';
  const request = r.sendWithTimeout;
  r.sendWithTimeout = async (...args) => { await request(...args); throw new Error('Response lost'); };
  await r.saveQueuedEdit();
  assert.equal(chat.queue[0].text, 'My edit');
  assert.equal(r.ui.input.value, 'My edit');
  r.sendWithTimeout = request;
  await r.saveQueuedEdit();
  assert.equal(r.queueEdits.size, 0, 'retrying a save that succeeded is idempotent');

  r.editQueued(a.id);
  r.ui.input.value = 'Second edit';
  chat.editQueued(a.id, 'Other device', 'My edit');
  await r.saveQueuedEdit();
  assert.equal(chat.queue[0].text, 'Other device');
  assert.equal(r.ui.input.value, 'Second edit');
  assert.match(r.notices.at(-1), /another device/);
  r.sendWithTimeout = async (...args) => { chat.dequeue(); return request(...args); };
  await r.saveQueuedEdit();
  assert.match(r.notices.at(-1), /not waiting/);
  assert.equal(r.ui.input.value, 'Second edit');
});

test('a late save cannot erase newer typing or a different chat composer', async (t) => {
  const { chat, runtime: r } = fixture(t);
  const a = chat.enqueue({ text: 'Original', files: [] });
  r.editQueued(a.id);
  r.ui.input.value = 'Saved text';
  const request = r.sendWithTimeout;
  let release;
  r.sendWithTimeout = async (...args) => { const result = await request(...args); await new Promise((resolve) => { release = resolve; }); return result; };
  const pending = r.saveQueuedEdit();
  while (!release) await Promise.resolve();
  r.ui.input.value = 'Typed after Save';
  r.saveDraft();
  release();
  await pending;
  assert.equal(r.ui.input.value, 'Typed after Save');
  assert.equal(r.queueEdits.get(chat.id).expectedText, 'Saved text');
  const again = r.saveQueuedEdit();
  release = null;
  while (!release) await Promise.resolve();
  r.convo = { id: 'different', chat: { tool: 'codex' }, online: true, events: [], files: [] };
  r.ui.input.value = 'Other chat draft';
  release();
  await again;
  assert.equal(r.ui.input.value, 'Other chat draft');
  assert.equal(chat.queue[0].text, 'Typed after Save');
});

test('queue API validates edits and never changes sent or attachment-only messages incorrectly', async (t) => {
  const { chat, runtime: r } = fixture(t);
  const a = chat.enqueue({ text: 'Text only', files: [] });
  const b = chat.enqueue({ text: 'With file', files: [{ path: '/tmp/a.pdf', size: 1 }] });
  const patch = (eventId, text, expectedText) => r.patchRoute({ eventId, text, expectedText }, chat);
  await assert.rejects(patch(a.id, '', 'Text only'), (err) => err.status === 400);
  await assert.rejects(patch(a.id, 'x'.repeat(60001), 'Text only'), (err) => err.status === 400);
  await assert.rejects(patch(a.id, 'Changed', undefined), (err) => err.status === 400);
  await patch(b.id, '', 'With file');
  assert.equal(chat.queue[1].files[0].path, '/tmp/a.pdf');
  chat.dequeue();
  await assert.rejects(patch(a.id, 'Too late', 'Text only'), (err) => err.status === 404);
  assert.equal(chat.events.at(-1).text, 'Text only');
});

test('offline edits survive reload separately from the composer draft and are never automatically submitted', async (t) => {
  const { chat, runtime: r } = fixture(t);
  const a = chat.enqueue({ text: 'Original', files: [{ path: '/tmp/a.pdf', size: 1 }] });
  r.ui.input.value = 'Separate draft';
  r.editQueued(a.id);
  r.ui.input.value = 'An edit kept through reload';
  r.saveDraft();
  r.convo.online = false;
  await r.saveQueuedEdit();
  assert.equal(chat.queue[0].text, 'Original');
  r.queueEdits.clear();
  const restored = r.restoreQueueEdit(chat.id);
  assert.equal(restored.text, 'An edit kept through reload');
  assert.equal(restored.files[0].path, '/tmp/a.pdf');
  assert.equal(restored.saving, false);
  assert.equal(r.drafts.get(chat.id).text, 'Separate draft');
  assert.equal(r.restoreQueueEdit('another-chat'), undefined);
  r.finishQueueEdit(chat.id, restored);
  assert.equal(r.draftStorage.getItem(`pd.chat.queue-edit.${chat.id}`), undefined);
});

test('an older server cannot offer queue editing or clear an existing composer draft', (t) => {
  const { chat, runtime: r } = fixture(t);
  const a = chat.enqueue({ text: 'Still waiting', files: [] });
  delete r.convo.chat.capabilities;
  r.ui.input.value = 'My separate draft';
  r.editQueued(a.id);
  assert.equal(r.queueEdits.size, 0);
  assert.equal(r.ui.input.value, 'My separate draft');
  assert.match(r.notices.at(-1), /needs a Pocket Dev update/);
  assert.equal(r.noticeOptions.at(-1).persistent, true);
  assert.equal(chat.queue[0].text, 'Still waiting');
});

test('generic route 404s keep an edit queued, explain the server update and recover on a supported snapshot', async (t) => {
  const { chat, runtime: r } = fixture(t);
  const a = chat.enqueue({ text: 'Still waiting', files: [] });
  r.ui.input.value = 'Separate draft';
  r.editQueued(a.id);
  r.ui.input.value = 'Revised queued text';
  const request = r.sendWithTimeout;
  r.sendWithTimeout = async () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
  await r.saveQueuedEdit();
  const edit = r.queueEdits.get(chat.id);
  assert.equal(edit.unavailable, undefined, 'a missing endpoint is not a picked-up message');
  assert.equal(edit.serverUpdateRequired, true);
  assert.equal(r.ui.input.value, 'Revised queued text');
  assert.equal(r.ui.send.textContent, 'Save');
  assert.equal(r.ui.send.disabled, true);
  assert.equal(chat.queue[0].text, 'Still waiting');
  assert.equal(r.noticeOptions.at(-1).persistent, true);
  // Recover an edit marked unavailable by the old missing-route error handler.
  edit.unavailable = true;
  r.convo.chat = chat.view();
  r.reconcileQueueEdit();
  r.renderQueue();
  assert.equal(edit.unavailable, false);
  assert.equal(edit.serverUpdateRequired, false);
  assert.equal(r.ui.send.disabled, false);
  r.sendWithTimeout = request;
  await r.saveQueuedEdit();
  assert.equal(chat.dequeue().text, 'Revised queued text');
  assert.equal(r.ui.input.value, 'Separate draft');
});
