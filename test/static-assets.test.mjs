import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The server only serves files named in its route map. A script or style sheet a page asks for that is missing from
// the map answers 404, and the feature behind it silently never loads.
const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../src/auth/admin.js', import.meta.url), 'utf8');
const pages = fs.readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.html'));

test('every script, style sheet and icon a page asks for is served', () => {
  const missing = [];
  for (const page of pages) {
    const html = fs.readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
    const routes = page === 'admin.html' ? admin : server;
    for (const [, asset] of html.matchAll(/(?:src|href)="(\/[^"\/?#]+\.(?:js|css|svg))"/g)) {
      if (!routes.includes(`'${asset}':`)) missing.push(`${page} -> ${asset}`);
      if (!fs.existsSync(new URL(`../public${asset}`, import.meta.url))) missing.push(`${page} -> ${asset} (file does not exist)`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the answer-box caret guard is part of the served files', () => {
  assert.ok(server.includes("'/keep-caret.js': 'keep-caret.js'"));
});

test('every style sheet has balanced braces', () => {
  const unbalanced = [];
  for (const file of fs.readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.css'))) {
    const css = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const open = (css.match(/\{/g) || []).length;
    const close = (css.match(/\}/g) || []).length;
    if (open !== close) unbalanced.push(`${file}: ${open} open, ${close} close`);
  }
  assert.deepEqual(unbalanced, []);
});
