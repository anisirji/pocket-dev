// Shared by visible pages and the push worker. Only event IDs and expiration times are stored.
(() => {
  let databasePromise;
  const fallback = new Set();
  function database() {
    return databasePromise ||= new Promise((resolve) => {
      if (!globalThis.indexedDB) return resolve(null);
      const request = indexedDB.open('pd-alert-ids', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('ids', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    });
  }
  async function claim(scope, id) {
    const key = `${scope}:${id}`, db = await database();
    if (!db) { if (fallback.has(key)) return false; fallback.add(key); if (fallback.size > 256) fallback.delete(fallback.values().next().value); return true; }
    return new Promise((resolve) => {
      let transaction;
      try { transaction = db.transaction('ids', 'readwrite'); } catch { return resolve(false); }
      const store = transaction.objectStore('ids'); let won = false;
      const add = store.add({ id: key, expires: Date.now() + 86400000 });
      add.onsuccess = () => { won = true; };
      add.onerror = (event) => { event.preventDefault(); event.stopPropagation(); };
      const cursor = store.openCursor(); cursor.onsuccess = () => { const row = cursor.result; if (row) { if (row.value.expires < Date.now()) row.delete(); row.continue(); } };
      transaction.oncomplete = () => resolve(won); transaction.onerror = transaction.onabort = () => resolve(false);
    });
  }
  globalThis.PocketNotificationStore = { claim };
})();
