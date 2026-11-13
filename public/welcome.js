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

// One paragraph at a time, a second apart, so it reads like a person talking. A tap on the text shows the rest.
const PACE_MS = 1000;

function show() {
  const overlay = el('div', 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.6)');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', COPY.phone.title);
  const card = el('div', 'display:flex;flex-direction:column;max-width:420px;max-height:100%;padding:18px;border-radius:14px;border:1px solid #e8964a;background:var(--panel,#131823);color:var(--text,#e6e9ef);box-shadow:0 12px 40px rgba(0,0,0,.5)');
  card.append(el('h2', 'margin:0 0 10px;font-size:19px;color:#f0a35e', COPY.phone.title));
  const scroll = el('div', 'overflow:auto;min-height:0;flex:1');

  const beats = [];
  const beat = (...nodes) => {
    const wrap = el('div', 'display:none');
    wrap.append(...nodes);
    scroll.append(wrap);
    beats.push(wrap);
  };
  beat(el('p', 'margin:0 0 10px', COPY.hello.plain));
  beat(el('p', 'margin:0 0 10px', COPY.congrats.replace('{computer}', COPY.computer.other)));
  for (const text of COPY.body.slice(0, -1)) beat(el('p', 'margin:0 0 10px', text));
  beat(el('p', 'margin:0 0 4px', COPY.body.at(-1)), el('p', 'margin:0 0 14px;font-weight:600', COPY.signature));
  for (const text of COPY.creator) beat(el('p', 'margin:0 0 10px', text));
  beat(...COPY.links.map(({ label, url }) => {
    const line = el('p', 'margin:0 0 6px', `${label}: `);
    const link = el('a', 'color:#f0a35e', url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    line.append(link);
    return line;
  }));
  beat(el('p', 'margin:12px 0 14px;font-size:12.5px;color:var(--muted,#7d8799)', COPY.madeHere));

  let shown = 0;
  let timer = null;
  const showNext = () => {
    const node = beats[shown++];
    node.style.display = 'block';
    node.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 400 });
    scroll.scrollTop = scroll.scrollHeight;
  };
  const tick = () => {
    showNext();
    timer = shown < beats.length ? setTimeout(tick, PACE_MS) : null;
  };
  const showAll = () => {
    clearTimeout(timer);
    timer = null;
    while (shown < beats.length) showNext();
  };
  showNext();
  timer = setTimeout(tick, PACE_MS);
  scroll.addEventListener('click', showAll);

  card.append(scroll);
  const close = el('button', 'flex:none;width:100%;height:42px;border-radius:10px;border:0;background:#e8964a;color:#1a1008;font-weight:600;font-size:15px', COPY.phone.close);
  close.addEventListener('click', () => { clearTimeout(timer); overlay.remove(); });
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
