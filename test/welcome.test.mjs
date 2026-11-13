import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, startServer } from './helpers/server.mjs';

// Just enough of a page for welcome.js: elements that keep their text and children, and a localStorage.
function fakePage(stored = {}) {
  const make = (tag) => ({ tag, style: {}, attrs: {}, children: [], textContent: '', setAttribute(k, v) { this.attrs[k] = v; },
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, addEventListener(type, fn) { this[`on${type}`] = fn; }, remove() { body.children = body.children.filter((n) => n !== this); } });
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

// The card: [title, stage, dots, button]. The stage holds the one slide on screen.
const parts = (page) => { const card = page.body.children[0].children[0]; return { stage: card.children[1], button: card.children.at(-1) }; };

function fakeTimers() {
  const timers = [];
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; };
  globalThis.clearTimeout = (id) => { if (timers[id]) timers[id].live = false; };
  return { timers, live: () => timers.filter((x) => x.live), restore() { Object.assign(globalThis, real); } };
}

test('the phone plays Welcome to Pocket Dev as slides, once, ending on the links and a Start button', async () => {
  const page = fakePage();
  const clock = fakeTimers();
  try {
    await loadWelcome();
    const { stage, button } = parts(page);
    assert.match(allText(page.body), /Welcome to Pocket Dev/);
    assert.match(allText(stage), /Hi, it's Ani 👋/, 'the first slide is the hello, with its emoji');
    assert.doesNotMatch(allText(stage), /Congratulations/, 'only one slide at a time');
    assert.equal(button.textContent, 'Next');
    const seen = [allText(stage)];
    while (button.textContent === 'Next') { button.onclick(); seen.push(allText(stage)); }
    assert.equal(new Set(seen).size, seen.length, 'every Next shows a different slide');
    assert.ok(seen.some((x) => /Congratulations, you did it! 🎉/.test(x)));
    assert.ok(seen.every((x, i) => i === seen.length - 1 || !/theani\.me/.test(x)), 'the links come last');
    assert.match(allText(stage), /https:\/\/theani\.me/);
    assert.match(allText(stage), /This message was made on your computer\. Nothing was sent\./);
    assert.equal(button.textContent, 'Start');
    assert.equal(clock.live().length, 0, 'the last slide waits for Start, no timer');
    button.onclick();
    assert.equal(page.body.children.length, 0, 'Start closes it');
    await loadWelcome();
    assert.equal(page.body.children.length, 0, 'never again on this phone');
  } finally {
    clock.restore();
    delete globalThis.document;
    delete globalThis.localStorage;
  }
});

test('a short slide stays briefly, a long one longer, and the slide changes on its own when the time is up', async () => {
  const page = fakePage();
  const clock = fakeTimers();
  try {
    await loadWelcome();
    const { stage, button } = parts(page);
    const waits = [];
    for (let i = 0; i < 7; i++) {
      const [timer] = clock.live();
      waits.push(timer.ms);
      const before = allText(stage);
      timer.fn();
      assert.notEqual(allText(stage), before, 'it moved on by itself');
    }
    assert.ok(waits[0] < waits[2], `the hello (${waits[0]} ms) stays less than the long paragraph (${waits[2]} ms)`);
    assert.ok(waits.every((ms) => ms >= 2000 && ms <= 9000));
    assert.equal(button.textContent, 'Start', 'it ends on the Start button instead of closing itself');
    assert.equal(page.body.children.length, 1);
  } finally {
    clock.restore();
    delete globalThis.document;
    delete globalThis.localStorage;
  }
});

test('Next moves on at once and restarts the wait, instead of leaving the old timer to skip a slide', async () => {
  const page = fakePage();
  const clock = fakeTimers();
  try {
    await loadWelcome();
    const { stage, button } = parts(page);
    const first = clock.live()[0];
    button.onclick();
    assert.match(allText(stage), /Congratulations/);
    assert.equal(first.live, false, 'the first slide timer is cancelled');
    assert.equal(clock.live().length, 1, 'one timer for the slide now showing');
  } finally {
    clock.restore();
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
