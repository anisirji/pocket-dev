import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';
import { platform } from './platform.js';

// A Retina screen is about 7 MB as a JPEG; 1600 px wide at quality 60 is a few hundred KB and still readable on a phone.
const MAX_WIDTH = 1600;

async function take() {
  // The picture lives in a private folder only while it is being shrunk, then goes. It is never kept.
  const dir = fs.mkdtempSync(path.join(STATE_DIR, 'screen-'));
  try {
    const raw = await platform.screenshot(dir);
    const small = path.join(dir, 'small.jpg');
    await platform.resizeImage({ input: raw, output: small, side: MAX_WIDTH, quality: 60, onlyShrink: true });
    return fs.readFileSync(small);
  } catch (err) {
    throw captureError(err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const WHY = {
  win32: 'Windows allows a screen picture only from the signed-in desktop: the screen must be unlocked, and Pocket Dev must run as that user (pocket-dev start, or Start at login), not as a system service.',
};

export function captureError(err, os = platform.platform, host = platform.host) {
  const why = WHY[os] ?? `The display may be asleep or ${host.the} locked.`;
  const detail = String(err.stderr ?? '').trim().split(/\r?\n/)[0];
  return new Error(`Could not capture the screen. ${why}${detail ? ` (${detail})` : ''}`);
}

let inFlight = null;
// One capture at a time: a fast refresh, or two phones, share the picture being taken.
export function captureScreen() {
  const cap = platform.capabilities().screenshot;
  if (!cap.available) return Promise.reject(Object.assign(new Error(`Not available on this system: ${cap.reason}`), { unsupported: true }));
  inFlight ??= take().finally(() => { inFlight = null; });
  return inFlight;
}
