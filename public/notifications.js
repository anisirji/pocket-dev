// Transient alerts; no inbox and no persisted message content. Only event IDs are retained briefly to deduplicate tabs.
(() => {
  const defaults = { aiTasks: true, attention: true, messages: true, builds: true, sounds: false, inAppUpdates: true };
  let preferences = { ...defaults }, scope = '', connection, timer, audio, disposed = false;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('pd-live-status') : null;
  function dispatchStatus(chat) {
    if (!chat || typeof chat.id !== 'string') return;
    document.dispatchEvent(new CustomEvent('pd-chat-status', { detail: chat }));
    for (const frame of document.querySelectorAll('iframe')) try { frame.contentDocument?.dispatchEvent(new CustomEvent('pd-chat-status', { detail: chat })); } catch {}
  }
  if (channel) channel.onmessage = ({ data }) => { if (data?.scope === scope && data.chat) dispatchStatus(data.chat); };
  const element = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text != null) node.textContent = text; return node; };
  let toast;
  function dismiss() { clearTimeout(timer); if (toast) toast.hidden = true; }
  function unlockAudio() { if (!preferences.sounds) return; try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume().catch(() => {}); } catch {} }
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  function sound() {
    if (!preferences.sounds || audio?.state !== 'running') return;
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.frequency.value = 660; gain.gain.setValueAtTime(0.035, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.13);
  }
  async function open(action) {
    if (action?.kind === 'chat') {
      if (window.PocketWorkspace?.openChat) return window.PocketWorkspace.openChat(action.id);
      if (window.pocketDevChat) return window.pocketDevChat.open(action.id);
      location.assign(`/#chat=${encodeURIComponent(action.id)}`);
    } else if (action?.kind === 'message') {
      if (window.pocketDevMessages) return window.pocketDevMessages.open(action.id);
      location.assign(`/#messages=${encodeURIComponent(action.id)}`);
    } else if (action?.kind === 'terminal' && /^[0-9a-f]{12}$/.test(action.id)) {
      if (window.pocketDev?.openSession) {
        const response = await fetch('/api/sessions', { cache: 'no-store' }); if (!response.ok) throw new Error('Could not open the terminal.');
        const session = (await response.json()).find((entry) => entry.id === action.id);
        if (session) return window.pocketDev.openSession(session);
      }
      location.assign(`/#terminal=${encodeURIComponent(action.id)}`);
    }
  }
  async function notify(event, onOpen) {
    if (!event?.id || disposed || preferences[event.category] === false) return false;
    if (!await window.PocketNotificationStore.claim(scope, event.id) || disposed) return false;
    if (event.action?.kind === 'message' && window.pocketDevMessages?.isViewing(event.action.id)) return false;
    if (event.sound) sound();
    if (!toast) {
      toast = element('aside', 'pd-alert'); toast.hidden = true; toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite'); document.body.append(toast);
    }
    const message = element('button', 'pd-alert-message'); message.type = 'button';
    message.append(element('strong', '', event.title), element('span', '', event.body || ''));
    message.onclick = () => { dismiss(); Promise.resolve(onOpen ? onOpen() : open(event.action)).catch(() => {}); };
    const close = element('button', 'pd-alert-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Dismiss notification'); close.onclick = dismiss;
    toast.replaceChildren(message, close); toast.hidden = false; clearTimeout(timer); timer = setTimeout(dismiss, 7000);
    return true;
  }
  function setPreferences(value) { preferences = { ...defaults, ...value }; document.dispatchEvent(new CustomEvent('pd-notification-preferences', { detail: preferences })); for (const frame of document.querySelectorAll('iframe')) try { frame.contentDocument?.dispatchEvent(new CustomEvent('pd-notification-preferences', { detail: preferences })); } catch {} }
  function start() {
    if (parent !== window) {
      try { if (parent.PocketDevNotifications) { channel?.close(); window.PocketDevNotifications = parent.PocketDevNotifications; return; } } catch {}
    }
    if (typeof window.PocketDevConnection !== 'function') return;
    connection = new window.PocketDevConnection({
      url: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/notifications`, waitForHello: true,
      onMessage(message) {
        if (message.t === 'hello') { scope = message.scope; setPreferences(message.preferences); for (const chat of message.chats || []) dispatchStatus(chat); }
        else if (message.t === 'preferences') setPreferences(message.preferences);
        else if (message.t === 'chat-status') { dispatchStatus(message.chat); channel?.postMessage({ scope, chat: message.chat }); }
        else if (message.t === 'notification') notify(message.notification);
      },
    });
  }
  window.PocketDevNotifications = { notify, setPreferences, preferences: () => ({ ...preferences }), dismiss, dispose() { disposed = true; connection?.dispose(); dismiss(); channel?.close(); audio?.close(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  window.addEventListener('pagehide', () => { dismiss(); });
})();
