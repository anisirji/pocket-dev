import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import { cameraSupport, cameraError, decodePixels } from '../public/room-scan.js';
import { inviteLine, parseInvite } from '../public/room-invite.js';

// The vendored decoder is a browser script (UMD); run it the way a script tag would.
{
  const mod = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(new URL('../public/vendor/jsqr/jsQR.js', import.meta.url), 'utf8')).call(mod.exports, mod, mod.exports);
  globalThis.jsQR = mod.exports;
}

async function qrPixels(text, { scale = 6, invert = false } = {}) {
  const png = PNG.sync.read(await QRCode.toBuffer(text, { scale, margin: 4 }));
  if (invert) for (let i = 0; i < png.data.length; i += 4) for (let k = 0; k < 3; k++) png.data[i + k] = 255 - png.data[i + k];
  return png;
}

test('the invite line in a QR picture is read back, and parses into address and code', async () => {
  const line = inviteLine('http://192.168.1.24:58765', 'ABCD-EFGH');
  assert.equal(line, '192.168.1.24:58765  ABCD-EFGH');
  const text = await decodePixels(await qrPixels(line));
  assert.equal(text, line);
  assert.deepEqual(parseInvite(text), { host: 'http://192.168.1.24:58765', code: 'ABCDEFGH' });
  assert.equal(await decodePixels(await qrPixels(line, { invert: true })), line, 'a light-on-dark picture works too');
});

test('a picture with no QR code reads as empty', async () => {
  assert.equal(await decodePixels({ data: new Uint8ClampedArray(100 * 100 * 4).fill(200), width: 100, height: 100 }), '');
});

test('the camera needs a secure page; the explanation names localhost and the photo option', () => {
  const insecure = cameraSupport({ isSecureContext: false, hasCamera: false, port: '7777' });
  assert.equal(insecure.ok, false);
  assert.match(insecure.text, /secure page/);
  assert.match(insecure.text, /http:\/\/localhost:7777/);
  assert.match(insecure.text, /photo of the QR/);
  assert.equal(cameraSupport({ isSecureContext: true, hasCamera: true }).ok, true);
  assert.equal(cameraSupport({ isSecureContext: true, hasCamera: false }).ok, false);
});

test('camera failures are explained in plain words', () => {
  assert.match(cameraError({ name: 'NotAllowedError' }), /blocked/);
  assert.match(cameraError({ name: 'NotFoundError' }), /No camera/);
  assert.match(cameraError({ name: 'NotReadableError' }), /busy/);
  assert.match(cameraError({ name: 'Weird', message: 'boom' }), /boom/);
});
