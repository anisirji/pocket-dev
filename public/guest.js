(() => {
  const $ = (id) => document.getElementById(id);
  let accessKey = '', lost = false;
  function clearPrivateState() {
    try { sessionStorage.clear(); } catch {}
    try { for (const key of Object.keys(localStorage)) if (key.startsWith('pd.files.')) localStorage.removeItem(key); } catch {}
  }
  function loseAccess(message) {
    if (!lost) {
      lost = true; clearPrivateState();
      document.querySelector('.fx-root')?.remove();
      $('roots').replaceChildren(); $('summary').textContent = ''; $('details').textContent = ''; $('ai').textContent = '';
    }
    $('project').textContent = 'Access unavailable'; $('error').textContent = message;
  }
  window.api = async (method, url, body) => {
    const res = await fetch(url, { method, headers: { 'x-pocket-dev': '1', ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const result = res.status === 204 ? null : await res.json();
    if (!res.ok) {
      if (res.status === 401) loseAccess('Your session ended. Ask the owner for an invitation.');
      throw Object.assign(new Error(result?.error || `HTTP ${res.status}`), { status: res.status });
    }
    return result;
  };
  async function refresh() {
    try {
      const access = await window.api('GET', '/api/current-access');
      const nextKey = JSON.stringify(access);
      if (accessKey && nextKey !== accessKey) { clearPrivateState(); return location.reload(); }
      accessKey = nextKey;
      $('project').textContent = access.repository;
      $('summary').textContent = `${access.label} · ${access.role === 'developer' ? 'Developer' : 'Viewer'} · Expires ${new Date(access.expiresAt).toLocaleString()}`;
      $('details').textContent = access.role === 'developer' ? 'Edits stay in a project copy for the owner to review. Read-only related folders stay unchanged.' : 'View, preview and download the shared project and related folders.';
      $('ai').textContent = access.aiReason;
      $('error').textContent = '';
      if (!$('roots').childElementCount) for (const root of access.roots) {
        const button = document.createElement('button');
        button.textContent = `${root.name} · ${root.readOnly ? 'Read-only' : 'Project copy, read/write'}`;
        button.onclick = () => window.openFiles(root.path);
        $('roots').append(button);
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) loseAccess(err.message);
      else $('error').textContent = 'Connection lost. Reconnect to check your current access.';
    }
  }
  $('logout').onclick = async () => {
    try { await window.api('POST', '/api/logout'); clearPrivateState(); location.replace('/login.html'); }
    catch (err) { $('error').textContent = err.message; }
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  function resize() {
    document.documentElement.style.setProperty('--guest-top', `${window.visualViewport?.offsetTop || 0}px`);
    document.documentElement.style.setProperty('--guest-h', `${window.visualViewport?.height || innerHeight}px`);
  }
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  window.addEventListener('resize', resize);
  resize();
  setInterval(refresh, 5000);
  refresh();
})();
