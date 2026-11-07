import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const chat = fs.readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
const renderer = chat.slice(chat.indexOf('  function localFileTarget('), chat.indexOf('  function codeBlock('));
function fixture() {
  const opened = [];
  const runtime = {
    window: { openFile: (p) => opened.push(p) }, URLSearchParams,
    el: (tag, cls, text) => ({ tag, cls, children: text ? [text] : [], append(...items) { this.children.push(...items); } }),
  };
  vm.createContext(runtime);
  vm.runInContext(`${renderer}\nthis.render = (text) => inline(el('p'), text);`, runtime);
  return { runtime, opened, links: (text) => runtime.render(text).children.filter((n) => n.tag === 'a') };
}

test('local Markdown links open Files and preserve paths with spaces and line references', () => {
  const { opened, links } = fixture();
  for (const [markdown, expected] of [
    ['[ROLE_ACCESS_PLAN.md](/Users/ani/Desktop/pocket-dev/docs/ROLE_ACCESS_PLAN.md)', '/Users/ani/Desktop/pocket-dev/docs/ROLE_ACCESS_PLAN.md'],
    ['[Plan](</Users/ani/My Project/Plan (draft).md>)', '/Users/ani/My Project/Plan (draft).md'],
    ['[Code](/Users/ani/project/app.js:12:3)', '/Users/ani/project/app.js'],
    ['[Code](/Users/ani/project/app.js#L12)', '/Users/ani/project/app.js'],
  ]) {
    const [link] = links(markdown);
    assert.ok(link);
    assert.equal(new URL(link.href, 'http://fixture').pathname, '/api/files/download');
    assert.equal(new URL(link.href, 'http://fixture').searchParams.get('path'), expected);
    let prevented = false;
    link.onclick({ button: 0, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(opened.at(-1), expected);
  }
});

test('web URLs still work, while executable and unsupported protocols remain inert text', () => {
  const { links, runtime } = fixture();
  const [web] = links('[Docs](https://example.com/docs)');
  assert.equal(web.href, 'https://example.com/docs');
  assert.equal(web.rel, 'noopener noreferrer');
  for (const target of ['javascript:alert(1)', 'data:text/html,bad', 'file:///etc/passwd', 'vscode://file/a', '//evil.test/path', '/\\evil.test/path']) {
    assert.equal(links(`[Unsafe](${target})`).length, 0, target);
  }
  const [htmlLabel] = links('[<img src=x onerror=alert(1)>](/Users/ani/project/doc.md)');
  assert.equal(typeof htmlLabel.children[0], 'string', 'labels must never become HTML');
  assert.equal(runtime.render('`[Code](/Users/ani/project/doc.md)`').children[0].tag, 'code');
});

test('modified clicks and an unavailable file viewer retain an authenticated browser-link fallback', () => {
  const { links, opened, runtime } = fixture();
  const [link] = links('[Plan](/Users/ani/project/plan.md)');
  link.onclick({ ctrlKey: true, preventDefault: () => assert.fail('modified click intercepted') });
  delete runtime.window.openFile;
  link.onclick({ button: 0, preventDefault: () => assert.fail('fallback intercepted') });
  assert.equal(opened.length, 0);
  assert.match(link.href, /^\/api\/files\/download\?/);
  assert.equal(link.target, '_blank');
});

test('file links preview only after an authorized response and discard superseded opens', async () => {
  const files = fs.readFileSync(new URL('../public/files.js', import.meta.url), 'utf8');
  const opener = files.slice(files.indexOf('  let fileLinkRequest = 0;'), files.lastIndexOf('})();'));
  const previews = [], errors = [], pending = [];
  const state = { open: false, loadSeq: 0 };
  const runtime = {
    window: { openFiles: async () => { state.open = true; state.loadSeq++; } }, state,
    parentOf: path.dirname, baseName: path.basename, fileUrl: (p) => p,
    fetch: (p, options) => { assert.equal(options.method, 'HEAD'); return new Promise((resolve) => pending.push({ p, resolve })); },
    openPreview: (e) => previews.push(e), toast: (message) => errors.push(message),
    navigate: () => {}, location: { replace: () => assert.fail('unexpected redirect') },
  };
  vm.createContext(runtime);
  vm.runInContext(opener, runtime);
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const response = (status) => ({ status, ok: status === 200, headers: { get: (key) => ({ 'content-type': 'text/plain', 'content-length': '10', 'last-modified': 'Sat, 07 Nov 2026 12:00:00 GMT' })[key] } });
  const forbidden = runtime.window.openFile('/outside/secret.txt');
  await flush(); pending.shift().resolve(response(403)); await forbidden;
  assert.equal(previews.length, 0);
  assert.match(errors[0], /outside your allowed folders/);
  const old = runtime.window.openFile('/project/old.md');
  await flush();
  const fresh = runtime.window.openFile('/project/new.md');
  await flush();
  pending.shift().resolve(response(200)); await old;
  assert.equal(previews.length, 0);
  pending.shift().resolve(response(200)); await fresh;
  assert.equal(previews.length, 1);
  assert.equal(previews[0].path, '/project/new.md');
});
