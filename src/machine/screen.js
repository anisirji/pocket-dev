import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../core/paths.js';
import { platform } from '../core/platform.js';

export const SCREEN_QUALITIES = Object.freeze({ low: { side: 960, quality: 45 }, balanced: { side: 1600, quality: 60 }, high: { side: 2560, quality: 82 } });
const DISPLAY_PROBE = `ObjC.import('AppKit');
const screens = $.NSScreen.screens, result=[];
for(let i=0;i<screens.count && i<16;i++){const s=screens.objectAtIndex(i), f=s.frame;result.push({index:i+1,id:Number(ObjC.unwrap(s.deviceDescription.objectForKey('NSScreenNumber'))),name:ObjC.unwrap(s.localizedName),width:f.size.width,height:f.size.height});}
JSON.stringify(result);`;
let displayCache, displayPending;
export async function screenSupport() {
  const capability = platform.capabilities().screenshot;
  if (!capability.available) return { state: 'unsupported', available: false, message: capability.reason, displays: [], qualities: Object.keys(SCREEN_QUALITIES) };
  if (platform.platform !== 'darwin') return { state: 'ready', available: true, displays: [{ index: 1, name: 'Main display' }], qualities: Object.keys(SCREEN_QUALITIES), monitorSelection: false };
  if (displayCache && Date.now() - displayCache.at < 30000) return displayCache.value;
  displayPending ||= platform.macScript(DISPLAY_PROBE, { timeout: 5000 }).then((result) => {
    let displays;
    try { displays = JSON.parse(result.stdout); } catch {}
    if (result.code !== 0 || !Array.isArray(displays) || !displays.length || displays.some((screen) => !Number.isInteger(screen.index) || screen.index < 1 || screen.index > 16 || typeof screen.name !== 'string' || !Number.isFinite(screen.width) || !Number.isFinite(screen.height))) displays = [{ index: 1, name: 'Main display' }];
    const value = { state: 'ready', available: true, displays, qualities: Object.keys(SCREEN_QUALITIES), monitorSelection: displays.length > 1 };
    displayCache = { at: Date.now(), value }; return value;
  }).finally(() => { displayPending = null; });
  return displayPending;
}

async function take(platform, stateDir, options) {
  // The picture lives in a private folder only while it is being shrunk, then goes. It is never kept.
  const dir = fs.mkdtempSync(path.join(stateDir, 'screen-'));
  try {
    const raw = await platform.screenshot(dir, options);
    const small = path.join(dir, 'small.jpg');
    await platform.resizeImage({ input: raw, output: small, ...SCREEN_QUALITIES[options.quality], onlyShrink: true });
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

export function createScreenCapture({ platform, stateDir }) {
  const pending = new Map(); let queue = Promise.resolve();
  return (given = {}) => {
    const cap = platform.capabilities().screenshot;
    if (!cap.available) return Promise.reject(Object.assign(new Error(`Not available on this system: ${cap.reason}`), { unsupported: true }));
    const options = { quality: given.quality || 'balanced', ...((given.display != null || platform.platform === 'darwin') && { display: Number(given.display ?? 1) }) };
    if (!Object.hasOwn(SCREEN_QUALITIES, options.quality) || (options.display != null && (!Number.isInteger(options.display) || options.display < 1 || options.display > 16 || (platform.platform !== 'darwin' && options.display !== 1)))) return Promise.reject(Object.assign(new Error('Choose an available display and quality.'), { status: 400 }));
    if (platform.platform !== 'darwin') delete options.display;
    const key = JSON.stringify(options); if (pending.has(key)) return pending.get(key);
    if (pending.size >= 8) return Promise.reject(Object.assign(new Error('The screen is busy. Try again shortly.'), { status: 429 }));
    const request = queue.then(() => take(platform, stateDir, options)).finally(() => pending.delete(key));
    pending.set(key, request); queue = request.catch(() => {}); return request;
  };
}
export const captureScreen = createScreenCapture({ platform, stateDir: STATE_DIR });
