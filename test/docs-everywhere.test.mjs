import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const { detectType } = await import('../src/rooms/messages.js');

test('documents are recognised by their first bytes, and text only with a plain-text name', () => {
  assert.equal(detectType(Buffer.from('%PDF-1.7\n')), 'application/pdf');
  assert.equal(detectType(Buffer.from('hello\nworld'), 'notes.txt'), 'text/plain');
  assert.equal(detectType(Buffer.from('a,b\n1,2'), 'sheet.csv'), 'text/plain');
  assert.equal(detectType(Buffer.from('hello'), 'run.exe'), 'application/octet-stream', 'a name that is not text stays a download');
  assert.equal(detectType(Buffer.from('he\0llo'), 'notes.txt'), 'application/octet-stream', 'binary bytes are never text');
  assert.equal(detectType(Buffer.from('<script>alert(1)</script>'), 'page.html'), 'application/octet-stream', 'HTML is never shown');
  assert.equal(detectType(Buffer.from('PK\x03\x04'), 'report.docx'), 'application/octet-stream');
});

async function open(t) {
  const s = await startServer(t);
  const A = await s.login();
  const headers = { cookie: A.cookie, 'x-pocket-dev': '1' };
  const upload = async (name, bytes) => (await fetch(`${s.base}/api/messages/files`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, body: bytes })).json();
  const get = (id, q = '') => fetch(`${s.base}/api/messages/files/${id}${q}`, { headers });
  return { s, A, headers, upload, get };
}

test('a PDF and a text file show in the page, a Word file downloads', { timeout: 60000 }, async (t) => {
  const { s, A, upload, get } = await open(t);
  const pdf = await upload('Plan.pdf', Buffer.from('%PDF-1.4\n%fake\n'));
  const txt = await upload('todo.txt', Buffer.from('buy milk\n'));
  const doc = await upload('report.docx', Buffer.from('PK\x03\x04rest'));
  assert.deepEqual([pdf.kind, txt.kind, doc.kind], ['pdf', 'text', 'file']);
  const sent = await s.request('POST', '/api/messages', { cookie: A.cookie, body: { text: '', files: [pdf.id, txt.id, doc.id] } });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const p = await get(pdf.id);
  assert.equal(p.headers.get('content-type'), 'application/pdf');
  assert.match(p.headers.get('content-disposition'), /^inline/);
  assert.equal(p.headers.get('content-security-policy'), 'sandbox');
  const x = await get(txt.id);
  assert.equal(x.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await x.text(), 'buy milk\n');
  const d = await get(doc.id);
  assert.equal(d.headers.get('content-type'), 'application/octet-stream');
  assert.match(d.headers.get('content-disposition'), /^attachment/);
  assert.equal((await get(pdf.id, '?download=1')).headers.get('content-type'), 'application/octet-stream');
});

test('Send in Messages copies a file from Files into Messages without the phone carrying it', { timeout: 60000 }, async (t) => {
  const { s, A, get } = await open(t);
  const file = path.join(s.home, 'Documents', 'budget.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'rent 100\n');
  const r = await s.request('POST', '/api/files/send', { cookie: A.cookie, body: { path: file } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.name, r.data.size, r.data.kind], ['budget.txt', 9, 'text']);
  const sent = await s.request('POST', '/api/messages', { cookie: A.cookie, body: { text: '', files: [r.data.id] } });
  assert.equal(sent.status, 201);
  assert.equal(await (await get(r.data.id)).text(), 'rent 100\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'rent 100\n', 'the original stays where it was');
});

test('Send in Messages refuses what Files itself would refuse, and needs a login', { timeout: 60000 }, async (t) => {
  const { s, A } = await open(t);
  const post = (cookie, body) => s.request('POST', '/api/files/send', { cookie, body });
  assert.equal((await post(undefined, { path: s.home })).status, 401);
  assert.equal((await post(A.cookie, { path: '/etc/hosts' })).status, 403, 'outside the folders Files may show');
  assert.equal((await post(A.cookie, { path: s.home })).status, 400, 'a folder cannot be sent');
  assert.equal((await post(A.cookie, { path: path.join(s.home, 'missing.txt') })).status, 404);
});
