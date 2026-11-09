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
    throw new Error(`Could not capture the screen. The display may be asleep or the Mac locked. ${err.stderr?.trim() ?? ''}`.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let inFlight = null;
// One capture at a time: a fast refresh, or two phones, share the picture being taken.
export function captureScreen() {
  const cap = platform.capabilities().screenshot;
  if (!cap.available) return Promise.reject(Object.assign(new Error(`Not available on this system: ${cap.reason}`), { unsupported: true }));
  inFlight ??= take().finally(() => { inFlight = null; });
  return inFlight;
}
