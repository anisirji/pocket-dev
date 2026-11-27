(() => {
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('pocket-dev-workspace-access') : null;
  async function clear(broadcast = true) {
    if (broadcast) channel?.postMessage('clear');
    window.dispatchEvent(new Event('pd-workspace-clear'));
    try { for (const key of Object.keys(sessionStorage)) if (/^(m\.[0-9a-f]+:)?pd\.navigation:/.test(key)) delete sessionStorage[key]; } catch {}
    if (!window.indexedDB) return;
    await new Promise((resolve) => {
      const request = indexedDB.open('pocket-dev-workspaces', 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('workspaces')) request.result.createObjectStore('workspaces', { keyPath: 'key' }); };
      request.onerror = () => resolve();
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('workspaces')) { db.close(); resolve(); return; }
        const tx = db.transaction('workspaces', 'readwrite'); tx.objectStore('workspaces').clear();
        tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
      };
    });
  }
  window.clearPocketWorkspaceData = clear;
  if (channel) channel.onmessage = () => clear(false);
  if (location.pathname === '/login.html') clear();
})();
