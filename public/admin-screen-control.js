(() => {
  const $ = (id) => document.getElementById(id);
  let socket, timer, activeRequest;
  const call = async (path, body) => {
    const response = await fetch(`/api/screen/control/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pocket-admin': '1' }, body: JSON.stringify(body || {}), keepalive: path === 'stop' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Control could not be updated.'); return data;
  };
  function closeHost() { clearInterval(timer); const old = socket; socket = null; old?.close(); }
  function stop() { closeHost(); call('stop').catch(() => {}); update({ state: 'off' }); }
  function update(state = { state: 'off' }) {
    const root = $('screenControlIndicator'); if (!root) return;
    if (state.state === 'off') { activeRequest = null; closeHost(); root.hidden = true; return; }
    root.hidden = false; activeRequest = state.requestId;
    $('screenControlTitle').textContent = state.state === 'awaiting-approval' ? 'Allow control of this Mac?' : 'Desktop control authorized';
    $('screenControlMessage').textContent = `${state.name || 'An authorized connection'} · Display ${state.display}. ${state.state === 'awaiting-approval' ? 'Allow screen control once on this computer for all authorized remote connections. Revoke it here or disable screen control in Permissions.' : state.remembered ? 'Screen control is approved for this computer. Admin can be closed. Stop and revoke ends access for every remote connection.' : 'Keep this Admin tab visible. Hiding or closing it stops control.'}`;
    const actions = $('screenControlActions'); actions.replaceChildren();
    const button = (text, click) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'btn'; node.textContent = text; node.onclick = click; actions.append(node); return node; };
    if (state.state === 'awaiting-approval') {
      button('Decline', async () => { try { await call('approve', { requestId: state.requestId, allow: false }); update({ state: 'off' }); } catch (error) { $('screenControlError').textContent = error.message; } });
      button('Allow and remember', async () => {
        if (document.hidden) return;
        try {
          const approved = await call('approve', { requestId: state.requestId, allow: true });
          if (activeRequest !== state.requestId || (document.hidden && !approved.remembered)) return stop();
          update(approved);
          if (!approved.hostToken) return;
          const connection = socket = new WebSocket(`ws://${location.host}/ws/screen-control-host?token=${approved.hostToken}`);
          connection.onopen = () => { if (socket !== connection || document.hidden) return stop(); connection.send(JSON.stringify({ t: 'ping' })); timer = setInterval(() => { if (socket === connection && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ t: 'ping' })); }, 2000); };
          connection.onmessage = ({ data }) => { let message; try { message = JSON.parse(data); } catch { return stop(); } if (message.t === 'stopped') update({ state: 'off' }); };
          connection.onclose = () => { if (socket === connection) { socket = null; clearInterval(timer); update({ state: 'off' }); } };
          connection.onerror = () => { if (socket === connection) stop(); };
        } catch (error) { $('screenControlError').textContent = error.message; }
      });
    }
    button('Stop and revoke', stop);
  }
  window.pocketDevAdminControl = { update };
  document.addEventListener('visibilitychange', () => { if (document.hidden && socket) stop(); });
  window.addEventListener('pagehide', () => { if (socket) stop(); });
})();
