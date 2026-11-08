import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/folder-picker.js', import.meta.url), 'utf8');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.textContent = ''; this.value = ''; this.hidden = false; }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, val) { this.attrs[key] = val; }
  focus() { this.focused = true; }
  dispatchEvent(event) { this[`on${event.type}`]?.(event); }
  all(tag) { return this.children.flatMap((c) => [...(c.tag === tag ? [c] : []), ...c.all(tag)]); }
  button(text) { return this.all('button').find((c) => c.textContent === text); }
  aria(text) { return this.all('button').find((c) => c.attrs['aria-label'] === text); }
  cls(name) { return this.children.flatMap((c) => [...(c.className?.split(' ').includes(name) ? [c] : []), ...c.findClass(name)])[0]; }
  findClass(name) { return this.children.flatMap((c) => [...(c.className?.split(' ').includes(name) ? [c] : []), ...c.findClass(name)]); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const listing = (path, names = []) => ({ path, parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
  shortcuts: [{ name: 'Home', path: '/home' }, { name: 'External drives', path: '/Volumes' }],
  breadcrumbs: [{ name: 'Mac', path: '/' }, { name: path.split('/').at(-1), path }],
  entries: names.map((name) => ({ name, path: `${path}/${name}` })), truncated: false });
function fixture({ respond } = {}) {
  const calls = [], timers = new Map(); let timerId = 0;
  const runtime = { document: { createElement: (tag) => new Element(tag) }, window: {}, URLSearchParams,
    Event: class { constructor(type) { this.type = type; } },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id) };
  vm.runInNewContext(source, runtime);
  const api = async (method, url) => {
    const params = new URL(url, 'http://fixture').searchParams;
    calls.push({ method, path: params.get('path') || '/home', q: params.get('q'), hidden: params.get('hidden'), sort: params.get('sort'), order: params.get('order') });
    if (respond) return respond(calls.at(-1));
    return listing(params.get('path') || '/home', params.get('path') === '/home/Projects' ? [] : ['Projects', '<img onerror=bad>']);
  };
  const input = new Element('input'); input.value = '/home'; let changed = 0;
  input.oninput = () => { changed++; };
  const field = runtime.window.PocketDevFolderPicker.field(input, { api, label: 'Folder' });
  return { field, input, calls, runtime, picker: runtime.window.PocketDevFolderPicker, api, changed: () => changed,
    timers: async () => { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); await settle(); } };
}

test('browse, open a folder and select it without typing a path; cancellation preserves the selection', async () => {
  const f = fixture();
  const browse = f.field.button('Browse folders');
  await browse.onclick();
  await f.field.aria('Open folder Projects').onclick();
  assert.equal(f.field.cls('fp-status').textContent, 'No subfolders. You can select this folder.');
  await f.field.button('Select this folder').onclick();
  assert.equal(f.input.value, '/home/Projects');
  assert.equal(f.changed(), 1);
  assert.equal(browse.attrs['aria-expanded'], 'false');
  assert.equal(browse.focused, true);
  await browse.onclick();
  f.field.button('Cancel').onclick();
  assert.equal(f.input.value, '/home/Projects');
  assert.equal(f.changed(), 1);
});

test('Back, Up, locations, hidden folders and search stay within the chosen directory', async () => {
  const f = fixture(); await f.field.button('Browse folders').onclick();
  await f.field.aria('Open folder Projects').onclick();
  f.field.button('Back').onclick(); await settle();
  assert.equal(f.calls.at(-1).path, '/home');
  await f.field.button('External drives').onclick();
  f.field.button('Up').onclick(); await settle();
  assert.equal(f.calls.at(-1).path, '/');
  await f.field.button('Home').onclick();
  const checkbox = f.field.all('input').find((e) => e.type === 'checkbox');
  checkbox.checked = true; checkbox.onchange(); await settle();
  assert.equal(f.calls.at(-1).hidden, '1');
  const search = f.field.all('input').find((e) => e.type === 'search');
  search.value = 'Pro'; search.oninput();
  search.value = 'Projects'; search.oninput();
  assert.equal(f.field.button('Select this folder').disabled, true);
  await f.timers();
  assert.equal(f.calls.at(-1).path, '/home');
  assert.equal(f.calls.at(-1).q, 'Projects');
});

test('an inaccessible folder disables selection and offers Home recovery', async () => {
  const f = fixture({ respond: (call) => { if (call.path === '/denied') throw new Error('macOS denied access'); return listing('/home'); } });
  f.input.value = '/denied'; await f.field.button('Browse folders').onclick();
  assert.equal(f.field.button('Select this folder').disabled, true);
  assert.equal(f.field.cls('fp-status').textContent, 'macOS denied access');
  await f.field.button('Go to Home').onclick();
  await f.field.button('Select this folder').onclick();
  assert.equal(f.input.value, '/home');
});

test('late responses after cancellation or a newer navigation cannot change the folder', async () => {
  const requests = [];
  const f = fixture({ respond: (call) => new Promise((resolve) => requests.push({ call, resolve })) });
  const first = f.field.button('Browse folders').onclick();
  f.field.button('Cancel').onclick();
  const second = f.field.button('Browse folders').onclick();
  requests[1].resolve(listing('/fresh')); await second;
  requests[0].resolve(listing('/stale')); await first;
  await f.field.button('Select this folder').onclick();
  assert.equal(f.input.value, '/fresh');
});

test('choosing a folder updates only its own field and treats folder names as plain text', async () => {
  const f = fixture();
  const other = new Element('input'); other.value = '/other';
  const second = f.picker.field(other, { api: f.api, label: 'Related folder' });
  await second.button('Browse folders').onclick();
  const name = second.cls('fp-list').children[1].children[1];
  assert.equal(name.textContent, '<img onerror=bad>');
  assert.equal(name.children.length, 0);
  await second.aria('Open folder Projects').onclick();
  await second.button('Select this folder').onclick();
  assert.equal(other.value, '/other/Projects');
  assert.equal(f.input.value, '/home');
});

test('new Chat starts in the browsed folder without entering a path', async () => {
  const f = fixture();
  const source = fs.readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('  async function renderNewSheet()'), source.indexOf('  function renderSettings()'));
  const sheet = new Element('section'), submitted = [];
  const el = (tag, cls, text) => Object.assign(new Element(tag), { className: cls, textContent: text ?? '' });
  const runtime = {
    window: f.runtime.window, ui: { newSheet: sheet, input: new Element('textarea') }, draft: null, stack: [], options: null,
    el, button: (cls, text, onclick) => Object.assign(el('button', cls, text), { onclick }),
    sheetHead: (title) => el('header', '', title), placeholder: (text) => el('p', '', text),
    hasLayer: () => true,
    loadOptions: async () => ({ home: '/home', tools: { codex: { label: 'Codex' } } }),
    loadFolders: async () => [],
    ensureDraft: () => { runtime.draft = { cwd: '', tool: 'codex', settings: { codex: {} }, confirmed: new Set() }; },
    schemaOf: () => [], renderDraftChips: null, TOOLS: { codex: 'Codex' },
    api: async (method, url, body) => { if (method === 'POST') { submitted.push(body); return { id: 'new-chat' }; } return f.api(method, url); },
    showChat: () => {}, sheetError: (root, message) => assert.fail(message),
  };
  vm.runInNewContext(`${render}\nthis.render = renderNewSheet;`, runtime);
  await runtime.render();
  await sheet.button('Browse folders').onclick();
  await sheet.aria('Open folder Projects').onclick();
  await sheet.button('Select this folder').onclick();
  await sheet.button('Start').onclick();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].cwd, '/home/Projects');
  assert.equal(submitted[0].tool, 'codex');
});

test('the Terminal browser opens a shell in the selected folder and stays open on failure', async () => {
  const f = fixture(), opened = [];
  const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const open = source.slice(source.indexOf('let openingFolder = false;'), source.indexOf('async function togglePin('));
  let fail = true, closed = 0;
  const runtime = {
    newSession: async (path) => { if (fail) throw new Error('Folder was removed'); opened.push(path); },
    otherPath: { querySelector: () => ({ value: '' }) },
    hideLayer: () => { closed++; }, renderFolders: () => {}, folderNote: '',
  };
  vm.runInNewContext(`${open}\nthis.open = openFolder;`, runtime);
  const picker = f.picker.create({ api: f.api, onSelect: runtime.open, selectLabel: 'Open terminal here' });
  await picker.open('/home');
  await picker.element.aria('Open folder Projects').onclick();
  await picker.element.button('Open terminal here').onclick();
  assert.equal(picker.element.hidden, false);
  assert.equal(runtime.folderNote, 'Folder was removed');
  fail = false;
  await picker.element.button('Open terminal here').onclick();
  assert.deepEqual(opened, ['/home/Projects']);
  assert.equal(closed, 1);
  assert.equal(picker.element.hidden, true);
});

test('sort choice and direction are sent with every listing request', async () => {
  const f = fixture();
  await f.field.button('Browse folders').onclick();
  const select = f.field.all('select')[0];
  assert.equal(select.attrs['aria-label'], 'Sort folders by');
  select.value = 'modified'; select.onchange(); await settle();
  assert.equal(f.calls.at(-1).sort, 'modified');
  assert.equal(f.calls.at(-1).order, 'asc');
  f.field.cls('fp-order').onclick(); await settle();
  assert.equal(f.calls.at(-1).sort, 'modified');
  assert.equal(f.calls.at(-1).order, 'desc');
});
