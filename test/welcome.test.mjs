import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, startServer } from './helpers/server.mjs';

// Just enough of a page for welcome.js: elements that keep their text and children, and a localStorage.
function fakePage(stored = {}) {
  const make = (tag) => ({ tag, style: {}, attrs: {}, children: [], textContent: '', setAttribute(k, v) { this.attrs[k] = v; },
    append(...nodes) { this.children.push(...nodes); }, addEventListener(type, fn) { this[`on${type}`] = fn; }, remove() { body.children = body.children.filter((n) => n !== this); } });
  const body = make('body');
  globalThis.document = { createElement: make, body };
  globalThis.localStorage = { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; } };
  return { body, stored };
}
const allText = (node) => [node.textContent, ...node.children.map(allText)].join(' ');

// welcome.js imports the copy by its address on the server; here it is pointed at the file.
async function loadWelcome() {
  const source = fs.readFileSync(path.join(REPO, 'public', 'welcome.js'), 'utf8')
    .replace("'/greeting-copy.js'", `'${pathToFileURL(path.join(REPO, 'public', 'greeting-copy.js')).href}'`);
  await import(`data:text/javascript,${encodeURIComponent(source)}#${Math.random()}`);
}

test('the phone shows Welcome to Pocket Dev once, with the greeting and the links', async () => {
  const page = fakePage();
  await loadWelcome();
  assert.equal(page.body.children.length, 1);
  const text = allText(page.body);
  assert.match(text, /Welcome to Pocket Dev/);
  assert.match(text, /Hi, it's Ani\./);
  assert.match(text, /https:\/\/theani\.me/);
  assert.match(text, /This message was made on your computer\. Nothing was sent\./);
  page.body.children[0].children[0].children.at(-1).onclick();
  assert.equal(page.body.children.length, 0, 'the button closes it');
  await loadWelcome();
  assert.equal(page.body.children.length, 0, 'never again on this phone');
  delete globalThis.document;
  delete globalThis.localStorage;
});

test('the phone greeting shows one paragraph first, then one more each second, and a tap on the text shows the rest', async () => {
  const page = fakePage();
  const timers = [];
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};
  try {
    await loadWelcome();
    const card = page.body.children[0].children[0];
    const scroll = card.children[1];
    const visible = () => scroll.children.filter((b) => b.style.display === 'block').length;
    assert.equal(visible(), 1, 'only the first paragraph at the start');
    assert.equal(timers.at(-1).ms, 1000, 'one second to the next');
    timers.at(-1).fn();
    assert.equal(visible(), 2);
    scroll.onclick();
    assert.equal(visible(), scroll.children.length, 'a tap shows everything');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    delete globalThis.document;
    delete globalThis.localStorage;
  }
});

test('the logged-in page loads the welcome, and its files are served only after login', { timeout: 60000 }, async (t) => {
  const s = await startServer(t);
  assert.equal((await s.request('GET', '/welcome.js')).status, 401);
  const { cookie } = await s.login();
  for (const file of ['/welcome.js', '/greeting-copy.js']) {
    const r = await s.request('GET', file, { cookie });
    assert.equal(r.status, 200, file);
    assert.match(r.headers.get('content-type'), /javascript/);
  }
  assert.match(fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8'), /<script type="module" src="\/welcome\.js"><\/script>/);
});
