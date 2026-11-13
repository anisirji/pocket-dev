import { COPY } from '/greeting-copy.js';

// Plan C12: the setup greeting, once on each phone, after its first login. Always the plain wording: the phone does not
// know the computer's user name, and nothing about this is sent anywhere. It plays as slides: a short one stays briefly,
// a long one longer, then the whole card changes to the next. Next always moves on at once.
const SHOWN = 'pd-welcome-shown';

// Reading time: a base plus a little per character, kept between a floor and a ceiling.
export const slideMs = (text) => Math.min(9000, Math.max(2000, 1500 + 45 * text.length));

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text) node.textContent = text;
  return node;
}

function linksSlide() {
  const box = el('div', '');
  box.append(el('p', 'margin:0 0 14px;font-size:20px;line-height:1.4', 'Find me and the code 🌐'));
  for (const { label, url } of COPY.links) {
    box.append(el('p', 'margin:0 0 2px;font-size:13px;color:var(--muted,#7d8799)', label));
    const line = el('p', 'margin:0 0 12px;font-size:15px');
    const link = el('a', 'color:#f0a35e;overflow-wrap:anywhere', url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    line.append(link);
    box.append(line);
  }
  box.append(el('p', 'margin:14px 0 0;font-size:12.5px;color:var(--muted,#7d8799)', COPY.madeHere));
  return box;
}

function show() {
  const slides = [...COPY.phone.slides.map((text) => ({ text })), { links: true }];
  const overlay = el('div', 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.6)');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', COPY.phone.title);
  const card = el('div', 'display:flex;flex-direction:column;width:100%;max-width:420px;max-height:100%;padding:18px;border-radius:14px;border:1px solid #e8964a;background:var(--panel,#131823);color:var(--text,#e6e9ef);box-shadow:0 12px 40px rgba(0,0,0,.5)');
  card.append(el('h2', 'margin:0 0 12px;font-size:15px;font-weight:600;color:#f0a35e', COPY.phone.title));
  const stage = el('div', 'min-height:170px;display:flex;flex-direction:column;justify-content:center;overflow:auto');
  stage.setAttribute('aria-live', 'polite');
  const dots = el('div', 'display:flex;justify-content:center;gap:6px;margin:12px 0');
  const dotNodes = slides.map(() => el('span', 'width:6px;height:6px;border-radius:50%;background:#3a4252'));
  dots.append(...dotNodes);
  const button = el('button', 'flex:none;width:100%;height:42px;border-radius:10px;border:0;background:#e8964a;color:#1a1008;font-weight:600;font-size:15px');

  let index = -1;
  let timer = null;
  let changing = false;
  const calm = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const fade = (node, from, to, duration) => (calm ? null : node.animate?.([{ opacity: from }, { opacity: to }], { duration, fill: 'forwards' }));

  const render = () => {
    changing = false;
    const slide = slides[index];
    stage.replaceChildren(slide.links ? linksSlide() : el('p', 'margin:0;font-size:21px;line-height:1.45;text-align:center', slide.text));
    fade(stage, 0, 1, 350);
    dotNodes.forEach((d, i) => { d.style.background = i === index ? '#e8964a' : '#3a4252'; });
    const last = index === slides.length - 1;
    button.textContent = last ? COPY.phone.close : COPY.phone.next;
    clearTimeout(timer);
    timer = last ? null : setTimeout(next, slideMs(slide.text));
  };
  function next() {
    if (changing) return;
    if (index === slides.length - 1) { clearTimeout(timer); overlay.remove(); return; }
    index++;
    if (index === 0) return render();
    changing = true;
    const out = fade(stage, 1, 0, 200);
    if (out?.finished) out.finished.then(render, render);
    else render();
  }

  button.addEventListener('click', next);
  card.append(stage, dots, button);
  overlay.append(card);
  document.body.append(overlay);
  next();
}

try {
  if (!localStorage.getItem(SHOWN)) {
    localStorage.setItem(SHOWN, '1');
    show();
  }
} catch {}
