import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstName, partOfDay, greetingText, box } from '../greeting.js';
import { KEYS } from '../config-keys.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a first name only when the OS user name looks like one', () => {
  for (const [user, name] of [['ani', 'Ani'], ['ROHIT', 'Rohit'], ['john.smith', 'John'], ['JohnSmith', 'John'], ['maria_g', 'Maria']]) assert.equal(firstName(user), name, user);
  for (const user of ['admin', 'User', 'root', 'pc', 'Desktop', 'desktop-7G2K', 'x', 'ani2', 'bcd', '', undefined, 'runner']) assert.equal(firstName(user), null, String(user));
});

test('the time of day picks the line', () => {
  assert.deepEqual([8, 13, 19, 23, 3].map(partOfDay), ['morning', 'afternoon', 'evening', 'night', 'night']);
});

test('personal greeting: name, system, time and only what setup just set', () => {
  const { greeting, creator } = greetingText({ name: 'Rohit', hour: 23, platform: 'win32', laptop: false, awake: 'always', claude: true, codex: false });
  assert.equal(greeting[0], "Hi Rohit, it's Ani. Still up? Fix it from bed.");
  assert.match(greeting[1], /Your Windows PC is now in your pocket\. Keep awake is on, so it stays reachable\. You can leave it under the desk/);
  assert.match(greeting[1], /Claude Code is ready to chat from your phone\.$/);
  assert.match(greeting.at(-1), /Happy coding, and have a good one\.\nAni$/);
  assert.match(creator.join('\n'), /https:\/\/theani\.me/);
  assert.match(creator.join('\n'), /https:\/\/github\.com\/anisirji\/pocket-dev/);
  assert.equal(greetingText({ name: 'Ani', hour: 9, platform: 'darwin' }).greeting[0], "Hi Ani, it's Ani too. Good morning.");
  const laptop = greetingText({ name: null, hour: 15, platform: 'darwin', laptop: true, awake: 'plugged' }).greeting;
  assert.equal(laptop[0], "Hi, it's Ani. Good afternoon.");
  assert.doesNotMatch(laptop.join(' '), /under the desk|Keep awake is on/);
});

test('plain greeting leaves out the name, the system and the time', () => {
  const { greeting } = greetingText({ name: 'Rohit', hour: 23, platform: 'win32', laptop: false, awake: 'always', claude: true }, { plain: true });
  assert.equal(greeting[0], "Hi, it's Ani.");
  assert.doesNotMatch(greeting.join(' '), /Rohit|Windows|Still up|Keep awake|Claude/);
  assert.match(greeting[1], /Your computer is now in your pocket\./);
});

test('box: colour and rounded corners, or plain ASCII with no colour codes', () => {
  const plain = box(['one two three four five six', 'seven'], { width: 12 }).split('\n');
  assert.ok(!plain.join('').includes('\x1b'));
  assert.match(plain[0], /^\+-+\+$/);
  assert.equal(new Set(plain.map((l) => l.length)).size, 1, 'every line is as wide as the box');
  assert.ok(plain.includes(`|${' '.repeat(plain[0].length - 2)}|`), 'a blank line between paragraphs');
  const color = box(['hi'], { color: true });
  assert.match(color, /\x1b\[38;5;208m╭/);
  assert.match(box(['see https://github.com/anisirji/pocket-dev'], { width: 10 }), /https:\/\/github\.com\/anisirji\/pocket-dev/, 'a link is never split');
});

test('the greeting code makes no network call and keeps all its words in one copy file', () => {
  for (const file of ['greeting.js', 'public/greeting-copy.js', 'public/welcome.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, file), 'utf8'), /\bfetch\(|XMLHttpRequest|sendBeacon|node:(http|https|net|dns)/, file);
  }
});

test('pocket-dev config set greeting plain is a setting', () => {
  assert.equal(KEYS.greeting.parse('plain'), 'plain');
  assert.equal(KEYS.greeting.parse('personal'), 'personal');
  assert.throws(() => KEYS.greeting.parse('loud'));
});
