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
    Object.assign(this, { tag, children: [], attributes: {}, dataset: {}, title: '', textContent: text ?? '', className, disabled: false, parent: null });
    this.classList = { add: (name) => { this.className += ` ${name}`; } };
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

function setup({ chat, tools, events = [], api }) {
  const calls = [];
  const toasts = [];
  const pushes = [];
  const head = new Element('header', 'chat-head');
  const el = (tag, cls, text) => new Element(tag, cls, text);
  const ctx = {
    el, toasts, calls, pushes, head,
    button: (cls, text, onclick) => Object.assign(el('button', cls, text), { onclick }),
    badge: (tool) => el('span', `chat-badge chat-${tool}`, tool),
    TOOLS: { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', copilot: 'GitHub Copilot' },
    schemaOf: (tool) => tools[tool]?.settings || [],
    valueOf: (settings, setting) => settings?.[setting.key] ?? setting.default,
    choiceOf: (setting, value) => setting.choices.find((c) => c.value === value),
    settingChip: (setting, value, onclick) => {
      const label = setting.choices.find((c) => c.value === value)?.label || value;
      const b = Object.assign(el('button', 'chat-chip', null), { onclick });
      b.append(el('span', 'chat-chip-k', setting.label), el('span', 'chat-chip-v', label));
      b.dataset.key = setting.key;
      return b;
    },
    top: () => 'convo',
    push: (layer) => pushes.push(layer),
    setChat: (next) => { ctx.convo.chat = next; },
    toast: (t) => toasts.push(t),
    api: api ?? (async (method, url, body) => { calls.push([method, url, body]); return {}; }),
    convo: { id: 'c1', chat, events },
    options: { tools },
    document: { addEventListener() {}, removeEventListener() {}, activeElement: null },
  };
  vm.createContext(ctx);
  vm.runInContext(`${block}\nthis.api2 = { providerChip, settingPill, openSetting, openModelPicker, toggleSwitchMenu, showEngineHelp, switchTo, engineBusy, usedSeveralEngines, menu: () => switchMenu };`, ctx);
  const items = () => ctx.api2.menu().all((n) => n.className.startsWith('chat-switch-item'));
  const text = () => ctx.api2.menu().all((n) => n.textContent).map((n) => n.textContent);
  const pill = ctx.api2.providerChip(chat);
  head.append(pill);
  return { ctx, pill, items, text, ...ctx.api2 };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const modelSetting = { key: 'model', label: 'Model', default: 'default', custom: true, choices: [{ value: 'default', label: 'Default' }, { value: 'sonnet', label: 'Sonnet 5.5' }] };
const modeSetting = { key: 'mode', label: 'Mode', default: 'acceptEdits', choices: [{ value: 'acceptEdits', label: 'Accept edits' }] };
const tools = {
  claude: { label: 'Claude', installed: true, settings: [modelSetting, modeSetting], help: { install: ['npm install -g @anthropic-ai/claude-code'], login: 'claude auth login', note: 'Permission denied? See the install guide.' } },
  codex: { label: 'Codex', installed: true, settings: [modelSetting], help: { install: ['npm install -g @openai/codex'], login: 'codex login' } },
  antigravity: { label: 'Antigravity', installed: false, settings: [], help: { install: [], login: 'agy acp --login', note: 'Install the Antigravity CLI first.' } },
};
const idle = { id: 'c1', tool: 'claude', status: 'idle', queued: 0, settings: { model: 'sonnet' } };
const busyStates = [
  ['a reply runs', { status: 'running' }], ['a permission waits', { status: 'waiting-permission' }], ['an answer waits', { status: 'waiting-answer' }],
  ['the engine wakes', { waking: true }], ['a message is queued', { queued: 2 }],
];

test('the Provider pill is a normal pill that shows the engine, and is the first thing in the settings row', () => {
  const t = setup({ chat: idle, tools });
  assert.ok(t.pill.className.includes('chat-chip chat-provider-chip'));
  assert.equal(t.pill.dataset.key, 'provider');
  assert.deepEqual(t.pill.children[0].children.map((c) => c.textContent), ['Provider', 'claude']);
  assert.match(t.pill.attributes['aria-label'], /Provider: Claude\. Choose another provider/);
  assert.equal(t.pill.attributes['aria-haspopup'], 'menu');
  assert.match(source, /ui\.chips\.replaceChildren\(providerChip\(c\), \.\.\.schema\.map\(\(s\) => settingPill\(s, c\)\)\)/);
  assert.ok(!/chat-engine-row|chat-model-chip/.test(source), 'no separate header control');
});

test('the Provider pill is dimmed, aria-disabled and opens nothing in every busy state, and works when idle', () => {
  for (const [what, state] of busyStates) {
    const t = setup({ chat: { ...idle, ...state }, tools });
    assert.ok(t.pill.className.includes('chat-chip-disabled'), what);
    assert.equal(t.pill.attributes['aria-disabled'], 'true', what);
    assert.equal(t.pill.title, 'Stop the reply first.', what);
    t.pill.onclick();
    assert.equal(t.menu(), null, `${what}: no list opens`);
    assert.deepEqual(t.ctx.toasts, ['Stop the reply first.'], what);
  }
  const t = setup({ chat: idle, tools });
  assert.ok(!t.pill.className.includes('chat-chip-disabled'));
  assert.equal(t.pill.attributes['aria-disabled'], undefined);
  t.pill.onclick();
  assert.equal(t.items().length, 3);
  assert.equal(t.pill.attributes['aria-expanded'], 'true');
});

test('the Model pill stays enabled in every busy state and says the change applies to the next reply', () => {
  for (const [what, state] of [['it is idle', {}], ...busyStates]) {
    const t = setup({ chat: { ...idle, ...state }, tools });
    const model = t.settingPill(modelSetting, t.ctx.convo.chat);
    assert.ok(!model.className.includes('chat-chip-disabled'), what);
    assert.equal(model.attributes['aria-disabled'], undefined, what);
    assert.equal(model.title, t.engineBusy(t.ctx.convo.chat) ? 'Applies to the next reply' : '', what);
    model.onclick();
    assert.deepEqual(plain(t.ctx.pushes.at(-1)), { layer: 'pick', key: 'model', scope: 'chat' }, what);
    assert.deepEqual(t.ctx.toasts, [], `${what}: no refusal`);
  }
  const t = setup({ chat: { ...idle, status: 'running' }, tools });
  assert.equal(t.settingPill(modeSetting, t.ctx.convo.chat).title, '', 'Mode keeps its own rules');
});

test('the Model pill shows a custom model name as typed, and a provider with a single model still has the pill', () => {
  const custom = setup({ chat: { ...idle, settings: { model: 'my-custom-model' } }, tools });
  assert.equal(custom.settingPill(modelSetting, custom.ctx.convo.chat).children[1].textContent, 'my-custom-model');
  const single = { ...modelSetting, choices: [{ value: 'default', label: 'Gemini' }], custom: false };
  const one = setup({ chat: { ...idle, tool: 'codex', settings: {} }, tools: { ...tools, codex: { label: 'Codex', installed: true, settings: [single] } } });
  assert.equal(one.settingPill(single, one.ctx.convo.chat).children[1].textContent, 'Gemini');
});

test('the list shows every engine, marks this chat, leaves none disabled, and the current one leads to its models', () => {
  const t = setup({ chat: idle, tools });
  t.toggleSwitchMenu(t.pill);
  assert.equal(t.ctx.api2.menu().attributes.role, 'menu');
  const rows = t.items();
  assert.deepEqual(rows.map((i) => [i.children[0].textContent, i.children[2].textContent, i.disabled]),
    [['claude', 'This chat · pick model', false], ['codex', '', false], ['antigravity', 'Not installed', false]]);
  assert.equal(rows[0].attributes['aria-current'], 'true');
  rows[0].onclick();
  assert.deepEqual(plain(t.ctx.pushes.at(-1)), { layer: 'pick', key: 'model', scope: 'chat' });
  assert.equal(t.ctx.api2.menu(), null);
});

test('the list follows the server: four engines show as four rows', () => {
  const four = { ...tools, copilot: { label: 'GitHub Copilot', installed: true, settings: [] } };
  const t = setup({ chat: idle, tools: four });
  t.toggleSwitchMenu(t.pill);
  assert.deepEqual(t.items().map((i) => i.children[0].textContent), ['claude', 'codex', 'antigravity', 'copilot']);
});

test('provider first, then model: switching posts the switch and then offers the new provider\'s models', async () => {
  let t;
  t = setup({ chat: idle, tools, api: async (method, url, body) => { t.ctx.calls.push([method, url, body]); return { id: 'c1', tool: 'codex', status: 'idle', queued: 0, settings: { model: 'default' } }; } });
  t.toggleSwitchMenu(t.pill);
  t.items()[1].onclick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(JSON.parse(JSON.stringify(t.ctx.calls)), [['POST', '/api/chat/c1/engine', { tool: 'codex' }]]);
  assert.deepEqual(t.ctx.toasts, ['Continuing with Codex']);
  assert.deepEqual(plain(t.ctx.pushes), [{ layer: 'pick', key: 'model', scope: 'chat' }], 'the model list is offered at once');
});

test('a provider with no model setting is switched to without a model list', async () => {
  let t;
  t = setup({ chat: idle, tools: { ...tools, codex: { label: 'Codex', installed: true, settings: [] } }, api: async () => ({ id: 'c1', tool: 'codex', status: 'idle', queued: 0, settings: {} }) });
  await t.switchTo('codex');
  assert.deepEqual(plain(t.ctx.pushes), []);
});

test('a provider switch while busy is refused with the reason and posts nothing', async () => {
  for (const [what, state] of busyStates) {
    const t = setup({ chat: { ...idle, ...state }, tools });
    await t.switchTo('codex');
    assert.deepEqual(t.ctx.calls, [], what);
    assert.deepEqual(t.ctx.toasts, ['Stop the reply first.'], what);
  }
});

test('a new chat with no messages can switch provider, and choosing the current one does nothing', async () => {
  const t = setup({ chat: { ...idle, settings: {} }, tools, events: [] });
  await t.switchTo('claude');
  assert.deepEqual(t.ctx.calls, []);
  await t.switchTo('codex');
  assert.equal(t.ctx.calls.length, 1);
});

test('tapping a missing engine shows the install and sign-in commands, and back returns to the list', () => {
  const t = setup({ chat: idle, tools: { ...tools, codex: { label: 'Codex', installed: false, settings: [], help: { install: ['npm install -g @openai/codex'], login: 'codex login', note: 'Permission denied? See the install guide.' } } } });
  t.toggleSwitchMenu(t.pill);
  t.items()[1].onclick();
  const lines = t.text();
  assert.ok(lines.includes('Codex is not installed on your computer'));
  assert.ok(lines.includes('npm install -g @openai/codex'));
  assert.ok(lines.includes('codex login'));
  assert.ok(lines.includes('pocket-dev setup'));
  assert.deepEqual(t.ctx.calls, []);
  assert.equal(t.ctx.api2.menu().all((n) => n.className === 'chat-switch-code').length, 3);
  t.ctx.api2.menu().all((n) => n.className === 'chat-switch-back')[0].onclick();
  assert.equal(t.items().length, 3);
});

test('an engine with no help entry gets the generic advice, and a signed-out one skips the install step', () => {
  const t = setup({ chat: idle, tools: { ...tools, codex: { label: 'Codex', installed: false, settings: [] } } });
  t.toggleSwitchMenu(t.pill);
  t.items()[1].onclick();
  assert.ok(!t.text().includes('Install'));
  const out = setup({ chat: idle, tools: { ...tools, codex: { label: 'Codex', installed: true, loggedIn: false, settings: [], help: { install: ['npm install -g @openai/codex'], login: 'codex login' } } } });
  out.toggleSwitchMenu(out.pill);
  assert.equal(out.items()[1].children[2].textContent, 'Not logged in');
  out.items()[1].onclick();
  assert.ok(out.text().includes('Codex is not signed in'));
  assert.ok(out.text().includes('codex login'));
  assert.ok(!out.text().includes('npm install -g @openai/codex'));
});

test('answers are labelled by engine only once a chat has used more than one', () => {
  assert.equal(setup({ chat: idle, tools, events: [{ type: 'assistant-text', tool: 'claude' }] }).usedSeveralEngines(), false);
  assert.equal(setup({ chat: idle, tools, events: [{ type: 'assistant-text', tool: 'codex' }] }).usedSeveralEngines(), true);
});

test('the styles keep 44 px touch targets, dim the locked pill, and nothing uses the clipboard', () => {
  assert.match(css, /\.chat-switch-item \{[^}]*min-height: 44px/);
  assert.match(css, /\.chat-limit-switch \{[^}]*min-height: 44px/);
  assert.match(css, /\.chat-chip-disabled \{ opacity/);
  assert.match(css, /\.chat-switch-code \{[^}]*user-select: all/);
  assert.match(css, /\.chat-pick-note \{/);
  assert.match(source, /Continue with \$\{info\.label/);
  assert.match(source, /MODEL_NEXT_NOTE = 'Applies to the next reply'/);
  assert.ok(!/clipboard/i.test(block));
});
