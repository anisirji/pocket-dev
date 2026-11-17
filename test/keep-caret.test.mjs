import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/keep-caret.js';

// A text box whose caret jumps to the start after every character, like some phone keyboards do.
function box({ jumpsToStart }) {
  const input = new EventTarget();
  Object.assign(input, { value: '', selectionStart: 0, selectionEnd: 0 });
  input.setSelectionRange = (a, b) => { input.selectionStart = a; input.selectionEnd = b; };
  input.type = (ch) => {
    input.dispatchEvent(new Event('beforeinput'));
    const { value, selectionStart: s, selectionEnd: e } = input;
    input.value = value.slice(0, s) + ch + value.slice(e);
    input.setSelectionRange(s + 1, s + 1);
    input.dispatchEvent(new Event('input'));
    if (jumpsToStart) input.setSelectionRange(0, 0);
  };
  globalThis.keepCaretAtEnd(input);
  return input;
}

test('without the guard a caret that jumps to the start reverses the text', () => {
  const input = new EventTarget();
  Object.assign(input, { value: '', selectionStart: 0, selectionEnd: 0, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } });
  for (const ch of 'abc') {
    const { value, selectionStart: s } = input;
    input.value = value.slice(0, s) + ch + value.slice(s);
    input.setSelectionRange(0, 0);
  }
  assert.equal(input.value, 'cba');
});

test('the guard keeps typed text in order when the caret jumps to the start', () => {
  const input = box({ jumpsToStart: true });
  for (const ch of 'wait for anyone.') input.type(ch);
  assert.equal(input.value, 'wait for anyone.');
});

test('normal typing is untouched', () => {
  const input = box({ jumpsToStart: false });
  for (const ch of 'hello') input.type(ch);
  assert.equal(input.value, 'hello');
});

test('a person who taps into the text and types there is not moved to the end', () => {
  const input = box({ jumpsToStart: false });
  for (const ch of 'held') input.type(ch);
  input.dispatchEvent(new Event('pointerup'));
  input.setSelectionRange(3, 3);
  input.type('l');
  assert.equal(input.value, 'helld');
});

test('a person who taps the start and types there is not moved to the end', () => {
  const input = box({ jumpsToStart: false });
  for (const ch of 'ello') input.type(ch);
  input.dispatchEvent(new Event('pointerup'));
  input.setSelectionRange(0, 0);
  input.type('h');
  assert.equal(input.value, 'hello');
});
