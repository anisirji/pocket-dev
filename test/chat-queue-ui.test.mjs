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
class Element {
  constructor(tag, className, text = '') { Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, scrollTop: 0, replacements: 0 }); }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  replaceChildren(...nodes) { this.children = nodes; this.replacements++; }
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-queue-ui-'));
  const chat = Chat.create({ tool: 'codex', cwd: dir, settings: {} }, dir);
  t.after(() => { chat.remove(); fs.rmSync(dir, { recursive: true, force: true }); });
  const queue = new Element('div', 'chat-queue');
  const el = (tag, cls, text) => new Element(tag, cls, text);
  const runtime = {
    convo: { id: chat.id, chat: { tool: 'codex' }, online: true, events: chat.events },
    ui: { queue }, queueKey: '', removingQueued: new Set(), TOOLS: { codex: 'Codex', claude: 'Claude' },
    el, baseName: (p) => path.basename(p), keepFocus: () => {},
    button: (cls, text, onclick) => Object.assign(el('button', cls, text), { onclick }),
    removeQueued: (id) => { chat.unqueue(id); runtime.renderQueue(); },
    IMAGE_EXT: /\.(png|jpg)$/i, attachedImage: () => el('img', 'chat-user-img'),
  };
  vm.createContext(runtime);
  vm.runInContext(`${queueView}\nthis.renderQueue = renderQueue; this.renderUser = ({${messageView}})['user-text'];`, runtime);
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
  queue.children[0].children[2].onclick();
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
  runtime.convo = { id: 'other-chat', chat: { tool: 'claude' }, online: true, events: [] };
  runtime.renderQueue();
  assert.equal(queue.hidden, true);
  assert.equal(queue.children.length, 0);
});
