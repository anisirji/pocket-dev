// On a phone, Chrome for Android opens its photo picker, or a photos-first view, for the file box whenever the page lets
// images through, so people could not reach their documents. On touch devices the paperclip and the Upload button show
// three plain choices, and each sets an `accept` list (and, for the camera, `capture`) that opens the right system screen.
// That photo picker has no camera, so Take photo asks for the camera directly. A desktop browser keeps its one normal picker.
(() => {
  const CAMERA = 'image/*';
  const PHOTOS = 'image/*,video/*';
  // Documents only. Android Chrome adds a Camera and Photos chooser whenever the list holds */*, images, video or audio, and
  // a `.ts` extension counts as video, so the list is two wildcards and no extensions: pdf, doc, zip, txt, json and the rest.
  const FILES = 'application/*,text/*';
  globalThis.PocketFileChoice = { CAMERA, PHOTOS, FILES };
  if (typeof document === 'undefined') return;

  const isTouch = () => matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  let open = null;

  const style = document.createElement('style');
  style.textContent = `
.fc-menu { position: fixed; z-index: 100000; min-width: 220px; padding: 6px; border-radius: 12px; background: var(--panel, #131a26); border: 1px solid var(--line, #2a3446); box-shadow: 0 8px 28px #000a; display: flex; flex-direction: column; gap: 2px; }
.fc-menu button { min-height: 44px; padding: 0 14px; border: 0; border-radius: 8px; background: transparent; color: var(--text, #e6edf7); font-size: 16px; text-align: left; }
.fc-menu button:active, .fc-menu button:focus-visible { background: var(--line, #2a3446); outline: none; }`;
  document.head.append(style);

  function close() {
    if (!open) return;
    open.remove();
    open = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
  }
  function outside(e) { if (open && !open.contains(e.target) && !open.anchor.contains(e.target)) close(); }
  function escape(e) { if (e.key === 'Escape') close(); }

  // The click on the input has to happen inside the tap, so each choice clicks it straight away.
  function pick(input, accept, capture) {
    close();
    input.setAttribute('accept', accept);
    if (capture) input.setAttribute('capture', capture);
    else input.removeAttribute('capture');
    input.click();
  }

  globalThis.chooseFiles = (anchor, input) => {
    if (open) return close();
    if (!isTouch()) {
      input.removeAttribute('accept');
      input.removeAttribute('capture');
      return input.click();
    }
    const menu = document.createElement('div');
    menu.className = 'fc-menu';
    menu.setAttribute('role', 'menu');
    for (const [label, accept, capture] of [['Take photo', CAMERA, 'environment'], ['Photos and videos', PHOTOS], ['Files', FILES]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.onclick = () => pick(input, accept, capture);
      menu.append(b);
    }
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    menu.style.bottom = `${Math.max(8, innerHeight - r.top + 8)}px`;
    menu.anchor = anchor;
    open = menu;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    menu.querySelector('button').focus();
  };
})();
