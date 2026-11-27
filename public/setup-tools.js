// The "Tools on this computer" part of the phone's Settings sheet: what Pocket Dev's helpers need, from GET /api/setup/status.
// A missing or logged-out tool shows the exact command to run on that computer, with a Copy button.
const STYLE = `
.sx-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.sx-row { display: grid; grid-template-columns: 22px 1fr; gap: 2px 8px; align-items: start; }
.sx-mark { font-weight: 700; text-align: center; }
.sx-ok { color: var(--ok, #7ee787); }
.sx-no { color: #e5a13b; }
.sx-bad { color: #f2736b; }
.sx-name { font-size: 15px; font-weight: 600; }
.sx-name small { color: var(--muted); font-size: 13px; font-weight: 400; margin-left: 6px; }
.sx-fix { grid-column: 2; display: flex; align-items: center; gap: 8px; min-width: 0; }
.sx-fix code { flex: 1; min-width: 0; padding: 6px 8px; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); font-size: 12.5px; overflow-wrap: anywhere; }
.sx-fix button { flex: none; height: 32px; }
.sx-note { grid-column: 2; margin: 0; color: var(--muted); font-size: 12.5px; }
`;

const h = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const input = h('textarea');
  input.value = text;
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Copy failed. Select the command and copy it.');
}

function describe(t) {
  if (t.status === 'ok') return [t.version ? `${t.id === 'node' ? 'Node ' : ''}${t.version}` : 'installed', t.loggedIn ? 'logged in' : ''].filter(Boolean).join(', ');
  if (t.status === 'logged-out') return 'installed, not logged in';
  if (t.status === 'unknown') return 'installed, login not checked';
  if (t.status === 'outdated') return `needs Node 22 or newer (${t.version})`;
  return 'not installed';
}

function row(t) {
  const li = h('li', 'sx-row');
  const good = t.status === 'ok';
  const mark = h('span', `sx-mark ${good ? 'sx-ok' : t.level === 'required' ? 'sx-bad' : 'sx-no'}`, good ? '✓' : '✗');
  mark.setAttribute('aria-label', good ? 'ready' : 'not ready');
  const name = h('div', 'sx-name', t.title);
  name.append(h('small', null, describe(t)));
  li.append(mark, name);
  if (t.fix?.command) {
    const code = h('code', null, t.fix.command);
    const copy = h('button', 'st-btn', 'Copy');
    copy.type = 'button';
    copy.onclick = async () => {
      try { await copyText(t.fix.command); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select it'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    };
    const fix = h('div', 'sx-fix');
    fix.append(code, copy);
    li.append(fix);
  }
  if (t.fix?.note) li.append(h('p', 'sx-note', t.fix.note));
  return li;
}

const names = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', copilot: 'Copilot' };
export async function renderToolsSection(container, api = window.api) {
  if (!document.getElementById('sx-style')) {
    const style = h('style', null, STYLE); style.id = 'sx-style'; document.head.append(style);
  }
  const ticket = {}; container._toolsTicket = ticket;
  const current = () => container._toolsTicket === ticket && container.isConnected;
  const err = h('p', 'st-err'); err.setAttribute('role', 'alert');
  container.replaceChildren(h('p', 'st-note', 'Checking AI tools…'), err);
  try {
    const state = await api('GET', '/api/connections');
    // Connection grants belong to the front-door computer. Read its setup status even when the workspace uses a peer.
    const { tools } = await api('GET', '/api/setup/status');
    if (!current()) return;
    const self = state.computers.find((computer) => computer.self);
    const scope = h('p', 'st-note', `Installed on ${self?.name || 'this computer'}`);
    function list() {
      if (!current()) return;
      const providers = h('div', 'sx-providers');
      for (const [type, name] of Object.entries(names)) {
        const provider = state.providers[type];
        const tool = tools.find((item) => item.id === type);
        const button = h('button', 'st-link sx-provider'); button.type = 'button';
        const text = h('span'); text.append(h('span', null, name), h('small', 'st-note', tool ? describe(tool) : provider?.installed ? 'Installed' : 'Not installed'));
        button.append(text, h('span', 'st-chev', '›'));
        const openProvider = () => {
          if (!window.pocketDevSettings?.pushView(`settings-provider-${type}`, name, list, () => detail(type))) detail(type);
        };
        button.onclick = openProvider;
        window.pocketDevSettings?.registerRoute(`settings-provider-${type}`, openProvider);
        providers.append(button);
      }
      const helpers = h('details', 'sx-helpers'), helperList = h('ul', 'sx-list');
      helpers.append(h('summary', null, 'Other tools on this computer'));
      helperList.replaceChildren(...tools.filter((tool) => !names[tool.id]).map(row)); helpers.append(helperList);
      const shared = h('div', 'sx-shared'); shared.append(h('h3', null, 'Available from connected computers'));
      for (const provider of state.shared) shared.append(h('p', 'st-note', `${names[provider.type] || provider.type} · ${provider.name} · Available`));
      if (!state.shared.length) shared.append(h('p', 'st-note', 'Providers appear here when a connected computer shares AI with you.'));
      container.replaceChildren(scope, providers, shared, helpers, err);
    }
    function detail(type) {
      const name = names[type], provider = state.providers[type], tool = tools.find((item) => item.id === type);
      const setup = h('section', 'sx-setup'); setup.append(h('h3', null, 'Setup & login'));
      if (tool) { const toolsList = h('ul', 'sx-list'); toolsList.append(row(tool)); setup.append(toolsList); }
      else setup.append(h('p', 'st-note', provider?.installed ? 'Installed. Manage setup and login on this computer.' : 'Not installed. Run pocket-dev setup on this computer to see available installation options.'));
      if (type === 'codex') {
        const browser = h('p', 'st-note', 'Checking browser automation…'); setup.append(h('h3', null, 'Browser automation'), browser);
        api('GET', '/api/setup/browser').then((status) => { if (current()) { browser.textContent = status.message; browser.dataset.featureState = status.state; } }).catch(() => { if (current()) browser.textContent = 'Browser tools could not be checked. Check the computer connection and retry.'; });
        setup.append(h('p', 'st-note', 'Browser access is off by default. Shared Codex sessions do not inherit the AI source computer’s browser.'));
      }
      const sharing = h('section', 'sx-sharing'); sharing.append(h('h3', null, 'Sharing'));
      const label = h('label', 'st-check sx-share'), toggle = h('input'); toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch');
      toggle.checked = !!provider?.enabled; toggle.disabled = !provider?.installed || !provider?.supported;
      label.append(document.createTextNode(`Share ${name}`), toggle); sharing.append(label);
      const status = h('p', 'st-note', !provider?.supported ? `${name} sharing is not available yet. Local chats continue to work.` : !provider.installed ? `Install ${name} on this computer before sharing it.` : 'Only authorized computers can use this provider.');
      sharing.append(status);
      toggle.onchange = async () => {
        const enabled = toggle.checked; toggle.disabled = true; err.textContent = '';
        try { await api('PATCH', `/api/connections/providers/${type}`, { enabled }); provider.enabled = enabled; }
        catch (error) { toggle.checked = !enabled; err.textContent = error.message; }
        finally { toggle.disabled = !provider.installed || !provider.supported; }
      };
      const authorized = h('section', 'sx-authorized'); authorized.append(h('h3', null, 'Authorized computers'));
      const peers = state.computers.filter((computer) => !computer.self && !computer.disconnected);
      for (const computer of peers) {
        const access = h('label', 'st-check sx-share'), input = h('input'); input.type = 'checkbox'; input.checked = computer.sharing.includes(type); input.disabled = !provider?.installed || !provider?.supported;
        const text = h('span'); text.append(h('span', null, computer.name), h('small', 'st-note', computer.connectionType === 'personal' ? 'My computer' : 'AI only'));
        access.append(text, input); authorized.append(access);
        input.onchange = async () => {
          const on = input.checked; input.disabled = true; err.textContent = '';
          const ai = on ? [...new Set([...computer.sharing, type])] : computer.sharing.filter((item) => item !== type);
          try { await api('PATCH', `/api/connections/${computer.deviceId}`, { ai }); computer.sharing = ai; }
          catch (error) { input.checked = !on; err.textContent = error.message; }
          finally { input.disabled = !provider.installed || !provider.supported; }
        };
      }
      if (!peers.length) authorized.append(h('p', 'st-note', 'No connected computers. Add one in Connected computers to authorize it here.'));
      authorized.append(h('p', 'st-note', 'Sharing AI does not grant computer access. Relevant project content is sent to the AI source computer and its AI service.'));
      container.replaceChildren(scope, setup, sharing, authorized, err);
    }
    list();
  } catch (error) {
    if (!current()) return;
    const retry = h('button', 'st-btn', 'Retry'); retry.type = 'button'; retry.onclick = () => renderToolsSection(container, api);
    err.textContent = `Could not check the tools: ${error.message}`; container.replaceChildren(err, retry);
  }
}
