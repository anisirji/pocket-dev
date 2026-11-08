(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  const accept = document.getElementById('accept'), error = document.getElementById('error'), logout = document.getElementById('logout');
  function clearPrivateState() {
    try { sessionStorage.clear(); } catch {}
    try { for (const key of Object.keys(localStorage)) if (key.startsWith('pd.files.')) localStorage.removeItem(key); } catch {}
  }
  if (!token) { accept.disabled = true; error.textContent = 'Open the complete invitation link from the owner, including the part after #.'; }
  accept.onclick = async () => {
    accept.disabled = true; error.textContent = '';
    try {
      const res = await fetch('/api/invitations/accept', { method: 'POST', headers: { 'x-pocket-dev': '1', 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      const result = await res.json();
      if (!res.ok) { if (res.status === 409) logout.hidden = false; throw new Error(result.error); }
      // The token stays in the fragment until acceptance, so a reload is safe
      // and link previews cannot consume it. It is removed after success.
      history.replaceState(null, '', '/');
      clearPrivateState();
      location.replace('/');
    } catch (err) { error.textContent = err.message; accept.disabled = false; }
  };
  logout.onclick = async () => {
    try {
      const res = await fetch('/api/logout', { method: 'POST', headers: { 'x-pocket-dev': '1' } });
      if (!res.ok) throw new Error('Could not log out. Close this session before accepting the invitation.');
      clearPrivateState(); logout.hidden = true; error.textContent = 'Logged out. You can now accept the invitation.';
    } catch (err) { error.textContent = err.message; }
  };
})();
