import { COPY } from '/greeting-copy.js';

// Plan C12: the setup greeting, once on each phone, after its first login. Always the plain wording: the phone does not
// know the computer's user name, and nothing about this is sent anywhere.
const SHOWN = 'pd-welcome-shown';

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text) node.textContent = text;
  return node;
}

function show() {
  const overlay = el('div', 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.6)');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', COPY.phone.title);
  const card = el('div', 'max-width:420px;max-height:100%;overflow:auto;padding:18px;border-radius:14px;border:1px solid #e8964a;background:var(--panel,#131823);color:var(--text,#d7dce5);font-size:15px;line-height:1.45');
  card.append(el('h2', 'margin:0 0 10px;font-size:19px;color:#f0a35e', COPY.phone.title));
  const paragraphs = [COPY.hello.plain, COPY.allSet.replace('{computer}', COPY.computer.other), ...COPY.body];
  for (const text of paragraphs) card.append(el('p', 'margin:0 0 10px', text));
  card.append(el('p', 'margin:0 0 14px;font-weight:600', COPY.signature));
  for (const text of COPY.creator) card.append(el('p', 'margin:0 0 10px', text));
  for (const { label, url } of COPY.links) {
    const line = el('p', 'margin:0 0 6px', `${label}: `);
    const link = el('a', 'color:#f0a35e', url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    line.append(link);
    card.append(line);
  }
  card.append(el('p', 'margin:12px 0 14px;font-size:12.5px;color:var(--muted,#7d8799)', COPY.madeHere));
  const close = el('button', 'width:100%;height:42px;border-radius:10px;border:0;background:#e8964a;color:#1a1008;font-weight:600;font-size:15px', COPY.phone.close);
  close.addEventListener('click', () => overlay.remove());
  card.append(close);
  overlay.append(card);
  document.body.append(overlay);
}

try {
  if (!localStorage.getItem(SHOWN)) {
    localStorage.setItem(SHOWN, '1');
    show();
  }
} catch {}
