import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const logo = fs.readFileSync(path.join(ROOT, 'assets', 'brand', 'pocket-dev.svg'), 'utf8');

test('the logo is the page icon: the pages link it and both servers serve it, the login page without a login', async (t) => {
  for (const page of ['index.html', 'login.html', 'admin.html']) {
    assert.match(fs.readFileSync(path.join(ROOT, 'public', page), 'utf8'), /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/, page);
  }
  const s = await startServer(t);
  const phone = await fetch(`${s.base}/favicon.svg`, { redirect: 'manual' });
  assert.equal(phone.status, 200);
  assert.equal(phone.headers.get('content-type'), 'image/svg+xml');
  assert.equal(await phone.text(), logo);
  const admin = await fetch(`${s.admin}/favicon.svg`, { headers: { host: new URL(s.admin).host } });
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('content-type'), 'image/svg+xml');
});
