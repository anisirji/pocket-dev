// Push only: this worker does not cache pages or intercept requests.
importScripts('/notification-store.js');
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let notice; try { notice = event.data.json(); } catch { return; }
    if (!notice?.id || !notice.scope || Date.now() - notice.at > 60000) return;
    // Recheck the login and preference immediately before displaying delayed delivery.
    // An offline worker drops the alert rather than exposing it after access was revoked.
    let settings; try { const response = await fetch('/api/notifications', { credentials: 'include', cache: 'no-store' }); if (!response.ok) return; settings = await response.json(); } catch { return; }
    if (settings.scope !== notice.scope || settings.preferences?.[notice.category] === false) return;
    if (!await PocketNotificationStore.claim(notice.scope, notice.id)) return;
    await self.registration.showNotification(notice.title || 'Pocket Dev', { body: notice.body || '', tag: notice.id, renotify: false, silent: !notice.sound || !settings.preferences?.sounds, data: { action: notice.action } });
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.notification.data?.action;
  const hash = action?.kind === 'chat' && /^[a-zA-Z0-9_-]{1,100}$/.test(action.id) ? `#chat=${encodeURIComponent(action.id)}` : action?.kind === 'message' && /^(everyone|[0-9a-f]{16})$/.test(action.id) ? `#messages=${encodeURIComponent(action.id)}` : action?.kind === 'terminal' && /^[0-9a-f]{12}$/.test(action.id) ? `#terminal=${encodeURIComponent(action.id)}` : '';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = new URL(`/${hash}`, self.location.origin).href;
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin && !new URL(client.url).pathname.startsWith('/camera-host'));
    if (existing) { await existing.navigate(target); await existing.focus(); }
    else await self.clients.openWindow(target);
  })());
});
