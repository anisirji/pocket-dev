import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveToolImages, resultText, IMAGE_FILE_RE } from '../chat/tool-images.js';

const PNG = Buffer.from('iVBORw0KGgo=', 'base64');
const image = (type = 'image/png', data = PNG.toString('base64')) => ({ type: 'image', source: { type: 'base64', media_type: type, data } });
const folder = (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-img-')), 'chat.images');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
};

test('a tool result image is saved as a private file and shows as a picture, not [image]', (t) => {
  const dir = folder(t);
  const content = [{ type: 'text', text: 'read it' }, image()];
  const saved = saveToolImages(dir, content, 'toolu_01ABC');
  assert.deepEqual([...saved.values()], ['toolu_01ABC-1.png']);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'toolu_01ABC-1.png')), PNG);
  assert.equal(fs.statSync(path.join(dir, 'toolu_01ABC-1.png')).mode & 0o777, 0o600);
  assert.equal(resultText(content, saved), 'read it', 'no [image] text once the picture is saved');
});

test('an image that cannot be saved still reads as [image]', (t) => {
  const dir = folder(t);
  const content = [image('image/tiff')];
  const saved = saveToolImages(dir, content, 'x');
  assert.equal(saved.size, 0);
  assert.equal(resultText(content, saved), '[image]');
  assert.ok(!fs.existsSync(dir), 'nothing is created when nothing is saved');
});

test('a huge image is refused rather than written', (t) => {
  const huge = 'A'.repeat(12 * 1024 * 1024);
  assert.equal(saveToolImages(folder(t), [image('image/png', huge)], 'big').size, 0);
});

test('the tool-use id cannot escape the folder, and only safe names are served', (t) => {
  const dir = folder(t);
  const saved = saveToolImages(dir, [image()], '../../etc/passwd');
  const [name] = saved.values();
  assert.match(name, IMAGE_FILE_RE);
  assert.equal(path.dirname(path.join(dir, name)), dir);
  for (const bad of ['../x.png', 'a/b.png', 'x.svg', 'x.png.exe', '', '.png', 'x.PNG']) assert.ok(!IMAGE_FILE_RE.test(bad), bad);
});

test('string and missing results are unchanged', () => {
  assert.equal(resultText('plain'), 'plain');
  assert.equal(resultText(undefined), '');
  assert.equal(resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
});
