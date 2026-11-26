import crypto from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const DEFAULT = { id: 'default', name: 'Default computer camera' };
const MAX_FRAME = 2 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Signaling is forwarded only between the authenticated viewer and its local camera host.
export function cameraSignal(message, descriptionType) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.description?.type === descriptionType && typeof message.description.sdp === 'string' && message.description.sdp.length <= 128 * 1024) {
    return { description: { type: descriptionType, sdp: message.description.sdp } };
  }
  if (message.candidate === null) return { candidate: null };
  const candidate = message.candidate;
  if (candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= 4096) {
    return { candidate: { candidate: candidate.candidate,
      sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid.slice(0, 64) : null,
      sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex < 1024 ? candidate.sdpMLineIndex : null,
      ...(typeof candidate.usernameFragment === 'string' && { usernameFragment: candidate.usernameFragment.slice(0, 256) }) } };
  }
  return null;
}

export function localCameraHost(req) {
  return LOOPBACK.has(req.socket.remoteAddress) && !req.roomPeer
    && !Object.keys(req.headers).some((key) => /^(forwarded|x-forwarded-|cf-|x-real-ip)/i.test(key));
}

// The computer browser owns permission and sends video directly to authenticated viewers.
// Its loopback socket carries signaling and bounded JPEGs for the relay fallback.
export function createBrowserCamera({ origin, openUrl, enabled = () => true, now = Date.now,
  idleMs = 15_000, firstFrameMs = 25_000, staleMs = 5000, setupFrameMs = 90_000,
  verifiedAt = () => 0, onVerified = () => {}, iceServers = () => [{ urls: 'stun:stun.cloudflare.com:3478' }] } = {}) {
  let host = null, cameras = [], disposed = false;
  let lastVerified = verifiedAt(), setupJob = null, setupError = null;
  const leases = new Map();
  const check = () => {
    if (disposed) throw fail(503, 'Camera service is stopping.');
    if (!enabled()) throw fail(403, 'Camera access is turned off. On this computer, run: pocket-dev config set cameraView true');
  };
  function notify(h) { for (const wake of [...h.waiters]) wake(); }
  function send(h, message) {
    if (h?.socket?.readyState === 1) h.socket.send(JSON.stringify(message));
  }
  function stopCapture(message = 'Camera stopped.') {
    if (!host) return;
    send(host, { type: 'stop' });
    host.error = fail(410, message);
    host.frame = null;
    host.camera = null;
    notify(host);
  }
  function rate() {
    const viewers = [...leases.values()].filter((lease) => lease.viewer?.readyState === 1);
    send(host, { type: 'rate', fps: viewers.some((lease) => lease.transport !== 'rtc') ? 15 : viewers.length && viewers.length === leases.size ? 1 : 5 });
  }
  function drop(id, message = 'Camera session ended.') {
    const lease = leases.get(id);
    if (!lease) return;
    leases.delete(id);
    send(host, { type: 'viewer-left', viewer: id });
    lease.viewer?.close(1000, message);
    if (!leases.size) stopCapture(message); else rate();
    if (host) notify(host);
  }
  function sweep() {
    for (const [id, lease] of leases) if (!lease.pending && now() - lease.at >= idleMs) drop(id);
    if (!enabled()) for (const id of [...leases.keys()]) drop(id, 'Camera access disabled.');
    if (host?.camera && !leases.size) stopCapture();
  }
  const timer = setInterval(sweep, Math.min(1000, idleMs));
  timer.unref?.();
  function own(owner, id) {
    sweep(); check();
    const lease = leases.get(id);
    if (!lease || lease.owner !== owner || !host) throw fail(410, 'Camera session ended. Tap Start camera to continue.');
    lease.at = now();
    return lease;
  }
  function stop(owner, id) {
    if (leases.get(id)?.owner === owner) drop(id);
  }
  function error(h, message) {
    if (host !== h) return;
    h.error = fail(503, message);
    send(h, { type: 'stop' });
    for (const lease of leases.values()) if (lease.viewer?.readyState === 1) lease.viewer.send(JSON.stringify({ type: 'error', message }));
    notify(h);
  }
  async function devices() { check(); return [{ ...DEFAULT }, ...cameras]; }
  async function start(owner, id = 'default') {
    check(); sweep();
    if (id !== 'default' && !cameras.some((camera) => camera.id === id)) throw fail(400, 'Choose a connected camera. Reopen Device camera to refresh the list.');
    if (host?.camera && leases.size && id !== 'default' && host.camera !== id && host.activeId !== id) throw fail(409, 'Another viewer is using a different camera. Stop that preview first.');
    for (const [key, lease] of leases) if (lease.owner === owner) drop(key);
    const session = crypto.randomUUID();
    leases.set(session, { owner, at: now(), pending: 0 });
    if (!host || (!host.socket && host.launched && host.error)) {
      host = { token: crypto.randomBytes(32).toString('hex'), socket: null, launched: false, frame: null, at: 0, error: null,
        camera: null, activeId: null, waiters: new Set() };
    }
    const h = host;
    if (!h.camera || h.error) {
      h.error = null; h.frame = null; h.camera = id;
      send(h, { type: 'start', camera: id });
    }
    if (!h.launched) {
      h.launched = true;
      Promise.resolve().then(() => openUrl(`${origin()}/camera-host.html#${h.token}`)).then((opened) => {
        if (opened === false) error(h, 'Could not open a browser on the computer. Make sure a desktop browser is installed and the computer is signed in.');
      }).catch(() => error(h, 'Could not open the computer browser. Sign in on the computer and try again.'));
    }
    return { id: session, camera: cameras.find((camera) => camera.id === id)?.name || DEFAULT.name, streaming: true };
  }
  async function frame(owner, id, { signal, waitMs = firstFrameMs } = {}) {
    const lease = own(owner, id), h = host;
    if (h.error) throw h.error;
    lease.pending++;
    try {
      if (!h.frame) await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); h.waiters.delete(wake); signal?.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); stop(owner, id); reject(fail(410, 'Camera request closed.')); };
        const wake = () => {
          if (!leases.has(id)) { cleanup(); reject(fail(410, 'Camera session ended.')); }
          else if (h.error) { cleanup(); reject(h.error); }
          else if (h.frame) { cleanup(); resolve(); }
        };
        const timeout = setTimeout(() => {
          cleanup(); stop(owner, id);
          reject(fail(503, 'No camera image arrived. On the computer, allow camera access in the Pocket Dev camera browser tab, then tap Start camera again.'));
        }, waitMs);
        h.waiters.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else wake();
      });
      own(owner, id);
      if (h.error) throw h.error;
      if (now() - h.at > staleMs) { stop(owner, id); throw fail(503, 'The computer browser stopped sending camera images. Keep its camera tab open and try again.'); }
      return h.frame;
    } finally { lease.pending--; lease.at = now(); }
  }
  function acceptsHost(req, token) {
    if (disposed || !enabled() || !localCameraHost(req) || !leases.size || !host || host.socket || !/^[0-9a-f]{64}$/.test(token || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(host.token));
  }
  function attachHost(socket) {
    const h = host;
    if (!h || !leases.size || h.socket || !enabled()) { socket.close(1008, 'Camera session ended'); return; }
    h.socket = socket;
    socket.on('message', (raw, binary) => {
      if (host !== h || !enabled() || !leases.size) { send(h, { type: 'stop' }); return; }
      if (binary) {
        if (!h.camera || h.error) return;
        if (raw.length < 4 || raw.length > MAX_FRAME || raw[0] !== 0xff || raw[1] !== 0xd8 || raw.at(-2) !== 0xff || raw.at(-1) !== 0xd9) return error(h, 'The computer browser sent an invalid camera image.');
        const first = !h.frame;
        h.frame = Buffer.from(raw); h.at = now();
        if (first) {
          lastVerified = now(); setupError = null;
          try { onVerified(lastVerified); } catch { /* capture remains usable if config cannot be written */ }
        }
        for (const lease of leases.values()) {
          const viewer = lease.viewer;
          if (viewer?.readyState === 1 && lease.transport !== 'rtc' && lease.inFlight < 3 && (viewer.bufferedAmount || 0) < 256 * 1024) {
            lease.inFlight++; viewer.send(h.frame);
          }
        }
        notify(h); return;
      }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'signal' && typeof message.viewer === 'string') {
        const lease = leases.get(message.viewer), signal = cameraSignal(message, 'offer');
        if (signal && lease?.viewer?.readyState === 1 && lease.transport !== 'jpeg') lease.viewer.send(JSON.stringify({ type: 'signal', ...signal }));
      } else if (message.type === 'devices' && Array.isArray(message.cameras)) {
        cameras = message.cameras.filter((camera) => typeof camera.id === 'string' && camera.id.length <= 512 && typeof camera.name === 'string')
          .slice(0, 32).map((camera) => ({ id: camera.id, name: camera.name.slice(0, 256) }));
        if (typeof message.activeId === 'string') h.activeId = message.activeId;
      } else if (message.type === 'permission' && ['granted', 'prompt', 'denied', 'unknown'].includes(message.state)) {
        h.permissionState = message.state;
      } else if (message.type === 'error') {
        if (message.code === 'NotAllowedError' && typeof message.message === 'string') setupError = message.message.slice(0, 1000);
        error(h, typeof message.message === 'string' ? message.message.slice(0, 1000) : 'Could not open the camera in the computer browser.');
      } else if (message.type === 'stopped') {
        error(h, 'Camera stopped on the computer.');
        for (const id of [...leases.keys()]) drop(id, 'Camera stopped on the computer.');
        notify(h);
      }
    });
    socket.on('close', () => {
      if (host !== h) return;
      h.socket = null;
      error(h, 'The computer camera tab was closed. Tap Start camera to open it again.');
    });
    socket.on('error', () => error(h, 'The computer camera connection was interrupted.'));
    send(h, { type: 'start', camera: h.camera || 'default' });
    for (const [id, lease] of leases) if (lease.viewer?.readyState === 1 && lease.transport !== 'jpeg') send(h, { type: 'viewer', viewer: id, iceServers: iceServers() });
    rate();
  }
  function acceptsViewer(owner, id) {
    try { return !own(owner, id).viewer; } catch { return false; }
  }
  function attachViewer(owner, id, socket) {
    let lease;
    try { lease = own(owner, id); } catch { socket.close(1008, 'Camera session ended'); return; }
    if (lease.viewer) { socket.close(1008, 'Viewer already connected'); return; }
    lease.viewer = socket; lease.transport = 'pending'; lease.inFlight = 0;
    socket.send(JSON.stringify({ type: 'hello', iceServers: iceServers() }));
    send(host, { type: 'viewer', viewer: id, iceServers: iceServers() });
    if (host?.error) socket.send(JSON.stringify({ type: 'error', message: host.error.message }));
    else if (host?.frame) { lease.inFlight++; socket.send(host.frame); }
    socket.on('message', (raw, binary) => {
      if (binary) return;
      try { own(owner, id); } catch { socket.close(1008, 'Camera session ended'); return; }
      let message; try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'frame-ack') {
        lease.inFlight = Math.max(0, lease.inFlight - 1);
      } else if (message.type === 'signal') {
        const signal = cameraSignal(message, 'answer');
        if (signal && lease.transport !== 'jpeg') send(host, { type: 'signal', viewer: id, ...signal });
      } else if (message.type === 'rtc-ready') {
        lease.transport = 'rtc'; lease.inFlight = 0; rate();
      } else if (message.type === 'fallback') {
        lease.transport = 'jpeg'; lease.inFlight = 0; send(host, { type: 'viewer-left', viewer: id }); rate();
      }
    });
    socket.on('close', () => { if (leases.get(id)?.viewer === socket) drop(id); });
    socket.on('error', () => { if (leases.get(id)?.viewer === socket) drop(id); });
    rate();
  }
  function setupStatus() {
    return { state: setupJob ? 'testing' : setupError ? 'error' : lastVerified ? 'verified' : 'not-set-up',
      verifiedAt: lastVerified || null, permissionBeforeCapture: host?.permissionState || 'unknown', error: setupError, connected: host?.socket?.readyState === 1, enabled: enabled() };
  }
  function prepare() {
    check();
    if (setupJob) return setupStatus();
    if (leases.size) throw fail(409, 'Stop the current camera preview before running setup.');
    setupError = null;
    setupJob = (async () => {
      let session;
      try {
        session = await start('local-camera-setup');
        await frame('local-camera-setup', session.id, { waitMs: setupFrameMs });
      } catch (err) { setupError = err.message; }
      finally { if (session) stop('local-camera-setup', session.id); }
    })().finally(() => { setupJob = null; });
    return setupStatus();
  }
  return { devices, start, frame, stop, acceptsHost, attachHost, acceptsViewer, attachViewer, setupStatus, prepare, dispose() {
    disposed = true; clearInterval(timer);
    for (const id of [...leases.keys()]) drop(id);
    stopCapture(); host?.socket?.close(1001, 'Pocket Dev stopped');
  } };
}
