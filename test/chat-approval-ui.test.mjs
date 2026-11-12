import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The approval card from public/chat.js, built against a tiny DOM. Layout itself was checked in a browser at 360 px;
// these tests pin the parts that keep a long command from pushing Approve and Deny off the card (PD-001).
const source = fs.readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/chat.css', import.meta.url), 'utf8');
const longCheck = source.slice(source.indexOf('  const isLongRequest'), source.indexOf('\n', source.indexOf('  const isLongRequest')));
const cardView = source.slice(source.indexOf('  function permissionCard('), source.indexOf('  function questionCard('));

class Element {
  constructor(tag, className = '', text) {
    Object.assign(this, { tag, children: [], attributes: {}, dataset: {}, textContent: text ?? '' });
    const classes = new Set(className.split(' ').filter(Boolean));
    this.classList = {
      add: (c) => classes.add(c),
      contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(k, v) { this.attributes[k] = v; }
  find(cls) { return this.classList.contains(cls) ? this : this.children.map((c) => c.find?.(cls)).find(Boolean); }
  all(fn, out = []) { if (fn(this)) out.push(this); for (const c of this.children) c.all?.(fn, out); return out; }
}

function render(ev) {
  const el = (tag, cls, text) => new Element(tag, cls, text);
  const ctx = {
    el, KINDS: { command: 'Run a command' }, FALLBACK_OPTIONS: [],
    button: (cls, text, onclick) => Object.assign(el('button', cls, text), { onclick }),
    md: (text) => el('div', 'md', text), diffBlock: () => el('div', 'chat-diff'), keepFocus: () => {}, answer: () => {}, closeKeyboard: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${longCheck}\n${cardView}\nthis.permissionCard = permissionCard;`, ctx);
  return ctx.permissionCard(ev);
}

const options = [{ id: 'allow', label: 'Approve' }, { id: 'allow-chat', label: 'Approve for this chat' }, { id: 'deny', label: 'Deny' }];
const heredoc = `node <<'NODE'\n${Array.from({ length: 40 }, (_, i) => `console.log('line ${i}');`).join('\n')}\nNODE`;

test('a long command collapses behind an expand control and keeps the whole command', () => {
  const card = render({ kind: 'command', title: `Run ${heredoc}`, detail: heredoc, rule: `Command: ${heredoc}`, options });
  const [scroll, actions] = card.children;
  const more = scroll.find('chat-card-more');
  assert.ok(more, 'the scrolling part has an expand control');
  assert.equal(actions.find('chat-card-more'), undefined, 'the expand control never sits with the buttons');
  assert.equal(scroll.find('chat-card-detail').textContent, heredoc, 'the detail keeps every line of the command');
  assert.equal(more.textContent, 'Show full command');
  assert.equal(more.attributes['aria-expanded'], 'false');
  more.onclick();
  assert.ok(scroll.classList.contains('chat-card-open'));
  assert.equal(more.attributes['aria-expanded'], 'true');
  assert.equal(more.textContent, 'Show less');
  more.onclick();
  assert.equal(scroll.classList.contains('chat-card-open'), false);
  const decisions = actions.all((n) => n.dataset.decision).map((b) => b.dataset.decision).sort();
  assert.deepEqual(decisions, ['allow', 'allow-chat', 'deny']);
});

test('a short command has no expand control', () => {
  const card = render({ kind: 'command', title: 'Run npm test', detail: 'npm test', rule: 'Command: npm test', options });
  assert.equal(card.find('chat-card-more'), undefined);
});

test('everything beside the buttons is height-bounded, so the buttons stay on the card', () => {
  const rule = (selector) => css.split('\n').find((line) => line.startsWith(`${selector} {`)) ?? '';
  assert.match(rule('.chat-card-actions'), /flex: none/, 'the action area does not shrink, so its contents must be bounded');
  assert.match(rule('.chat-card-rule-v'), /-webkit-line-clamp: 2/, 'the remembered rule, which can be a whole command, is clamped');
  assert.match(rule('.chat-card-rule-v'), /overflow: hidden/);
  assert.match(rule('.chat-card-detail'), /max-height: \d+px/, 'a collapsed detail is a bounded scrolling box');
  assert.match(rule('.chat-card-detail'), /overflow-y: auto/);
});
