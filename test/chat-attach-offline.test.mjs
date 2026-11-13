import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
const line = source.split('\n').find((l) => l.trim().startsWith('ui.attach.disabled ='));

function attachDisabled({ edit = null, online, uploadsOff = false }) {
  const ui = { attach: {} };
  vm.runInNewContext(line, { ui, edit, convo: { online, uploadsOff } });
  return ui.attach.disabled;
}

test('the attach button stays usable while the chat socket is offline, as after the Android file picker', () => {
  assert.equal(attachDisabled({ online: false }), false);
});

test('the attach button is still off while a queued message is edited or when the server has no upload route', () => {
  assert.equal(attachDisabled({ online: true, edit: { eventId: 'x' } }), true);
  assert.equal(attachDisabled({ online: true, uploadsOff: true }), true);
});
