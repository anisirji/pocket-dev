import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const NOTIFICATION_DEFAULTS = Object.freeze({ aiTasks: true, attention: true, messages: true, builds: true, sounds: false, inAppUpdates: true });
export function notificationPreferences(config) {
  const saved = config.read().notifications || {};
  return Object.fromEntries(Object.entries(NOTIFICATION_DEFAULTS).map(([key, value]) => [key, typeof saved[key] === 'boolean' ? saved[key] : value]));
}
export function setNotificationPreferences(config, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw Object.assign(new Error('Expected notification preferences.'), { status: 400 });
  for (const [key, value] of Object.entries(changes)) if (!Object.hasOwn(NOTIFICATION_DEFAULTS, key) || typeof value !== 'boolean') throw Object.assign(new Error(`Invalid notification preference: ${key}`), { status: 400 });
  const notifications = { ...notificationPreferences(config), ...changes }; config.update({ notifications }); return notifications;
}

// A live fanout over the application's existing sockets. No notification history is stored or replayed.
export function createNotifications({ config, computerId = () => null, computerName = () => os.hostname(), deliverPush = () => {} }) {
  const clients = new Set(), seen = new Map(), pendingCompletion = new Map();
  const preferences = () => notificationPreferences(config);
  const send = (ws, message) => { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); } catch {} };
  function publish(event) {
    if (!event || typeof event.id !== 'string' || seen.has(event.id)) return null;
    seen.set(event.id, Date.now());
    while (seen.size > 512) seen.delete(seen.keys().next().value);
    if (preferences()[event.category] === false) return null;
    const notice = { at: Date.now(), sound: false, computerId: computerId(), ...event };
    for (const client of clients) if (!notice.audience || notice.audience.includes(client.deviceId)) send(client.ws, { t: 'notification', notification: notice });
    try { Promise.resolve(deliverPush(notice)).catch(() => {}); } catch {}
    return notice;
  }
  function chatEvent(chat, event) {
    const meta = chat.view();
    if (event.type === 'meta') {
      for (const client of clients) send(client.ws, { t: 'chat-status', chat: meta });
      const pending = pendingCompletion.get(chat.id);
      if (pending && meta.activity === 'completed') { pendingCompletion.delete(chat.id); return chatEvent(chat, pending); }
      return;
    }
    const name = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', copilot: 'Copilot' }[chat.tool] || 'AI';
    let title, category = 'aiTasks', sound = false;
    if (event.type === 'result') {
      pendingCompletion.delete(chat.id);
      if (event.status === 'done' && meta.activity === 'working') {
        pendingCompletion.set(chat.id, event);
        while (pendingCompletion.size > 512) pendingCompletion.delete(pendingCompletion.keys().next().value);
        return;
      }
      if (event.status === 'done') { title = `${name} completed your task`; sound = true; }
      else title = `${name} was interrupted`;
    } else if (event.type === 'permission-request' || event.type === 'question') {
      title = event.type === 'question' ? `${name} needs your input` : `${name} needs approval`; category = 'attention'; sound = true;
    } else if (event.type === 'error' && !chat.turn) { pendingCompletion.delete(chat.id); title = `${name} stopped unexpectedly`; }
    if (!title) return;
    return publish({ id: `chat:${chat.id}:${event.id}`, category, title, body: `${computerName()} · ${path.basename(chat.cwd) || chat.cwd}`, chatId: chat.id, sound, action: { kind: 'chat', id: chat.id } });
  }
  function attach(ws, device, chats = []) {
    const client = { ws, deviceId: device.id }; clients.add(client);
    ws.on('close', () => clients.delete(client));
    ws.on('message', (raw) => { try { if (JSON.parse(raw).t === 'ping') send(ws, { t: 'pong' }); } catch {} });
    send(ws, { t: 'hello', scope: `${computerId() || 'local'}:${device.id}`, preferences: preferences(), chats });
  }
  function preferencesChanged() { for (const client of clients) send(client.ws, { t: 'preferences', preferences: preferences() }); }
  return { attach, publish, chatEvent, preferences, preferencesChanged, online: (deviceId) => [...clients].some((client) => client.deviceId === deviceId && client.ws.readyState === client.ws.OPEN), close() { for (const client of clients) client.ws.close(); clients.clear(); pendingCompletion.clear(); } };
}

export function notificationSettings(config) {
  const value = config.read();
  return { preferences: notificationPreferences(config), updateCheck: value.updateCheck !== false, updateNotify: value.updateNotify !== false };
}
export function updateNotificationSettings(config, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Expected notification settings.'), { status: 400 });
  for (const [key, value] of Object.entries(body)) {
    if (!['preferences', 'updateCheck', 'updateNotify'].includes(key)) throw Object.assign(new Error(`Unknown notification setting: ${key}`), { status: 400 });
    if (key !== 'preferences' && typeof value !== 'boolean') throw Object.assign(new Error(`${key} must be true or false.`), { status: 400 });
    if (key === 'preferences') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Expected notification preferences.'), { status: 400 });
      for (const [name, enabled] of Object.entries(value)) if (!Object.hasOwn(NOTIFICATION_DEFAULTS, name) || typeof enabled !== 'boolean') throw Object.assign(new Error(`Invalid notification preference: ${name}`), { status: 400 });
    }
  }
  const changes = {};
  if (body.preferences) changes.notifications = { ...notificationPreferences(config), ...body.preferences };
  for (const key of ['updateCheck', 'updateNotify']) if (Object.hasOwn(body, key)) changes[key] = body[key];
  config.update(changes); return notificationSettings(config);
}
