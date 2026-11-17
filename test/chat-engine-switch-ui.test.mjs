import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The model chip and its menu from public/chat.js, built against a tiny DOM. Layout was not checked in a browser here.
const source = fs.readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/chat.css', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('  const BUSY = new Set'), source.indexOf('  function renderChrome() {'));

class Element {
  constructor(tag, className = '', text) {
    Object.assign(this, { tag, children: [], attributes: {}, textContent: text ?? '', className, disabled: false, parent: null });
  }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  setAttribute(k, v) { this.attributes[k] = v; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  contains(n) { return n === this || this.children.some((c) => c.contains?.(n)); }
  closest() { return this.parent ?? this; }
  all(fn, out = []) { if (fn(this)) out.push(this); for (const c of this.children) c.all?.(fn, out); return out; }
}

function setup({ chat, tools, events = [] }) {
  const calls = [];
  const toasts = [];
  const head = new Element('header', 'chat-head');
  const el = (tag, cls, text) => new Element(tag, cls, text);
  const ctx = {
    el, toasts, calls, head,
    button: (cls, text, onclick) => Object.assign(el('button', cls, text), { onclick }),
    badge: (tool) => el('span', `chat-badge chat-${tool}`, tool),
    TOOLS: { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' },
    toast: (t) => toasts.push(t),
    api: async (method, url, body) => { calls.push([method, url, body]); return {}; },
    convo: { id: 'c1', chat, events },
    options: { tools },
    document: { addEventListener() {}, removeEventListener() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(`${block}\nthis.api2 = { modelChip, toggleSwitchMenu, switchTo, usedSeveralEngines, menu: () => switchMenu };`, ctx);
  const chip = ctx.api2.modelChip(chat);
  head.append(chip);
  return { ctx, chip, ...ctx.api2 };
}

const tools = { claude: { label: 'Claude', installed: true }, codex: { label: 'Codex', installed: true }, antigravity: { label: 'Antigravity', installed: false } };

test('the chip names the engine and the menu lists the others, with the current and missing ones off', () => {
  const t = setup({ chat: { id: 'c1', tool: 'claude', status: 'idle', queued: 0 }, tools });
  assert.match(t.chip.attributes['aria-label'], /Model: Claude/);
  t.toggleSwitchMenu(t.chip);
  const items = t.menu().all((n) => n.className.startsWith('chat-switch-item'));
  assert.deepEqual(items.map((i) => [i.children[0].textContent, i.disabled]), [['claude', true], ['codex', false], ['antigravity', true]]);
  assert.equal(items[2].children[2].textContent, 'not installed');
});

test('choosing an engine posts the switch and tells the person', async () => {
  const t = setup({ chat: { id: 'c1', tool: 'claude', status: 'idle', queued: 0 }, tools });
  await t.switchTo('codex');
  assert.deepEqual(JSON.parse(JSON.stringify(t.ctx.calls)), [['POST', '/api/chat/c1/engine', { tool: 'codex' }]]);
  assert.deepEqual(t.ctx.toasts, ['Continuing with Codex']);
});

test('while a reply runs or messages wait, the menu does not open and says why', () => {
  for (const chat of [{ id: 'c1', tool: 'claude', status: 'running', queued: 0 }, { id: 'c1', tool: 'claude', status: 'idle', queued: 2 }]) {
    const t = setup({ chat, tools });
    t.toggleSwitchMenu(t.chip);
    assert.equal(t.menu(), null);
    assert.match(t.ctx.toasts[0], /Wait for the reply to finish/);
  }
});

test('answers are labelled by engine only once a chat has used more than one', () => {
  const chat = { id: 'c1', tool: 'claude', status: 'idle', queued: 0 };
  assert.equal(setup({ chat, tools, events: [{ type: 'assistant-text', tool: 'claude' }] }).usedSeveralEngines(), false);
  assert.equal(setup({ chat, tools, events: [{ type: 'assistant-text', tool: 'codex' }] }).usedSeveralEngines(), true);
});

test('the styles for the menu and the limit action exist and keep touch targets at 44 px', () => {
  assert.match(css, /\.chat-switch-item \{[^}]*min-height: 44px/);
  assert.match(css, /\.chat-limit-switch \{[^}]*min-height: 44px/);
  assert.match(source, /Continue with \$\{info\.label/);
});
