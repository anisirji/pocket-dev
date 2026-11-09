// Scanning the invite QR: from the camera, or from a photo. The pure helpers are exported for test/room-scan.test.mjs;
// the camera and image code runs only in a browser. Decoding uses BarcodeDetector when the browser has it, otherwise the
// vendored jsQR (public/vendor/jsqr, Apache-2.0). Nothing is fetched from the internet.

// A camera needs a secure page: https, or http on localhost.
export function cameraSupport({ isSecureContext, hasCamera, port = '' }) {
  if (!isSecureContext) {
    return { ok: false, text: `The camera needs a secure page. On this device open http://localhost${port ? `:${port}` : ''}, or choose a photo of the QR instead.` };
  }
  if (!hasCamera) return { ok: false, text: 'This browser cannot use a camera here. Choose a photo of the QR instead.' };
  return { ok: true, text: '' };
}

export function cameraError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'The camera is blocked. Allow camera access for this page in the browser, or choose a photo of the QR instead.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'No camera was found on this device. Choose a photo of the QR instead.';
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return 'The camera is busy. Close other apps that use it and try again, or choose a photo of the QR instead.';
  return `The camera did not start${err?.message ? ` (${err.message})` : ''}. Choose a photo of the QR instead.`;
}

let jsqrLoading;
function loadJsQr() {
  if (globalThis.jsQR) return Promise.resolve(globalThis.jsQR);
  return jsqrLoading ||= new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsqr/jsQR.js';
    s.onload = () => ok(globalThis.jsQR);
    s.onerror = () => { jsqrLoading = null; no(new Error('The QR reader did not load.')); };
    document.head.append(s);
  });
}

// Decodes RGBA pixels ({data, width, height}); returns the text or ''.
export async function decodePixels(image) {
  const jsQR = globalThis.jsQR || await loadJsQr();
  const hit = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  return hit?.data || '';
}

// Decodes anything a browser can draw (image, video frame, bitmap).
export async function decodeSource(source, width, height) {
  if (globalThis.BarcodeDetector) {
    try {
      const found = await new globalThis.BarcodeDetector({ formats: ['qr_code'] }).detect(source);
      if (found[0]?.rawValue) return found[0].rawValue;
    } catch { /* fall through to the vendored decoder */ }
  }
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return decodePixels(ctx.getImageData(0, 0, w, h));
}

export async function decodePhoto(file) {
  const bitmap = await createImageBitmap(file);
  try { return await decodeSource(bitmap, bitmap.width, bitmap.height); } finally { bitmap.close?.(); }
}

// Opens the rear camera into `video` and calls onText once with the first QR text it reads. Returns { stop }.
export async function startCamera(video, onText) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  let stopped = false, timer = 0;
  const stop = () => { stopped = true; clearTimeout(timer); stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play().catch(() => {});
  const look = async () => {
    if (stopped) return;
    if (video.videoWidth) {
      const text = await decodeSource(video, video.videoWidth, video.videoHeight).catch(() => '');
      if (text && !stopped) { stop(); onText(text); return; }
    }
    if (!stopped) timer = setTimeout(look, 250);
  };
  look();
  return { stop };
}
