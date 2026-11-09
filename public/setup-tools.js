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

export async function renderToolsSection(container, api = window.api) {
  if (!document.getElementById('sx-style')) {
    const style = h('style', null, STYLE);
    style.id = 'sx-style';
    document.head.append(style);
  }
  const title = h('h3', null, 'Tools on this computer');
  const err = h('p', 'st-err');
  const list = h('ul', 'sx-list');
  const hint = h('p', 'st-note', 'To fix everything in one go, run this in a terminal on this computer: pocket-dev setup');
  container.replaceChildren(title, list, hint, err);
  try {
    const { tools } = await api('GET', '/api/setup/status');
    list.replaceChildren(...tools.map(row));
  } catch (e) {
    err.textContent = `Could not check the tools: ${e.message}`;
  }
}
