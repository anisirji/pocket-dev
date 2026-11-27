(() => {
  const labels = { aiTasks: 'AI task notifications', attention: 'Approval and input notifications', messages: 'Message notifications', builds: 'Monitored build notifications', sounds: 'Notification sounds', inAppUpdates: 'In-app update reminders' };
  const make = (tag, text) => { const node = document.createElement(tag); if (text != null) node.textContent = text; return node; };
  function mount(container, api, { lazy = false } = {}) {
    if (!container) return;
    container.classList.add('pd-notification-preferences');
    let observer, loaded = false, settings;
    const error = make('p'); error.className = 'st-err err'; error.setAttribute('role', 'alert');
    async function load() {
      if (loaded) return; loaded = true; observer?.disconnect();
      container.replaceChildren(make('h3', 'Notifications'), make('p', 'Reading preferences…'));
      try { settings = await api('GET', '/api/notifications'); render(); }
      catch (failure) { loaded = false; error.textContent = failure.message; const retry = make('button', 'Try again'); retry.className = 'st-btn btn'; retry.onclick = load; container.replaceChildren(error, retry); }
    }
    function row(key, label, preference) {
      const wrapper = make('label'), input = make('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = preference ? settings.preferences[key] : settings[key];
      wrapper.append(make('span', label), input);
      input.onchange = async () => {
        const enabled = input.checked; input.disabled = true; error.textContent = '';
        if (key === 'sounds' && enabled) window.PocketDevNotifications?.setPreferences({ ...settings.preferences, sounds: true });
        try {
          settings = await api('PUT', '/api/notifications', preference ? { preferences: { [key]: enabled } } : { [key]: enabled });
          window.PocketDevNotifications?.setPreferences(settings.preferences);
          input.checked = preference ? settings.preferences[key] : settings[key];
        } catch (failure) { input.checked = !enabled; error.textContent = failure.message; window.PocketDevNotifications?.setPreferences(settings.preferences); }
        finally { input.disabled = false; }
      };
      return wrapper;
    }
    function render() {
      const note = make('p', 'Alerts disappear automatically. Task states stay in Chats. Sounds start after interacting with this page.'); note.className = 'st-note note';
      container.replaceChildren(make('h3', 'Notifications'), ...Object.entries(labels).map(([key, label]) => row(key, label, true)), row('updateNotify', 'Desktop update reminders', false), row('updateCheck', 'Automatic update checks', false), note, error);
      if (window.PocketDevNotifications) mountPush();
    }
    async function mountPush() {
      const section = make('div'), note = make('p'), button = make('button', 'Enable browser notifications');
      note.className = 'st-note note'; button.className = 'st-btn btn'; button.type = 'button';
      section.append(make('h3', 'While Pocket is closed'), note); container.append(section);
      if (!window.isSecureContext) { note.textContent = 'Browser push needs HTTPS. Live alerts still work while Pocket is open on this Wi-Fi address.'; return; }
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { note.textContent = 'This browser does not support push here. On iPhone, add Pocket to your Home Screen and open it from there.'; return; }
      let registration, subscription, orphan, state;
      button.disabled = true; section.append(button); note.textContent = 'Checking browser support…';
      const show = () => { button.textContent = subscription ? 'Turn off browser notifications' : 'Enable browser notifications'; note.textContent = subscription ? 'Enabled for this browser and login. Notifications use your browser’s push service. Pocket must stay running on the computer.' : 'Optional alerts through your browser’s push service. On iPhone, open Pocket from the Home Screen. Permission is requested only when you enable this.'; };
      try {
        state = await api('GET', '/api/notifications/push');
        if (!state.available) { note.textContent = state.message; button.remove(); return; }
        registration = await navigator.serviceWorker.getRegistration('/');
        if (registration?.active?.scriptURL === new URL('/notifications-worker.js', location.origin).href) {
          subscription = await registration.pushManager.getSubscription();
          if (subscription) {
            const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
            if (!state.registrations?.includes(hash)) { orphan = subscription; subscription = null; }
          }
        }
        else registration = null;
        show(); button.disabled = false;
      } catch (failure) { note.textContent = failure.message; button.remove(); return; }
      button.onclick = async () => {
        button.disabled = true; error.textContent = '';
        try {
          if (subscription) {
            await api('DELETE', '/api/notifications/push', { endpoint: subscription.endpoint });
            await subscription.unsubscribe(); subscription = null;
          } else {
            if (await Notification.requestPermission() !== 'granted') throw new Error('Browser notifications were not allowed. You can change this in the browser’s site settings.');
            if (orphan) { await orphan.unsubscribe(); orphan = null; }
            registration ||= await navigator.serviceWorker.register('/notifications-worker.js');
            await navigator.serviceWorker.ready;
            const key = Uint8Array.from(atob(state.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
            const created = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
            try { await api('POST', '/api/notifications/push', created.toJSON()); subscription = created; }
            catch (failure) { await created.unsubscribe(); throw failure; }
          }
        } catch (failure) { error.textContent = failure.message; }
        finally { button.disabled = false; show(); }
      };
    }
    if (lazy && typeof IntersectionObserver === 'function') { observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) load(); }); observer.observe(container); }
    else load();
    return { dispose: () => observer?.disconnect() };
  }
  window.PocketNotificationPreferences = { mount };
})();
