import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The status line and Send button from public/chat.js for a chat a program on the computer holds.
const source = fs.readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
const between = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const isBusy = between('  const isBusy = ', '\n');
const statusLine = between('  const statusText = el(', '  setInterval(() => {');
const composer = between('  function renderComposer()', '  function renderFiles()');

class Element {
  constructor(tag, className = '', text = '') { Object.assign(this, { tag, className, textContent: text, children: [], attributes: {}, hidden: false, value: '', classList: { remove() {} } }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(k, v) { this.attributes[k] = v; }
}

function render(chat) {
  const el = (tag, cls, text) => new Element(tag, cls, text);
  const elements = new Map();
  const ctx = {
    el, ui: { statusline: el('div'), input: el('textarea'), send: el('button'), attach: el('button') },
    convo: { id: 'c1', chat, online: true, events: [], files: [] },
    button: (cls, text, onclick) => Object.assign(el('button', cls, text), { onclick }),
    keepFocus: () => {}, stopTurn: () => {}, spinner: () => el('span', 'chat-spin'), ticking: () => '0s',
    TOOLS: { claude: 'Claude' }, queueEdits: new Map(), supportsQueueEdit: () => true,
    q: (s) => { if (!elements.has(s)) elements.set(s, el('div')); return elements.get(s); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${isBusy}\n${statusLine}\n${composer}\nrenderStatusLine(); renderComposer();`, ctx);
  const line = ctx.ui.statusline;
  return {
    text: line.hidden ? '' : line.children.find((n) => n.className === 'chat-status-text')?.textContent,
    spinner: line.children.some((n) => n.className === 'chat-spin'),
    stop: line.children.some((n) => n.className === 'chat-status-stop'),
    send: ctx.ui.send.textContent,
  };
}

const held = { id: 'c1', tool: 'claude', status: 'sleeping', queued: 0, held: 'Claude Code in VS Code', heldActivity: null };

test('a chat whose computer program is idle is not busy: Send, no spinner, no Stop, and a line that says what sending does', () => {
  assert.deepEqual(render(held), {
    text: 'Open in Claude Code in VS Code on your computer. You can read along here. Sending a message continues it here and closes it there.',
    spinner: false, stop: false, send: 'Send',
  });
});

test('while the computer program is on a step the chat looks busy, with Stop, Queue and when a message would go out', () => {
  assert.deepEqual(render({ ...held, heldActivity: '▶ ran Bash: npm test' }), {
    text: 'Claude Code in VS Code on your computer: ▶ ran Bash: npm test. Sending a message continues it here once it finishes.',
    spinner: true, stop: true, send: 'Queue',
  });
  assert.equal(render({ ...held, heldActivity: '▶ ran Bash: npm test', queued: 2 }).text, 'Claude Code in VS Code on your computer: ▶ ran Bash: npm test. 2 queued, sent here once it finishes.');
});

test('a message sent to an idle held chat shows the hand over in progress', () => {
  assert.deepEqual(render({ ...held, queued: 1 }), {
    text: 'Continuing here. Closing Claude Code in VS Code on your computer once it is done…',
    spinner: true, stop: false, send: 'Send',
  });
});
