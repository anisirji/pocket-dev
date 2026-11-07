// The "This Mac" part of the phone's Settings sheet: phone access and starting at login. A phone can disconnect but
// never connect (once closed, nothing reaches the Mac), and stopping Pocket Dev is left to the Mac's admin page.
// `api(method, url, body)` resolves to the JSON reply and throws an Error carrying the server's message.
const STYLE = `
.sv-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 6px 0 12px; }
.sv-row + .sv-row { padding-top: 12px; border-top: 1px solid var(--line); }
.sv-text { display: grid; gap: 2px; min-width: 0; }
.sv-text b { font-size: 15px; font-weight: 600; }
.sv-text small { color: var(--muted); font-size: 13px; }
.sv-live { display: inline-flex; align-items: center; gap: 7px; }
.sv-live::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--ok, #7ee787); box-shadow: 0 0 0 3px #7ee78726; }
.sv-update { background: var(--accent); border-color: var(--accent); color: #08101e; }
.sv-switch { appearance: none; flex: none; width: 50px; height: 30px; margin: 0; border-radius: 15px; background: #2c3445; position: relative; }
.sv-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #c9d0dc; transition: transform .15s; }
.sv-switch:checked { background: var(--accent); }
.sv-switch:checked::after { transform: translateX(20px); background: #fff; }
.sv-switch:disabled { opacity: .4; }
`;

const h = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

function addStyle() {
  if (document.getElementById('sv-style')) return;
  const style = h('style', null, STYLE);
  style.id = 'sv-style';
  document.head.append(style);
}

export async function renderServiceSection(container, api = window.api) {
  addStyle();
  const err = h('p', 'st-err');
  const title = h('h3', null, 'This Mac');

  const access = h('div', 'sv-row');
  const accessText = h('div', 'sv-text');
  accessText.append(h('b', 'sv-live', 'Connected'), h('small', null, `Your phone reaches the Mac at ${location.host}.`));
  const disconnect = h('button', 'st-btn st-danger', 'Disconnect');
  disconnect.type = 'button';
  disconnect.onclick = async () => {
    if (!confirm('Disconnect this phone and every other device? You can reconnect only from the Mac.')) return;
    try {
      await api('POST', '/api/access/disconnect', {});
      accessText.replaceChildren(h('b', null, 'Disconnected'), h('small', null, 'Reconnect from the admin page on the Mac (npm run admin).'));
      disconnect.remove();
    } catch (e) {
      err.textContent = e.message;
    }
  };
  access.append(accessText, disconnect);

  const auto = h('div', 'sv-row');
  const autoText = h('label', 'sv-text');
  autoText.htmlFor = 'sv-autostart';
  autoText.append(h('b', null, 'Start automatically when the Mac starts'), h('small', null, "Turning this off doesn't stop Pocket Dev now; it only stays off after the next restart."));
  const toggle = h('input', 'sv-switch');
  Object.assign(toggle, { type: 'checkbox', id: 'sv-autostart', disabled: true });
  toggle.setAttribute('role', 'switch');
  auto.append(autoText, toggle);

  const restart = h('div', 'sv-row');
  const restartText = h('div', 'sv-text');
  restartText.append(h('b', null, 'Restart Pocket Dev'), h('small'));
  const restartBtn = h('button', 'st-btn', 'Restart');
  restartBtn.type = 'button';
  restartBtn.disabled = true;
  restart.append(restartText, restartBtn);

  container.replaceChildren(title, access, restart, auto, err);

  // The restart takes the page's own server down, so wait for it to answer again and then load the new code.
  let busy = false;
  async function reloadWhenBack(verb) {
    busy = true;
    restartBtn.disabled = true;
    restartBtn.classList.remove('sv-update');
    restartText.lastChild.textContent = 'Back in about 15 seconds. This page reloads by itself.';
    const started = Date.now();
    const tick = setInterval(() => { restartBtn.textContent = `${verb}… ${Math.floor((Date.now() - started) / 1000)}s`; }, 250);
    await new Promise((r) => setTimeout(r, 4000));
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch('/api/status', { cache: 'no-store' })).ok) return location.reload();
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    clearInterval(tick);
    busy = false;
    restartBtn.textContent = 'Restart';
    restartBtn.disabled = false;
    restartText.lastChild.textContent = 'Pocket Dev has not come back yet. Check the Mac (pocket-dev service status), then try again.';
  }
  restartBtn.onclick = async () => {
    if (!confirm('Restart Pocket Dev now? Open terminals end. You stay logged in.')) return;
    err.textContent = '';
    const verb = restartBtn.textContent === 'Update' ? 'Updating' : 'Restarting';
    restartBtn.disabled = true;
    restartBtn.textContent = `${verb}… 0s`;
    try {
      await api('POST', '/api/service/restart', {});
    } catch (e) {
      err.textContent = e.message;
      restartBtn.disabled = false;
      restartBtn.textContent = verb === 'Updating' ? 'Update' : 'Restart';
      return;
    }
    reloadWhenBack(verb);
  };

  const show = (svc) => {
    if (busy) return;
    const canRestart = svc.running && svc.isThisServer;
    restartBtn.disabled = !canRestart;
    restartBtn.classList.toggle('sv-update', canRestart && svc.updateReady);
    restartBtn.textContent = svc.updateReady ? 'Update' : 'Restart';
    restartText.lastChild.textContent = !canRestart
      ? 'Pocket Dev is not running as the background service, so it cannot restart itself. Install the service from the admin page on the Mac.'
      : svc.updateReady ? 'Newer code is on the Mac. Update to start using it.' : 'Loads the latest code on the Mac. Nothing newer is waiting right now.';
    toggle.checked = svc.autostart;
    toggle.disabled = !svc.installed;
    autoText.lastChild.textContent = svc.installed
      ? "Turning this off doesn't stop Pocket Dev now; it only stays off after the next restart."
      : 'Pocket Dev is not installed as a service yet. Install it from the admin page on the Mac (npm run admin).';
  };
  toggle.onchange = async () => {
    err.textContent = '';
    toggle.disabled = true;
    try {
      show(await api('PUT', '/api/service/autostart', { enabled: toggle.checked }));
    } catch (e) {
      err.textContent = e.message;
      toggle.checked = !toggle.checked;
      toggle.disabled = false;
    }
  };
  try {
    show(await api('GET', '/api/service'));
  } catch (e) {
    err.textContent = e.message;
  }
}
