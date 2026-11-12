import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The Messages page refuses a file over the internet limit before a byte is sent, naming the file and the fix.
const source = fs.readFileSync(new URL('../public/messages.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('const MB ='), source.indexOf('\n', source.indexOf('const sizeText =')));
const refusal = source.slice(source.indexOf('  function refusalFor(file) {'), source.indexOf('  function renderTray() {'));
const MB = 1024 * 1024;

function refusalWith(limits) {
  const ctx = { state: { limits } };
  vm.createContext(ctx);
  vm.runInContext(`${helpers}\n${refusal}\nthis.refusalFor = refusalFor;`, ctx);
  return ctx.refusalFor;
}

test('over the internet a file above 100 MB is refused up front with its name, size and the way round', () => {
  const refusalFor = refusalWith({ fileMax: 100 * MB, lowSpace: false });
  assert.equal(refusalFor({ name: 'holiday.mp4', size: 240 * MB }),
    'holiday.mp4 is 240.0 MB, too large to send over the internet (the limit is 100 MB). Connect to the same Wi-Fi as the computer to send it.');
  assert.equal(refusalFor({ name: 'exact.bin', size: 100 * MB }), null, 'exactly 100 MB still goes');
});

test('on Wi-Fi there is no size refusal', () => {
  assert.equal(refusalWith({ fileMax: null, lowSpace: false })({ name: 'huge.mov', size: 5000 * MB }), null);
});
