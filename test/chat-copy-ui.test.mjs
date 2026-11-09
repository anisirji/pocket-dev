import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
const copyView = source.slice(source.indexOf('  // Plain http on the LAN'), source.indexOf('  const RENDER = {'));
const assistantView = source.slice(source.indexOf("    'assistant-text':"), source.indexOf('    thinking:'));

class Element {
  constructor(tag, className, text = '') { Object.assign(this, { tag, className, textContent: text, children: [], innerHTML: '' }); }
  append(...nodes) { this.children.push(...nodes); }
  get firstChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  matches() { return false; }
  querySelector() { return null; }
}

function fixture(events, copied) {
  const toasts = [];
  const runtime = {
    el: (tag, cls, text) => new Element(tag, cls, text),
    button: (cls, text, onclick) => Object.assign(new Element('button', cls, text ?? ''), { onclick }),
    keepFocus: () => {}, toast: (t) => toasts.push(t),
    window: { isSecureContext: true }, navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } },
    setTimeout: () => 0,
    TOOLS: { claude: 'Claude', codex: 'Codex' }, convo: { chat: { tool: 'claude' }, events },
    md: () => new Element('div'), shortModel: (m) => m, toasts,
  };
  vm.createContext(runtime);
  vm.runInContext(`${copyView}\nObject.assign(this, {copyButton, chatTranscript, copyText}); this.renderAssistant = ({${assistantView}})['assistant-text'];`, runtime);
  return runtime;
}

test('Copy chat gives the whole conversation in order and skips unsent and removed messages', () => {
  const rt = fixture([
    { type: 'user-text', text: 'first question' },
    { type: 'tool-run', name: 'Bash' },
    { type: 'assistant-text', text: 'first answer' },
    { type: 'user-text', text: 'waiting', queued: true },
    { type: 'user-text', text: 'taken back', removed: true },
    { type: 'user-text', text: 'second question' },
    { type: 'assistant-text', text: 'second answer' },
  ], []);
  assert.equal(rt.chatTranscript(), 'You:\nfirst question\n\nClaude:\nfirst answer\n\nYou:\nsecond question\n\nClaude:\nsecond answer');
});

test('the bubble copy button puts that message on the clipboard and says so', async () => {
  const copied = [];
  const rt = fixture([], copied);
  const b = rt.copyButton('hello **there**');
  await b.onclick();
  assert.deepEqual(copied, ['hello **there**']);
  assert.deepEqual(rt.toasts, ['Copied']);
});

test('a failed copy is reported, not swallowed', async () => {
  const rt = fixture([], []);
  rt.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  await rt.copyButton('x').onclick();
  assert.deepEqual(rt.toasts, ['Could not copy']);
});

test('an answer still streaming has no copy button until it finishes', () => {
  const rt = fixture([], []);
  const hasCopy = (node) => node.children.some((c) => c.className === 'chat-bubble-foot' && c.children.some((k) => k.className === 'chat-copy'));
  assert.equal(hasCopy(rt.renderAssistant({ text: 'partial', streaming: true })), false);
  assert.equal(hasCopy(rt.renderAssistant({ text: 'done' })), true);
});
