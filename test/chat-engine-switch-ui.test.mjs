import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The model dropdown and its list from public/chat.js, built against a tiny DOM. The real layout is checked in Chrome by
// scripts/check-engine-dropdown.mjs.
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
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  querySelectorAll() { return this.all((n) => n.tag === 'button' && n !== this); }
  focus() { this.focused = true; }
  closest() { return this.parent ?? this; }
  all(fn, out = []) { if (fn(this)) out.push(this); for (const c of this.children) c.all?.(fn, out); return out; }
}

function setup({ chat, tools, events = [] }) {
  const calls = [];
  const toasts = [];
  const row = new Element('div', 'chat-engine-row');
  const el = (tag, cls, text) => new Element(tag, cls, text);
  const ctx = {
    el, toasts, calls, row,
    button: (cls, text, onclick) => Object.assign(el('button', cls, text), { onclick }),
    badge: (tool) => el('span', `chat-badge chat-${tool}`, tool),
    TOOLS: { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', copilot: 'GitHub Copilot' },
    schemaOf: (tool) => tools[tool]?.settings || [],
    valueOf: (settings, setting) => settings?.[setting.key] ?? setting.default,
    choiceOf: (setting, value) => setting.choices.find((c) => c.value === value),
    toast: (t) => toasts.push(t),
    api: async (method, url, body) => { calls.push([method, url, body]); return {}; },
    convo: { id: 'c1', chat, events },
    options: { tools },
    document: { addEventListener() {}, removeEventListener() {}, activeElement: null },
  };
  vm.createContext(ctx);
  vm.runInContext(`${block}\nthis.api2 = { engineDropdown, toggleSwitchMenu, showEngineHelp, switchTo, usedSeveralEngines, menu: () => switchMenu };`, ctx);
  const dd = ctx.api2.engineDropdown(chat);
  row.append(dd);
  const items = () => ctx.api2.menu().all((n) => n.className.startsWith('chat-switch-item'));
  const text = () => ctx.api2.menu().all((n) => n.textContent).map((n) => n.textContent);
  return { ctx, dd, items, text, ...ctx.api2 };
}

const models = [{ key: 'model', default: 'default', choices: [{ value: 'default', label: 'Default' }, { value: 'sonnet', label: 'Sonnet 5.5' }] }];
const tools = {
  claude: { label: 'Claude', installed: true, settings: models, help: { install: ['npm install -g @anthropic-ai/claude-code'], login: 'claude auth login', note: 'Permission denied? See the install guide.' } },
  codex: { label: 'Codex', installed: true, settings: [] },
  antigravity: { label: 'Antigravity', installed: false, settings: [], help: { install: [], login: 'agy acp --login', note: 'Install the Antigravity CLI first.' } },
};
const idle = { id: 'c1', tool: 'claude', status: 'idle', queued: 0, settings: { model: 'sonnet' } };

test('the dropdown names the engine and the model, and is a real menu button', () => {
  const t = setup({ chat: idle, tools });
  assert.match(t.dd.attributes['aria-label'], /Model: Claude, Sonnet 5\.5\. Choose another model/);
  assert.equal(t.dd.attributes['aria-haspopup'], 'menu');
  assert.deepEqual(t.dd.children.map((c) => c.textContent), ['claude', '· Sonnet 5.5', '▾']);
  const none = setup({ chat: { ...idle, tool: 'codex', settings: {} }, tools });
  assert.deepEqual(none.dd.children.map((c) => c.textContent), ['codex', '', '▾']);
});

test('the list shows every engine, marks this chat, and leaves none disabled', () => {
  const t = setup({ chat: idle, tools });
  t.toggleSwitchMenu(t.dd);
  assert.equal(t.dd.attributes['aria-expanded'], 'true');
  assert.equal(t.ctx.api2.menu().attributes.role, 'menu');
  const items = t.items();
  assert.deepEqual(items.map((i) => [i.children[0].textContent, i.children[2].textContent, i.disabled]),
    [['claude', 'This chat', false], ['codex', '', false], ['antigravity', 'Not installed', false]]);
  assert.equal(items[0].attributes['aria-current'], 'true');
  assert.ok(items.every((i) => i.attributes.role === 'menuitem'));
});

test('the list follows the server: four engines show as four rows', () => {
  const four = { ...tools, copilot: { label: 'GitHub Copilot', installed: true, settings: [] } };
  const t = setup({ chat: idle, tools: four });
  t.toggleSwitchMenu(t.dd);
  assert.deepEqual(t.items().map((i) => i.children[0].textContent), ['claude', 'codex', 'antigravity', 'copilot']);
  const two = setup({ chat: idle, tools: { claude: tools.claude, codex: tools.codex } });
  two.toggleSwitchMenu(two.dd);
  assert.equal(two.items().length, 2);
});

test('tapping a missing engine shows the install and sign-in commands, and back returns to the list', () => {
  const t = setup({ chat: idle, tools: { ...tools, codex: { label: 'Codex', installed: false, settings: [], help: { install: ['npm install -g @openai/codex'], login: 'codex login', note: 'Permission denied? See the install guide.' } } } });
  t.toggleSwitchMenu(t.dd);
  t.items()[1].onclick();
  const lines = t.text();
  assert.ok(lines.includes('Codex is not installed on your computer'));
  assert.ok(lines.includes('npm install -g @openai/codex'));
  assert.ok(lines.includes('codex login'));
  assert.ok(lines.includes('pocket-dev setup'));
  assert.deepEqual(t.ctx.calls, []);
  const codes = t.ctx.api2.menu().all((n) => n.className === 'chat-switch-code');
  assert.equal(codes.length, 3);
  t.ctx.api2.menu().all((n) => n.className === 'chat-switch-back')[0].onclick();
  assert.equal(t.items().length, 3);
});

test('an engine with no help entry gets the generic advice, and a signed-out one skips the install step', () => {
  const t = setup({ chat: idle, tools: { ...tools, codex: { label: 'Codex', installed: false, settings: [] } } });
  t.toggleSwitchMenu(t.dd);
  t.items()[1].onclick();
  assert.ok(!t.text().includes('Install'));
  const out = setup({ chat: idle, tools: { ...tools, codex: { label: 'Codex', installed: true, loggedIn: false, settings: [], help: { install: ['npm install -g @openai/codex'], login: 'codex login' } } } });
  out.toggleSwitchMenu(out.dd);
  assert.equal(out.items()[1].children[2].textContent, 'Not logged in');
  out.items()[1].onclick();
  assert.ok(out.text().includes('Codex is not signed in'));
  assert.ok(out.text().includes('codex login'));
  assert.ok(!out.text().includes('npm install -g @openai/codex'));
});

test('choosing an installed engine posts the switch and tells the person', async () => {
  const t = setup({ chat: idle, tools });
  t.toggleSwitchMenu(t.dd);
  t.items()[1].onclick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(JSON.parse(JSON.stringify(t.ctx.calls)), [['POST', '/api/chat/c1/engine', { tool: 'codex' }]]);
  assert.deepEqual(t.ctx.toasts, ['Continuing with Codex']);
  assert.equal(t.ctx.api2.menu(), null);
});

test('the list opens while a reply runs, and a switch then is refused with the reason', async () => {
  for (const chat of [{ ...idle, status: 'running' }, { ...idle, queued: 2 }]) {
    const t = setup({ chat, tools });
    t.toggleSwitchMenu(t.dd);
    assert.equal(t.items().length, 3);
    await t.switchTo('codex');
    assert.deepEqual(t.ctx.calls, []);
    assert.match(t.ctx.toasts[0], /Stop the reply, or wait for it to finish/);
  }
});

test('a new chat with no messages can switch too, and the current engine does nothing', async () => {
  const t = setup({ chat: { ...idle, status: 'idle', settings: {} }, tools, events: [] });
  await t.switchTo('claude');
  assert.deepEqual(t.ctx.calls, []);
  await t.switchTo('codex');
  assert.equal(t.ctx.calls.length, 1);
});

test('answers are labelled by engine only once a chat has used more than one', () => {
  assert.equal(setup({ chat: idle, tools, events: [{ type: 'assistant-text', tool: 'claude' }] }).usedSeveralEngines(), false);
  assert.equal(setup({ chat: idle, tools, events: [{ type: 'assistant-text', tool: 'codex' }] }).usedSeveralEngines(), true);
});

test('the styles keep 44 px touch targets, the dropdown sits first in the header, and nothing uses the clipboard', () => {
  assert.match(css, /\.chat-engine-dd \{[^}]*min-height: 44px/);
  assert.match(css, /\.chat-switch-item \{[^}]*min-height: 44px/);
  assert.match(css, /\.chat-limit-switch \{[^}]*min-height: 44px/);
  assert.match(css, /\.chat-switch-code \{[^}]*user-select: all/);
  assert.match(source, /class="chat-engine-row"><\/div>\s*<div class="chat-head-row">/);
  assert.match(source, /Continue with \$\{info\.label/);
  assert.ok(!/clipboard/i.test(block));
});
