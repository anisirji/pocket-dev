// What the Terminal view shows when this computer's Pocket Dev has no working node-pty: plain words and the one
// command that fixes it. Chats, Git and Files keep working, and the card says so.
export const DOCS_URL = 'https://github.com/anisirji/pocket-dev/blob/main/docs/SETUP.md#troubleshooting';

export function terminalsOffCard(info, { copyText }) {
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const command = info.command || 'pocket-dev doctor --fix';
  const card = el('section', 'terminals-off');
  card.id = 'terminalsOff';
  card.setAttribute('role', 'alert');
  const copy = el('button', 'primary', 'Copy');
  copy.type = 'button';
  copy.onclick = async () => {
    copy.textContent = (await copyText(command)) ? 'Copied' : 'Select and copy it';
  };
  const code = el('code', '', command);
  const link = el('a', '', 'Troubleshooting guide');
  link.href = DOCS_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  const row = el('div', 'terminals-off-cmd');
  row.append(code, copy);
  card.append(
    el('h2', '', 'Terminals are not available on this computer'),
    el('p', '', `Chats, Git, Files and the rest still work. The terminal part of Pocket Dev cannot start because ${info.reason ?? 'its terminal component is missing'}.`),
    el('p', '', 'To repair it, open a terminal on the computer where Pocket Dev runs (not on this phone) and run:'),
    row,
    el('p', '', 'Then restart Pocket Dev. Setting up again with pocket-dev setup also checks this.'),
    link,
  );
  return card;
}
