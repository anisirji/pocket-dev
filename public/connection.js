// One socket lifecycle for Terminal and Chat. Nothing sent by the user is
// buffered or replayed here: reconnecting must never repeat a command/message.
(() => {
  class PocketDevConnection {
    constructor(options) {
      this.options = options;
      this.socket = null;
      this.generation = 0;
      this.attempt = 0;
      this.timers = new Set();
      this.disposed = false;
      this.paused = false;
      this.state = 'connecting';
      this.wake = () => { if (!document.hidden) this.connect(); };
      this.visibility = () => document.hidden ? this.suspend() : this.wake();
      this.offline = () => { this.reset(); this.setState('offline'); };
      document.addEventListener('visibilitychange', this.visibility);
      window.addEventListener('pageshow', this.wake);
      window.addEventListener('online', this.wake);
      window.addEventListener('offline', this.offline);
      this.connect();
    }

    later(fn, ms) {
      const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
      this.timers.add(timer);
      return timer;
    }

    clear(timer) { clearTimeout(timer); this.timers.delete(timer); }

    setState(state) {
      this.state = state;
      this.options.onState?.(state);
    }

    reset() {
      this.generation++;
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
      this.abortController?.abort();
      const old = this.socket;
      this.socket = null;
      old?.close();
    }

    suspend() {
      this.reset();
      this.setState('paused');
    }

    async connect() {
      if (this.disposed || this.paused) return;
      this.reset();
      if (navigator.onLine === false) return this.setState('offline');
      if (document.hidden) return this.setState('paused');
      const generation = this.generation;
      const abortController = new AbortController();
      this.abortController = abortController;
      const current = () => !this.disposed && generation === this.generation;
      this.setState(this.attempt ? 'reconnecting' : 'connecting');
      const timeout = this.later(() => { if (current()) this.retry(); }, 15000);
      try {
        const allowed = await this.options.beforeConnect?.(abortController.signal);
        if (!current()) return;
        if (allowed === false) { this.paused = true; this.suspend(); return; }
        const ws = new WebSocket(this.options.url());
        this.socket = ws;
        let heartbeat, deadline;
        const alive = () => {
          this.clear(deadline);
          this.clear(heartbeat);
          heartbeat = this.later(() => {
            if (!current()) return;
            if (!this.send({ t: 'ping' })) return this.retry();
            deadline = this.later(() => { if (current()) this.retry(); }, 10000);
          }, 15000);
        };
        ws.onopen = () => {
          if (!current()) return;
          this.options.onOpen?.(ws);
          if (!this.options.waitForHello) {
            this.clear(timeout);
            this.attempt = 0;
            this.setState('connected');
          }
          alive();
        };
        ws.onmessage = (event) => {
          if (!current()) return;
          let msg;
          try { msg = JSON.parse(event.data); } catch { return; }
          if (!msg || typeof msg !== 'object') return;
          alive();
          if (msg.t === 'pong') return;
          if (!this.options.waitForHello || msg.t === 'hello') {
            this.clear(timeout);
            this.attempt = 0;
            this.setState('connected');
          }
          this.options.onMessage?.(msg);
        };
        ws.onclose = (event) => {
          if (!current()) return;
          if (this.options.onClose?.(event) === false) {
            this.paused = true;
            this.suspend();
          } else this.retry();
        };
        ws.onerror = () => { if (current()) this.retry(); };
      } catch {
        if (current()) this.retry();
      }
    }

    retry() {
      this.reset();
      if (this.disposed || this.paused) return;
      if (navigator.onLine === false) return this.setState('offline');
      if (document.hidden) return this.setState('paused');
      this.setState('reconnecting');
      const delay = [1000, 2000, 4000, 8000, 10000][Math.min(this.attempt++, 4)];
      this.later(() => this.connect(), delay);
    }

    send(message) {
      if (this.socket?.readyState !== WebSocket.OPEN) return false;
      try { this.socket.send(JSON.stringify(message)); return true; }
      catch { this.retry(); return false; }
    }

    resume() { this.paused = false; this.attempt = 0; this.connect(); }

    dispose() {
      this.disposed = true;
      this.reset();
      document.removeEventListener('visibilitychange', this.visibility);
      window.removeEventListener('pageshow', this.wake);
      window.removeEventListener('online', this.wake);
      window.removeEventListener('offline', this.offline);
    }
  }
  window.PocketDevConnection = PocketDevConnection;

  // Keep one draft per chat. Session storage is scoped to this browser tab;
  // the in-memory copy also works when storage is unavailable.
  class PocketDevDrafts {
    constructor(storage) { this.storage = storage; this.items = new Map(); }

    get(id) {
      if (this.items.has(id)) return this.items.get(id);
      let draft = { text: '', files: [], attempt: null };
      try {
        const saved = JSON.parse(this.storage.getItem(`pd.chat.draft.${id}`));
        if (saved && typeof saved.text === 'string' && Array.isArray(saved.files)) {
          const attempt = saved.attempt;
          const validAttempt = typeof attempt?.id === 'string' && /^[0-9a-zA-Z_-]{16,80}$/.test(attempt.id) && typeof attempt.text === 'string' && Array.isArray(attempt.attachments) && attempt.attachments.every((p) => typeof p === 'string');
          draft = { text: saved.text, files: saved.files.filter((f) => typeof f?.name === 'string' && typeof f.path === 'string'), attempt: validAttempt ? attempt : null };
        }
      } catch {}
      this.items.set(id, draft);
      return draft;
    }

    save(id, text, files, attempt = this.get(id).attempt) {
      const draft = { text, files, attempt };
      this.items.set(id, draft);
      try {
        const key = `pd.chat.draft.${id}`;
        const uploaded = files.filter((f) => f.path).map(({ name, path }) => ({ name, path }));
        if (text || uploaded.length) this.storage.setItem(key, JSON.stringify({ text, files: uploaded, attempt }));
        else this.storage.removeItem(key);
      } catch {}
      return draft;
    }

    submission(id) {
      const draft = this.get(id);
      const text = draft.text.trim();
      const attachments = draft.files.filter((f) => f.path).map((f) => f.path);
      const same = draft.attempt?.text === text && JSON.stringify(draft.attempt?.attachments) === JSON.stringify(attachments);
      const clientMessageId = same ? draft.attempt.id : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const attempt = { id: clientMessageId, text, attachments };
      this.save(id, draft.text, draft.files, attempt);
      return { text, attachments, clientMessageId, originalText: draft.text, files: [...draft.files] };
    }

    acknowledge(id, sent) {
      const draft = this.get(id);
      // A successful old request must not erase text or attachments added later.
      return this.save(id, draft.text === sent.originalText ? '' : draft.text,
        draft.files.filter((f) => !sent.files.includes(f)), null);
    }
  }
  window.PocketDevDrafts = PocketDevDrafts;
})();
