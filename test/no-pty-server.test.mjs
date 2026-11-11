import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { startServer, until } from './helpers/server.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

test('without node-pty the server starts, serves login, and says why terminals are off', { timeout: 60000 }, async (t) => {
  const s = await startServer(t, { env: { POCKET_DEV_FORCE_NO_PTY: '1' } });
  assert.match(s.logs(), /Warning: terminals are off: .*Fix: pocket-dev doctor --fix/);

  const page = await s.request('GET', '/login.html');
  assert.equal(page.status, 200);
  assert.equal((await s.request('GET', '/api/sessions')).status, 401);

  const { cookie } = await s.login();
  const terminals = await s.request('GET', '/api/terminals', { cookie });
  assert.equal(terminals.status, 200);
  assert.equal(terminals.data.available, false);
  assert.equal(terminals.data.command, 'pocket-dev doctor --fix');

  const created = await s.request('POST', '/api/sessions', { cookie, body: {} });
  assert.equal(created.status, 503);
  assert.match(created.data.error, /^Terminals are not available on this computer: .*pocket-dev doctor --fix/);

  const list = await s.request('GET', '/api/sessions', { cookie });
  assert.deepEqual(list.data, []);

  const health = await s.request('GET', '/api/health', { cookie });
  assert.equal(health.status, 200);
  assert.equal(health.data.terminals.available, false);
  assert.match(health.data.terminals.reason, /switched off/);

  // The terminal socket is refused with 503, not a hung or broken terminal.
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/0123456789ab`, { headers: { cookie, origin: s.base } });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('open', () => resolve('open'));
    ws.on('error', () => {});
  });
  assert.equal(status, 503);

  // Everything else still works: the chat list is answered.
  assert.equal((await s.request('GET', '/api/chat', { cookie })).status, 200);
});

test('with node-pty a terminal still starts', { timeout: 60000 }, async (t) => {
  const s = await startServer(t);
  const { cookie } = await s.login();
  assert.equal((await s.request('GET', '/api/terminals', { cookie })).data.available, true);
  assert.equal((await s.request('GET', '/api/health', { cookie })).data.terminals.available, true);
  const created = await s.request('POST', '/api/sessions', { cookie, body: {} });
  assert.equal(created.status, 201);
  assert.equal((await s.request('DELETE', `/api/sessions/${created.data.id}`, { cookie })).status, 204);
});

// ---- The phone's card ---------------------------------------------------------------------------------------------

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.className = ''; this.attrs = {}; }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
}
const source = fs.readFileSync(new URL('../public/terminals-off.js', import.meta.url), 'utf8').replaceAll('export const', 'const').replaceAll('export function', 'function');
function card(info, copyText) {
  const runtime = { document: { createElement: (tag) => new Element(tag) } };
  vm.createContext(runtime);
  return vm.runInContext(`${source}; terminalsOffCard`, runtime)(info, { copyText });
}

test('the Terminal card says it in plain words, with the command, a Copy button and a link to the docs', async () => {
  const copied = [];
  const root = card({ available: false, reason: 'the terminal component (node-pty) is not installed', command: 'pocket-dev doctor --fix' }, async (text) => { copied.push(text); return true; });
  const text = root.all().map((n) => n.textContent).join('\n');
  assert.match(text, /Terminals are not available on this computer/);
  assert.match(text, /because the terminal component \(node-pty\) is not installed/);
  assert.match(text, /Chats, Git, Files and the rest still work/);
  assert.match(text, /not on this phone/);
  assert.equal(root.all().find((n) => n.tag === 'code').textContent, 'pocket-dev doctor --fix');
  const copy = root.all().find((n) => n.tag === 'button');
  assert.equal(copy.textContent, 'Copy');
  await copy.onclick();
  assert.deepEqual(copied, ['pocket-dev doctor --fix']);
  assert.equal(copy.textContent, 'Copied');
  const link = root.all().find((n) => n.tag === 'a');
  assert.equal(link.textContent, 'Troubleshooting guide');
  assert.match(link.href, /docs\/SETUP\.md#troubleshooting$/);
  assert.equal(root.attrs.role, 'alert');
});

test('the card is built for a server that answers /api/terminals, and index.html shows it before opening any terminal', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /api\('GET', '\/api\/terminals'\)/);
  assert.match(html, /terminalsOffCard/);
});
