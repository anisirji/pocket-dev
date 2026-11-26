// Workspace-only state. Authentication and filesystem access are always checked by the host.
export const sensitivePath = (path) => /(^|[\\/])(?:\.(?:ssh|aws|gnupg)(?:[\\/]|$)|\.env(?:\..*)?$|credentials(?:\..*)?$|id_(?:rsa|ed25519).*$|[^\\/]*\.(?:pem|key|p12|pfx)$)/i.test(path);
export const within = (path, root) => path === root || path.startsWith(root.replace(/[\\/]$/, '') + (root.includes('\\') ? '\\' : '/'));

export class Scheduler {
  constructor(limit = 4) { this.limit = limit; this.running = 0; this.jobs = new Map(); this.epoch = 0; }
  read(key, run, priority = 0) {
    const existing = this.jobs.get(key);
    if (existing) { existing.priority = Math.min(priority, existing.priority); this.pump(); return existing.promise; }
    const job = { key, run, priority, at: Date.now(), epoch: this.epoch, controller: new AbortController() };
    job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    this.jobs.set(key, job); this.pump(); return job.promise;
  }
  pump() {
    while (this.running < this.limit) {
      const job = [...this.jobs.values()].filter((j) => !j.started).sort((a, b) => (a.priority - (Date.now() - a.at) / 5000) - (b.priority - (Date.now() - b.at) / 5000))[0];
      if (!job) return;
      if (job.priority >= 2 && this.running >= this.limit - 1 && this.limit > 1) return;
      job.started = true; this.running++;
      Promise.resolve().then(() => job.run(job.controller.signal)).then((value) => {
        if (job.epoch !== this.epoch) throw new DOMException('Workspace changed', 'AbortError');
        job.resolve(value);
      }).catch(job.reject).finally(() => { if (this.jobs.get(job.key) === job) this.jobs.delete(job.key); this.running--; this.pump(); });
    }
  }
  cancelReads() {
    this.epoch++;
    for (const job of this.jobs.values()) { job.controller.abort(); if (!job.started) job.reject(new DOMException('Workspace changed', 'AbortError')); }
    this.jobs.clear();
  }
}

const DB = 'pocket-dev-workspaces', MAX_BYTES = 32 * 1024 * 1024, MAX_AGE = 7 * 86400000;
export class WorkspaceCache {
  constructor(namespace, { maxBytes = MAX_BYTES, retention = MAX_AGE } = {}) { this.namespace = namespace; this.maxBytes = maxBytes; this.retention = retention; this.memory = new Map(); }
  async db() {
    if (typeof indexedDB === 'undefined') return null;
    this.pending ||= new Promise((resolve) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('workspaces', { keyPath: 'key' });
      req.onerror = () => resolve(null); req.onblocked = () => resolve(null);
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    });
    return this.pending;
  }
  key(root) { return JSON.stringify([this.namespace, root]); }
  async get(root) {
    const db = await this.db(), key = this.key(root);
    let value = this.memory.get(key);
    if (db) value = await new Promise((resolve) => { const req = db.transaction('workspaces').objectStore('workspaces').get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null); });
    if (!value || (Date.now() - value.at > this.retention && !value.draft)) return null;
    return value.data;
  }
  async put(root, data) {
    // Sensitive file drafts stay in memory, but never enter persistent storage.
    const safe = { ...data, tabs: (data.tabs || []).filter((f) => !sensitivePath(f.path)) };
    const value = { key: this.key(root), namespace: this.namespace, at: Date.now(), draft: safe.tabs.some((f) => !f.media && f.content !== f.saved) || Boolean(safe.chatSnapshot?.draft), data: safe };
    value.bytes = JSON.stringify(value).length * 2;
    this.memory.set(value.key, value);
    let memoryBytes = 0;
    for (const item of [...this.memory.values()].sort((a, b) => b.at - a.at)) { memoryBytes += item.bytes; if (!item.draft && (memoryBytes > this.maxBytes || Date.now() - item.at > this.retention)) this.memory.delete(item.key); }
    const db = await this.db(); if (!db) return;
    await new Promise((resolve) => { const tx = db.transaction('workspaces', 'readwrite'); tx.objectStore('workspaces').put(value); tx.oncomplete = tx.onerror = tx.onabort = resolve; });
    await this.prune();
  }
  async prune() {
    const db = await this.db(); if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction('workspaces', 'readwrite'), store = tx.objectStore('workspaces'), req = store.getAll();
      req.onsuccess = () => {
        const all = req.result.sort((a, b) => b.at - a.at); let size = 0;
        for (const item of all) { size += item.bytes || 0; if (!item.draft && (size > this.maxBytes || Date.now() - item.at > this.retention)) store.delete(item.key); }
      };
      tx.oncomplete = tx.onerror = tx.onabort = resolve;
    });
  }
  async clear() {
    this.memory.clear(); const db = await this.db(); if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction('workspaces', 'readwrite'), store = tx.objectStore('workspaces'), req = store.openCursor();
      req.onsuccess = () => { const cursor = req.result; if (!cursor) return; if (cursor.value.namespace === this.namespace) cursor.delete(); cursor.continue(); };
      tx.oncomplete = tx.onerror = tx.onabort = resolve;
    });
  }
}

export class WorkspaceContext extends EventTarget {
  constructor() { super(); this.value = null; this.generation = 0; }
  set(value) { this.generation++; this.value = { ...value, workspaceId: JSON.stringify([value.deviceId, value.rootPath]) }; this.dispatchEvent(new Event('change')); return this.value; }
  update(patch) { if (this.value) { Object.assign(this.value, patch); this.dispatchEvent(new Event('update')); } }
  capture() { const generation = this.generation; return () => generation === this.generation; }
}
