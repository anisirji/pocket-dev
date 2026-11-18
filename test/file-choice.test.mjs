import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const helper = read('file-choice.js');

// A small DOM, enough for the menu: elements that can be created, appended, removed and clicked.
function world({ touch }) {
  const listeners = [];
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this.className = ''; this.textContent = ''; this.parent = null; this.focused = false; }
    append(...n) { for (const c of n) { c.parent = this; this.children.push(c); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    querySelector(sel) { return sel === 'button' ? this.children.find((c) => c.tag === 'button') : null; }
    getBoundingClientRect() { return { left: 20, top: 700 }; }
    get offsetWidth() { return 220; }
    focus() { this.focused = true; }
  }
  const sandbox = {
    document: { createElement: (t) => new El(t), head: new El('head'), body: new El('body'), addEventListener: (t, f) => listeners.push([t, f]), removeEventListener: () => {} },
    matchMedia: () => ({ matches: touch }), navigator: { userAgent: touch ? 'Mozilla/5.0 (Linux; Android 14) Chrome/130' : 'Mozilla/5.0 (Macintosh)' }, innerWidth: 390, innerHeight: 844,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(helper, sandbox);
  const input = Object.assign(new El('input'), { clicks: 0, click() { this.clicks++; } });
  return { sandbox, input, anchor: new El('button'), body: sandbox.document.body };
}

test('Photos and videos lets images and video through, Files lets documents through and keeps images out', () => {
  const { PHOTOS, FILES } = world({ touch: false }).sandbox.PocketFileChoice;
  assert.deepEqual(PHOTOS.split(','), ['image/*', 'video/*']);
  const files = FILES.split(',');
  for (const kind of ['application/*', 'text/*', 'audio/*', '.pdf', '.zip', '.txt', '.md', '.json', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.js', '.ts', '.py', '.log', '.apk']) assert.ok(files.includes(kind), kind);
  assert.ok(!files.some((f) => f.startsWith('image/') || f.startsWith('video/')));
});

test('a desktop browser opens its one normal picker with no accept list', () => {
  const w = world({ touch: false });
  w.input.setAttribute('accept', 'image/*');
  w.sandbox.chooseFiles(w.anchor, w.input);
  assert.equal(w.input.clicks, 1);
  assert.equal('accept' in w.input.attrs, false);
  assert.equal(w.body.children.length, 0);
});

test('a phone shows three 44px-class choices and each sets its accept list and opens the picker', () => {
  for (const [index, key] of [[0, 'CAMERA'], [1, 'PHOTOS'], [2, 'FILES']]) {
    const w = world({ touch: true });
    w.sandbox.chooseFiles(w.anchor, w.input);
    const menu = w.body.children[0];
    assert.equal(menu.attrs.role, 'menu');
    assert.deepEqual(menu.children.map((b) => b.textContent), ['Take photo', 'Photos and videos', 'Files']);
    assert.equal(w.input.clicks, 0);
    menu.children[index].onclick();
    assert.equal(w.input.attrs.accept, w.sandbox.PocketFileChoice[key]);
    assert.equal(w.input.attrs.capture, key === 'CAMERA' ? 'environment' : undefined, `${key} ${key === 'CAMERA' ? 'opens the camera' : 'never forces the camera'}`);
    assert.equal(w.input.clicks, 1);
    assert.equal(w.body.children.length, 0);
  }
  assert.match(helper, /\.fc-menu button \{ min-height: 44px/);
});

test('choosing a file after the camera clears the camera setting, and the desktop picker never has one', () => {
  const w = world({ touch: true });
  w.sandbox.chooseFiles(w.anchor, w.input);
  w.body.children[0].children[0].onclick();
  assert.equal(w.input.attrs.capture, 'environment');
  w.sandbox.chooseFiles(w.anchor, w.input);
  w.body.children[0].children[2].onclick();
  assert.equal('capture' in w.input.attrs, false);
  const d = world({ touch: false });
  d.input.setAttribute('capture', 'environment');
  d.sandbox.chooseFiles(d.anchor, d.input);
  assert.equal('capture' in d.input.attrs, false);
});

test('tapping the button again closes the menu', () => {
  const w = world({ touch: true });
  w.sandbox.chooseFiles(w.anchor, w.input);
  w.sandbox.chooseFiles(w.anchor, w.input);
  assert.equal(w.body.children.length, 0);
  assert.equal(w.input.clicks, 0);
});

test('every file box on the pages starts with no accept list and every paperclip goes through the helper', () => {
  assert.doesNotMatch(read('index.html'), /type="file"[^>]*accept=|accept="[^"]*"[^>]*type="file"/);
  assert.doesNotMatch(read('chat.js'), /chat-file-input" type="file"[^>]*accept/);
  assert.doesNotMatch(read('files.js'), /type: 'file'[^}]*accept/);
  assert.doesNotMatch(read('messages.js'), /picker\.accept/);
  assert.match(read('index.html'), /chooseFiles\(\$\('attach'\), \$\('file'\)\)/);
  assert.match(read('chat.js'), /chooseFiles\(ui\.attach, ui\.fileInput\)/);
  assert.match(read('files.js'), /chooseFiles\(uploadBtn, picker\)/);
  assert.match(read('messages.js'), /chooseFiles\(attach, picker\)/);
  for (const page of ['index.html', 'guest.html']) assert.match(read(page), /\/file-choice\.js/);
});
