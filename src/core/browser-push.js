import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
// Only browser vendors' public push services are accepted. An authenticated page cannot turn
// subscription registration into a request to localhost, a private computer or an arbitrary URL.
export function parsePushSubscription(value) {
  if (!value || typeof value !== 'object' || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) throw badRequest('Invalid browser subscription.');
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw badRequest('Invalid browser subscription.'); }
  const host = endpoint.hostname.toLowerCase();
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  if (!allowed || endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password || endpoint.hash) throw badRequest('This browser push service is not supported.');
  const key = (name, length) => {
    const text = value.keys?.[name];
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(text) || Buffer.from(text, 'base64url').length !== length) throw badRequest('Invalid browser encryption keys.');
    return text;
  };
  const p256dh = key('p256dh', 65), auth = key('auth', 16);
  if (Buffer.from(p256dh, 'base64url')[0] !== 4) throw badRequest('Invalid browser encryption key.');
  return { endpoint: endpoint.href, keys: { p256dh, auth } };
}

// A bounded private list of opt-in browser subscriptions, kept alongside existing local state.
// This stores no notification content or history, and starts no listener, poller or separate service.
export function createBrowserPush({ stateDir, authorized, online = () => false, computerId = () => 'local', preferences, library, now = Date.now }) {
  if (library === undefined) { try { library = require('web-push'); } catch { library = null; } }
  const file = path.join(stateDir, 'browser-push.json');
  let saved = null, failure = false, disposed = false;
  const pending = new Set();
  function read() {
    if (saved) return saved;
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!loaded?.keys?.publicKey || !loaded?.keys?.privateKey || !Array.isArray(loaded.subscriptions)) throw new Error('Invalid saved push settings.');
      saved = loaded;
      failure = false;
    } catch (error) {
      if (error.code !== 'ENOENT') { failure = true; throw Object.assign(new Error('Browser notification settings need repair on this computer.'), { status: 503 }); }
      saved = { keys: library.generateVAPIDKeys(), subscriptions: [] }; write();
    }
    return saved;
  }
  function write() {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  function prune() {
    const before = saved.subscriptions.length;
    saved.subscriptions = saved.subscriptions.filter((subscription) => authorized(subscription.deviceId) && now() - subscription.at < 90 * 86400000).slice(-100);
    if (saved.subscriptions.length !== before) write();
  }
  function status(deviceId) {
    if (!library) return { state: 'setup-required', available: false, message: 'Install Pocket Dev with optional dependencies enabled for browser push notifications.' };
    try { read(); prune(); return { state: 'ready', available: true, publicKey: saved.keys.publicKey, registrations: saved.subscriptions.filter((entry) => entry.deviceId === deviceId).map((entry) => entry.id) }; }
    catch { return { state: 'failed', available: false, message: 'Browser notification settings need repair on this computer.' }; }
  }
  function subscribe(deviceId, value) {
    if (!authorized(deviceId)) throw Object.assign(new Error('This device is no longer authorized.'), { status: 403 });
    const state = status(); if (!state.available) throw Object.assign(new Error(state.message), { status: 503 });
    const subscription = parsePushSubscription(value), id = crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
    const existing = saved.subscriptions.find((entry) => entry.id === id);
    if (existing && existing.deviceId !== deviceId) throw Object.assign(new Error('This browser subscription belongs to another login. Turn it off and enable it again.'), { status: 409 });
    // One login can opt in on several origins/browsers, without retaining an unbounded list.
    const mine = saved.subscriptions.filter((entry) => entry.deviceId === deviceId && entry.id !== id).slice(-4);
    const others = saved.subscriptions.filter((entry) => entry.deviceId !== deviceId);
    if (others.length + mine.length >= 100) throw Object.assign(new Error('Too many browser subscriptions. Remove an unused logged-in device first.'), { status: 409 });
    saved.subscriptions = [...others, ...mine, { id, deviceId, at: now(), subscription }]; write();
    return { enabled: true };
  }
  function unsubscribe(deviceId, endpoint) {
    if (!library || !fs.existsSync(file)) return { enabled: false };
    read(); saved.subscriptions = saved.subscriptions.filter((entry) => entry.deviceId !== deviceId || (endpoint && entry.subscription.endpoint !== endpoint)); write();
    return { enabled: false };
  }
  async function deliver(event) {
    if (disposed || !library || failure || !fs.existsSync(file)) return;
    read(); prune();
    const prefs = preferences(); if (prefs[event.category] === false) return;
    // Suppress system push while a visible page receives the live socket event.
    const recipients = saved.subscriptions.filter((entry) => !online(entry.deviceId) && (!event.audience || event.audience.includes(entry.deviceId)));
    await Promise.allSettled(recipients.map(async (entry) => {
      if (disposed || pending.size >= 32 || !authorized(entry.deviceId) || preferences()[event.category] === false) return;
      const payload = JSON.stringify({ id: event.id, scope: `${computerId() || 'local'}:${entry.deviceId}`, category: event.category, title: event.title, body: event.body, sound: Boolean(event.sound && prefs.sounds), action: event.action, at: now() });
      const request = library.sendNotification(entry.subscription, payload, { TTL: 60, urgency: 'normal', timeout: 5000, vapidDetails: { subject: 'https://www.theani.me/work/pocket-dev', ...saved.keys } });
      pending.add(request);
      try { await request; }
      catch (error) {
        if ([404, 410].includes(error.statusCode)) { saved.subscriptions = saved.subscriptions.filter((item) => item.id !== entry.id); write(); }
      } finally { pending.delete(request); }
    }));
  }
  return { status, subscribe, unsubscribe, deliver, close() { disposed = true; }, pending: () => pending.size };
}
