import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { STATE_DIR } from './paths.js';

const SCREENCAPTURE = process.env.POCKET_DEV_SCREENCAPTURE || '/usr/sbin/screencapture';
const SIPS = process.env.POCKET_DEV_SIPS || '/usr/bin/sips';
// A Retina screen is about 7 MB as a JPEG; 1600 px wide at quality 60 is a few hundred KB and still readable on a phone.
const MAX_WIDTH = '1600';

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 15_000 }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve(String(stdout))));
});

// sips -Z also enlarges, so a small screen would be blown up. Only shrink what is wider than MAX_WIDTH.
async function longestSide(file) {
  const out = await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  return Math.max(...[...out.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])));
}

async function take() {
  // The picture lives in a private folder only while it is being shrunk, then goes. It is never kept.
  const dir = fs.mkdtempSync(path.join(STATE_DIR, 'screen-'));
  try {
    const raw = path.join(dir, 'raw.jpg');
    const small = path.join(dir, 'small.jpg');
    await run(SCREENCAPTURE, ['-x', '-m', '-t', 'jpg', raw]);
    const shrink = (await longestSide(raw)) > Number(MAX_WIDTH) ? ['-Z', MAX_WIDTH] : [];
    await run(SIPS, [...shrink, '-s', 'format', 'jpeg', '-s', 'formatOptions', '60', raw, '--out', small]);
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
  inFlight ??= take().finally(() => { inFlight = null; });
  return inFlight;
}
