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
  visible() { return !this.hidden && (!this.parent || this.parent.visible()); }
  button(text) { return this.all('button').find((c) => c.textContent === text && c.visible()); }
  aria(text) { return this.all('button').find((c) => c.attrs['aria-label'] === text && c.visible()); }
  cls(name) { return this.children.flatMap((c) => [...(c.className?.split(' ').includes(name) ? [c] : []), ...c.findClass(name)])[0]; }
  findClass(name) { return this.children.flatMap((c) => [...(c.className?.split(' ').includes(name) ? [c] : []), ...c.findClass(name)]); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const listing = (path, names = []) => ({ path, parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
  shortcuts: [{ name: 'Home', path: '/home' }, { name: 'External drives', path: '/Volumes' }],
  breadcrumbs: [{ name: 'Mac', path: '/' }, { name: path.split('/').at(-1), path }],
  entries: names.map((name) => ({ name, path: `${path}/${name}` })), truncated: false });
function fixture({ respond, storage = new Map() } = {}) {
  const calls = [], timers = new Map(); let timerId = 0;
  const runtime = { document: { createElement: (tag) => new Element(tag) }, window: {}, URLSearchParams,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id) };
  vm.runInNewContext(source, runtime);
  const api = async (method, url, body) => {
    const params = new URL(url, 'http://fixture').searchParams;
    calls.push({ method, path: params.get('path') || '/home', q: params.get('q'), hidden: params.get('hidden'), sort: params.get('sort'), order: params.get('order'), body });
    if (respond) return respond(calls.at(-1));
    return listing(params.get('path') || '/home', params.get('path') === '/home/Projects' ? [] : ['Projects', '<img onerror=bad>']);
  };
  const input = new Element('input'); input.value = '/home'; let changed = 0;
  input.oninput = () => { changed++; };
  const field = runtime.window.PocketDevFolderPicker.field(input, { api, label: 'Folder' });
  return { field, input, calls, runtime, storage, picker: runtime.window.PocketDevFolderPicker, api, changed: () => changed,
    timers: async () => { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); await settle(); } };
}

test('browse, open a folder and select it without typing a path; cancellation preserves the selection', async () => {
  const f = fixture();
  const browse = f.field.button('Browse folders');
  await browse.onclick();
  await f.field.aria('Open folder Projects').onclick();
  assert.equal(f.field.cls('fp-status').textContent, 'No subfolders. You can select this folder.');
  await f.field.button('Select folder').onclick();
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
  f.field.aria('Back').onclick(); await settle();
  assert.equal(f.calls.at(-1).path, '/home');
  const locations = f.field.all('select').find((e) => e.attrs['aria-label'] === 'Location');
  locations.value = '/Volumes'; await locations.onchange();
  f.field.aria('Up').onclick(); await settle();
  assert.equal(f.calls.at(-1).path, '/');
  locations.value = '/home'; await locations.onchange();
  const checkbox = f.field.all('input').find((e) => e.type === 'checkbox');
  checkbox.checked = true; checkbox.onchange(); await settle();
  assert.equal(f.calls.at(-1).hidden, '1');
  const search = f.field.all('input').find((e) => e.type === 'search');
  search.value = 'Pro'; search.oninput();
  search.value = 'Projects'; search.oninput();
  assert.equal(f.field.button('Select folder').disabled, true);
  await f.timers();
  assert.equal(f.calls.at(-1).path, '/home');
  assert.equal(f.calls.at(-1).q, 'Projects');
});

test('an inaccessible folder disables selection and offers Home recovery', async () => {
  const f = fixture({ respond: (call) => { if (call.path === '/denied') throw new Error('macOS denied access'); return listing('/home'); } });
  f.input.value = '/denied'; await f.field.button('Browse folders').onclick();
  assert.equal(f.field.button('Select folder').disabled, true);
  assert.equal(f.field.cls('fp-status').textContent, 'macOS denied access');
  await f.field.button('Go to Home').onclick();
  await f.field.button('Select folder').onclick();
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
  await f.field.button('Select folder').onclick();
  assert.equal(f.input.value, '/fresh');
});

test('choosing a folder updates only its own field and treats folder names as plain text', async () => {
  const f = fixture();
  const other = new Element('input'); other.value = '/other';
  const second = f.picker.field(other, { api: f.api, label: 'Related folder' });
  await second.button('Browse folders').onclick();
  const name = second.cls('fp-list').children[1].children[1].children[0];
  assert.equal(name.textContent, '<img onerror=bad>');
  assert.equal(name.children.length, 0);
  await second.aria('Open folder Projects').onclick();
  await second.button('Select folder').onclick();
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
    window: f.runtime.window, ui: { newSheet: sheet, input: new Element('textarea') }, draft: null, stack: [], options: null, workspace: null,
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
  await sheet.button('Select folder').onclick();
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
  const select = f.field.all('select').find((e) => e.attrs['aria-label'] === 'Sort folders by');
  assert.equal(select.attrs['aria-label'], 'Sort folders by');
  select.value = 'modified:asc'; select.onchange(); await settle();
  assert.equal(f.calls.at(-1).sort, 'modified');
  assert.equal(f.calls.at(-1).order, 'asc');
  select.value = 'modified:desc'; select.onchange(); await settle();
  assert.equal(f.calls.at(-1).sort, 'modified');
  assert.equal(f.calls.at(-1).order, 'desc');
});

test('New creates a folder in the current directory and opens it', async () => {
  const f = fixture({ respond: (c) => c.method === 'POST' ? { path: '/home/Fresh' } : listing(c.path, []) });
  await f.field.button('Browse folders').onclick();
  const form = f.field.all('form')[0];
  assert.equal(form.hidden, true);
  f.field.aria('Folder options').onclick();
  f.field.button('New folder').onclick();
  assert.equal(form.hidden, false);
  const name = f.field.cls('fp-newname');
  name.value = 'Fresh';
  form.onsubmit({ preventDefault() {} }); await settle(); await settle();
  assert.equal(f.calls.find((c) => c.method === 'POST').path, '/home');
  assert.equal(f.calls.at(-1).path, '/home/Fresh');
  assert.equal(form.hidden, true);
});

test('a recent project opens in one action after validation and is shared across picker callers', async () => {
  const f = fixture(); await f.field.button('Browse folders').onclick();
  await f.field.aria('Open folder Projects').onclick();
  await f.field.button('Select folder').onclick();
  const opened = [];
  const second = f.picker.create({ api: f.api, selectLabel: 'Open folder', onSelect: (path) => opened.push(path) });
  await second.open('');
  assert.ok(second.element.aria('Open recent project Projects'));
  assert.equal(second.element.button('Browse all folders').disabled, false);
  await second.element.aria('Open recent project Projects').onclick();
  assert.deepEqual(opened, ['/home/Projects']);
  assert.equal(second.element.hidden, true);
  assert.equal(f.calls.at(-1).path, '/home/Projects');
});

test('a deleted recent project is never selected and can be removed', async () => {
  const storage = new Map([['pd.folderRecents', JSON.stringify([{ path: '/gone', name: 'Gone' }])]]);
  const f = fixture({ storage, respond: (call) => { if (call.path === '/gone') throw new Error('Folder was removed'); return listing('/home'); } });
  let selected = false;
  const picker = f.picker.create({ api: f.api, onSelect: () => { selected = true; } });
  await picker.open(''); await picker.element.aria('Open recent project Gone').onclick();
  assert.equal(selected, false); assert.equal(picker.element.hidden, false);
  assert.equal(picker.element.button('Select folder').disabled, true);
  await picker.element.button('Remove from recent projects').onclick();
  assert.equal(JSON.parse(storage.get('pd.folderRecents')).length, 0);
});

test('advanced controls are hidden initially and sort direction uses one selector', async () => {
  const f = fixture(); await f.field.button('Browse folders').onclick();
  assert.equal(f.field.button('New folder'), undefined);
  assert.equal(f.field.cls('fp-menu').hidden, true);
  f.field.aria('Folder options').onclick();
  assert.ok(f.field.button('New folder')); assert.ok(f.field.button('New file'));
  assert.ok(f.field.button('Copy path')); assert.ok(f.field.button('Go to path'));
  assert.equal(f.field.all('select').filter((e) => e.attrs['aria-label'] === 'Sort folders by').length, 1);
  assert.equal(f.field.findClass('fp-selected').length, 0, 'the footer does not repeat the path');
});

test('New file creates a file without changing the selected directory', async () => {
  const f = fixture({ respond: (call) => call.method === 'POST' ? { name: 'notes.txt', path: '/home/notes.txt' } : listing('/home') });
  await f.field.button('Browse folders').onclick();
  f.field.aria('Folder options').onclick(); f.field.button('New file').onclick();
  f.field.cls('fp-newname').value = 'notes.txt';
  await f.field.button('Create').onclick();
  assert.equal(f.calls.find((call) => call.method === 'POST').body.kind, 'file');
  assert.equal(f.calls.find((call) => call.method === 'POST').body.parent, '/home');
  assert.equal(f.calls.at(-1).path, '/home');
  assert.equal(f.field.cls('fp-status').textContent, 'Created file notes.txt');
});

test('native dialog cancellation dismisses the active menu or form before closing', async () => {
  const f = fixture(); await f.field.button('Browse folders').onclick();
  const dialog = f.field.cls('fp-browser'), event = { preventDefault() {} };
  f.field.aria('Folder options').onclick(); dialog.oncancel(event);
  assert.equal(dialog.hidden, false); assert.equal(f.field.cls('fp-menu').hidden, true);
  f.field.aria('Folder options').onclick(); f.field.button('Go to path').onclick(); dialog.oncancel(event);
  assert.equal(dialog.hidden, false); assert.equal(f.field.cls('fp-pathform').hidden, true);
  dialog.oncancel(event); assert.equal(dialog.hidden, true);
});

test('long paths collapse ancestors while keeping the current folder and ancestor navigation', async () => {
  const ancestors = ['/', '/one', '/one/two', '/one/two/three', '/one/two/three/four', '/one/two/three/four/five'];
  const f = fixture({ respond: (call) => ({ ...listing(call.path), breadcrumbs: ancestors.map((path) => ({ path, name: path.split('/').at(-1) || '/' })) }) });
  f.input.value = ancestors.at(-1); await f.field.button('Browse folders').onclick();
  const nav = f.field.cls('fp-crumbs'), hiddenAncestors = nav.all('select')[0];
  assert.equal(nav.all('button').length, 3);
  assert.equal(nav.all('button').at(-1).attrs['aria-current'], 'location');
  assert.ok(hiddenAncestors.all('option').some((option) => option.value === '/one/two'));
  hiddenAncestors.value = '/one/two'; await hiddenAncestors.onchange();
  assert.equal(f.calls.at(-1).path, '/one/two');
});

test('Back clears directory search and returns from Recent projects to Home', async () => {
  const f = fixture({ storage: new Map([['pd.folderRecents', JSON.stringify([{ path: '/home/Projects', name: 'Projects' }])]]) });
  await f.field.button('Browse folders').onclick();
  const location = f.field.cls('fp-location'); location.value = '@recent'; await location.onchange();
  assert.ok(f.field.aria('Open recent project Projects'));
  assert.equal(f.field.aria('Back').disabled, false);
  f.field.cls('fp-search').value = 'missing'; f.field.cls('fp-search').oninput();
  f.field.aria('Back').onclick(); await settle();
  assert.equal(f.field.cls('fp-search').value, '');
  assert.ok(f.field.aria('Open folder Projects'));
  assert.equal(f.calls.at(-1).q, null);
});
