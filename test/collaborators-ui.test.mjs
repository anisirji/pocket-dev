import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const pickerSource = fs.readFileSync(new URL('../public/folder-picker.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../public/collaborators.js', import.meta.url), 'utf8').replace('export function mountCollaborators', 'function mountCollaborators');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.className = ''; this.attrs = {}; this.classList = { add: (name) => { this.className += ` ${name}`; } }; }
  append(...nodes) { for (const n of nodes) if (typeof n === 'string') this.textContent += n; else { n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attrs[k] = v; }
  get childElementCount() { return this.children.length; }
  focus() { this.focused = true; }
  dispatchEvent(event) { this[`on${event.type}`]?.(event); }
  remove() { this.parent.children = this.parent.children.filter((n) => n !== this); }
  reportValidity() { return true; }
  querySelectorAll(tag) { return this.children.flatMap((n) => [...(n.tag === tag ? [n] : []), ...n.querySelectorAll(tag)]); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture({ local = false, enabled = true } = {}) {
  const root = new Element('section'), calls = [], timers = [];
  const state = { enabled, ai: { available: false, reason: 'Isolated AI is unavailable' }, collaborators: [] };
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET' && url.startsWith('/api/folders/browse')) {
      const dir = new URL(url, 'http://fixture').searchParams.get('path') || '/projects';
      return { path: dir, parent: '/', breadcrumbs: [{ name: 'Projects', path: '/projects' }], shortcuts: [{ name: 'Home', path: '/projects' }], entries: dir === '/projects' ? [{ name: 'website', path: '/projects/website' }, { name: 'assets', path: '/projects/assets' }] : [] };
    }
    if (method === 'GET') return state;
    if (url.endsWith('/enable')) { state.enabled = true; return state; }
    if (url.endsWith('/invite')) return { url: 'http://fixture/invite#token=opaque-token', svg: '<svg/>', expiresAt: Date.now() + 600000 };
    if (method === 'POST') {
      const grant = { id: '0123456789abcdef', ...body, repository: { given: body.repository }, status: 'invited', extraFolders: body.extraFolders };
      state.collaborators.push(grant); return grant;
    }
  };
  const runtime = { document: { createElement: (tag) => new Element(tag) }, navigator: {}, window: {}, URLSearchParams, Event: class { constructor(type) { this.type = type; } }, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
  vm.createContext(runtime);
  vm.runInContext(pickerSource, runtime);
  vm.runInContext(`${source}\nthis.mount = mountCollaborators;`, runtime);
  const ui = runtime.mount(root, { api, local, devices: () => [{ id: 'owner-1', code: '0001', name: 'My phone', status: 'active' }, { id: 'other-2', code: '0002', name: 'Other phone', status: 'active' }] });
  const find = (text) => root.querySelectorAll('button').find((b) => b.textContent === text);
  const field = (name) => [...root.querySelectorAll('input'), ...root.querySelectorAll('select')].find((n) => n.attrs['aria-label'] === name) ?? root.querySelectorAll('label').find((l) => l.textContent === name)?.children[0];
  return { root, calls, state, ui, find, field, runtime, timers };
}

test('Mac trust review starts unchecked and enables only explicitly selected Admin devices', async () => {
  const f = fixture({ local: true, enabled: false });
  await settle();
  assert.equal(f.find('Invite someone').disabled, true);
  const checks = f.root.querySelectorAll('input');
  assert.ok(checks.every((input) => !input.checked));
  checks[0].checked = true; checks[0].onchange();
  await f.find('Enable role-based sharing').onclick();
  const enabled = f.calls.find((c) => c.url.endsWith('/enable'));
  assert.deepEqual(Array.from(enabled.body.adminDeviceIds), ['owner-1']);
  assert.equal(f.find('Invite someone').disabled, false);
});

test('Developer invitation submits the selected scope, defaults extra folders to read-only, and offers explicit sharing actions', async () => {
  const f = fixture(); await settle();
  f.find('Invite someone').onclick();
  f.field('Name').value = 'Website developer';
  f.field('Role').value = 'developer'; f.field('Role').onchange();
  f.field('Repository').value = '/projects/website'; f.field('Access duration').value = '86400';
  f.find('Add related folder').onclick();
  const form = f.root.querySelectorAll('form')[0], rows = form.querySelectorAll('div').filter((n) => n.className === 'co-folder');
  rows[0].pathInput.value = '/Downloads/assets'; rows[0].children[1].value = 'read';
  assert.equal(f.field('AI access').disabled, true);
  form.onsubmit({ preventDefault() {} });
  form.onsubmit({ preventDefault() {} });
  await settle();
  const creates = f.calls.filter((c) => c.method === 'POST' && c.url === '/api/collaborators');
  assert.equal(creates.length, 1, 'double taps cannot create duplicate collaborators');
  assert.equal(creates[0].body.role, 'developer');
  assert.equal(creates[0].body.ai, false);
  assert.equal(creates[0].body.repository, '/projects/website');
  assert.equal(creates[0].body.extraFolders[0].mode, 'read');
  assert.equal(f.root.querySelectorAll('textarea')[0].value, 'http://fixture/invite#token=opaque-token');
  assert.ok(f.find('Share invite')); assert.ok(f.find('Copy link')); assert.ok(f.find('Show QR'));
  assert.match(f.root.querySelectorAll('a')[0].href, /^https:\/\/wa\.me\/\?text=/);
  assert.equal(f.root.querySelectorAll('a')[0].rel, 'noopener noreferrer');
});

test('Viewer selection removes write mode and phone Settings cannot perform Mac trust migration', async () => {
  const f = fixture(); await settle(); f.find('Invite someone').onclick();
  f.field('Role').value = 'developer'; f.field('Role').onchange(); f.find('Add related folder').onclick();
  const mode = f.root.querySelectorAll('div').find((n) => n.className === 'co-folder').children[1];
  mode.value = 'write'; f.field('Role').value = 'viewer'; f.field('Role').onchange();
  assert.equal(mode.value, 'read'); assert.equal(mode.disabled, true);
  const phone = fixture({ enabled: false }); await settle();
  assert.equal(phone.find('Enable role-based sharing'), undefined);
  assert.equal(phone.find('Invite someone').disabled, true);
});

for (const local of [false, true]) {
  test(`folder browsers populate collaborator access on ${local ? 'Admin' : 'phone'} without typing paths`, async () => {
    const f = fixture({ local }); await settle(); f.find('Invite someone').onclick();
    f.field('Name').value = 'Reviewer';
    const fields = () => f.root.querySelectorAll('div').filter((n) => n.className === 'fp-field');
    const choose = async (field, name) => {
      const browse = field.querySelectorAll('button').find((b) => b.textContent === 'Browse folders');
      await browse.onclick();
      await field.querySelectorAll('button').find((b) => b.attrs['aria-label'] === `Open folder ${name}`).onclick();
      await field.querySelectorAll('button').find((b) => b.textContent === 'Select this folder').onclick();
    };
    await choose(fields()[0], 'website');
    f.find('Add related folder').onclick();
    await choose(fields()[1], 'assets');
    const form = f.root.querySelectorAll('form')[0];
    form.onsubmit({ preventDefault() {} }); await settle();
    const created = f.calls.find((c) => c.method === 'POST' && c.url === '/api/collaborators');
    assert.equal(created.body.repository, '/projects/website');
    assert.equal(created.body.extraFolders[0].path, '/projects/assets');
    assert.equal(created.body.extraFolders[0].mode, 'read');
  });
}
