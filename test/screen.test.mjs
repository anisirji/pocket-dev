import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureError } from '../screen.js';

const host = { the: 'the Mac' };

test('a failed Windows capture says what Windows needs, with the first line of what PowerShell said', () => {
  const err = captureError({ stderr: 'Exception calling "CopyFromScreen" with "3" argument(s): "The handle is invalid"\r\nAt line:5 char:1\r\n' }, 'win32', host);
  assert.equal(err.message, 'Could not capture the screen. Windows allows a screen picture only from the signed-in desktop: the screen must be unlocked, and Pocket Dev must run as that user (pocket-dev start, or Start at login), not as a system service. (Exception calling "CopyFromScreen" with "3" argument(s): "The handle is invalid")');
});

test('a failed Mac capture keeps its own reason and has no empty detail', () => {
  assert.equal(captureError(new Error('boom'), 'darwin', host).message, 'Could not capture the screen. The display may be asleep or the Mac locked.');
});
