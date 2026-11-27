import crypto from 'node:crypto';
import { parseScreenInput } from './screen-input.js';

const fail = (status, message, code = 'CONTROL_UNAVAILABLE') => Object.assign(new Error(message), { status, code, feature: 'screen-control', recoverable: true });
const token = () => crypto.randomBytes(32).toString('hex');
const equal = (a, b) => typeof a === 'string' && /^[0-9a-f]{64}$/.test(a) && typeof b === 'string' && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// One controller with fresh connection credentials. Optional computer-wide approval survives disconnects;
// every connection still needs a new lease, active login and explicit remote start.
export function createScreenControl({ adapter, authorized, enabled = () => true, approval = null, now = Date.now, approvalMs = 60000, heartbeatMs = 8000, intervalMs = 1000 }) {
  let current = null, disposed = false, timer;
  const send = (socket, message) => { try { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); } catch {} };
  function stop(message = 'Desktop control stopped.') {
    const lease = current; if (!lease) return;
    current = null; clearInterval(timer); timer = null; lease.adapter?.close();
    send(lease.ownerSocket, { t: 'stopped', message }); send(lease.hostSocket, { t: 'stopped', message });
    lease.ownerSocket?.close(1000, 'Control stopped'); lease.hostSocket?.close(1000, 'Control stopped');
  }
  function sweep() {
    const lease = current; if (!lease) return;
    if (disposed || !enabled() || !authorized(lease.owner) || (lease.remembered && !approval?.has()) || (!lease.remembered && now() - lease.created > 10 * 60000)) return stop('Desktop control authorization ended.');
    if ((!lease.approved && now() - lease.created > approvalMs) || (lease.approved && (!lease.ownerSocket || (!lease.remembered && !lease.hostSocket)) && now() - lease.approved > 10000)) return stop('The control request expired. Request it again when the Mac is ready.');
    if (lease.ownerSocket && now() - lease.ownerAt > heartbeatMs || lease.hostSocket && now() - lease.hostAt > heartbeatMs) return stop('The control connection stopped responding.');
    if (lease.state === 'active' && !lease.checking) {
      lease.checking = true; lease.adapter.check().catch(() => { if (current === lease) stop('macOS ended desktop control.'); }).finally(() => { lease.checking = false; });
    }
  }
  function localState() {
    sweep(); const lease = current;
    return lease ? { state: lease.state, requestId: lease.id, name: lease.name, display: lease.display, createdAt: lease.created, remembered: Boolean(lease.remembered) } : { state: 'off' };
  }
  function status(owner) {
    const state = localState(), lease = current;
    if (!lease) return state;
    if (lease.owner !== owner) return { state: 'busy', message: 'Another device is requesting or using control.' };
    return { ...state, ...(lease.approved && (lease.remembered || lease.hostSocket) && { token: lease.ownerToken }) };
  }
  async function request(device, display = 1) {
    sweep();
    if (disposed || !enabled() || !authorized(device.id)) throw fail(403, 'Screen control is not authorized.');
    if (current) throw fail(409, 'Another control request is active. Stop it before requesting control again.');
    const support = await adapter.support();
    if (!support.available) throw fail(409, support.message, support.code || 'SETUP_REQUIRED');
    const selected = support.displays?.find((screen) => screen.index === display);
    if (!selected || !Number.isInteger(selected.id) || selected.id < 1) throw fail(400, 'Choose an available Mac display.');
    // Repeat after the capability check so two requests cannot both acquire a lease.
    if (current || !enabled() || !authorized(device.id)) throw fail(409, 'Control availability changed. Request it again.');
    current = { id: token(), owner: device.id, name: device.name, display, displayId: selected.id, created: now(), state: 'awaiting-approval', sequence: 0, pending: 0, rateAt: now(), count: 0 };
    if (approval?.has()) {
      current.remembered = true; current.approved = now(); current.state = 'awaiting-controller'; current.ownerToken = token();
    }
    timer = setInterval(sweep, intervalMs); timer.unref?.();
    return status(device.id);
  }
  async function approve(id, allow) {
    sweep(); const lease = current;
    if (!lease || lease.id !== id || lease.approved) throw fail(409, 'This control request is no longer waiting.');
    if (allow !== true) { stop('Control was declined on the Mac.'); return { state: 'off' }; }
    const support = await adapter.support();
    if (current !== lease || disposed || !enabled() || !authorized(lease.owner)) throw fail(409, 'This control request ended.');
    if (!support.available || !support.displays?.some((display) => display.id === lease.displayId)) { stop(); throw fail(409, support.message || 'The selected display changed.'); }
    if (approval) { approval.grant(); lease.remembered = approval.has(); }
    lease.approved = now(); lease.state = lease.remembered ? 'awaiting-controller' : 'awaiting-host'; lease.ownerToken = token();
    if (!lease.remembered) lease.hostToken = token();
    return { ...localState(), ...(!lease.remembered && { hostToken: lease.hostToken }) };
  }
  function acceptsHost(secret) { sweep(); return !!current?.approved && !current.hostSocket && equal(secret, current.hostToken); }
  function attachHost(socket, secret) {
    if (!acceptsHost(secret)) { socket.close(1008, 'Control is not approved'); return; }
    const lease = current; lease.hostSocket = socket; lease.hostAt = now();
    send(socket, { t: 'hello', name: lease.name, display: lease.display });
    socket.on('message', (raw) => {
      if (current !== lease) return;
      let message; try { message = JSON.parse(String(raw)); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(); } catch { return stop(); }
      if (message.t === 'hidden' || message.t === 'stop') return stop('Control stopped on the Mac.');
      if (message.t === 'ping') { lease.hostAt = now(); send(socket, { t: 'pong' }); }
    });
    socket.on('close', () => { if (current === lease) stop('The Mac control indicator closed.'); });
    socket.on('error', () => { if (current === lease) stop(); });
  }
  function acceptsOwner(owner, secret) { sweep(); return current?.owner === owner && !!current.approved && !!(current.remembered || current.hostSocket) && !current.ownerSocket && equal(secret, current.ownerToken); }
  async function attachOwner(owner, secret, socket) {
    if (!acceptsOwner(owner, secret)) { socket.close(1008, 'Control is not approved'); return; }
    const lease = current; lease.ownerSocket = socket; lease.ownerAt = now(); lease.state = 'starting';
    socket.on('close', () => { if (current === lease) stop('The controller disconnected. Request control again to resume.'); });
    socket.on('error', () => { if (current === lease) stop(); });
    socket.on('message', (raw) => {
      if (current !== lease) return;
      sweep(); if (current !== lease) return;
      let message; try { if (raw.length > 4096) throw new Error(); message = JSON.parse(String(raw)); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(); } catch { return stop('Invalid control input.'); }
      if (message.t === 'ping') { lease.ownerAt = now(); return send(socket, { t: 'pong' }); }
      if (message.t === 'stop') return stop('Control stopped by the controller.');
      if (message.t !== 'input' || lease.state !== 'active') return;
      if (!Number.isSafeInteger(message.seq) || message.seq <= lease.sequence || !Number.isFinite(message.at) || Math.abs(now() - message.at) > 2000) return stop('Old or repeated input was discarded.');
      if (now() - lease.rateAt > 1000) { lease.rateAt = now(); lease.count = 0; }
      if (++lease.count > 60 || lease.pending >= 4) return stop('Desktop input arrived too quickly. Request control again.');
      let event; try { event = parseScreenInput(message.event); } catch { return stop('Unsupported desktop input was refused.'); }
      lease.sequence = message.seq; lease.pending++; lease.ownerAt = now();
      lease.adapter.input(event).then(() => { if (current === lease) send(socket, { t: 'ack', seq: message.seq }); }).catch(() => { if (current === lease) stop('Mac input stopped. Check the Mac and request control again.'); }).finally(() => { lease.pending--; });
    });
    try {
      lease.adapter = adapter.start(lease.displayId, () => { if (current === lease) stop('macOS stopped desktop control.'); });
      await lease.adapter.ready;
      if (current !== lease) { lease.adapter.close(); return; }
      lease.state = 'active'; send(socket, { t: 'ready', now: now() }); send(lease.hostSocket, { t: 'active' });
    } catch { if (current === lease) stop('The Mac input adapter could not start.'); }
  }
  return { request, approve, status, localState, acceptsHost, attachHost, acceptsOwner, attachOwner,
    support: () => enabled() ? adapter.support() : Promise.resolve({ state: 'permission-required', available: false, message: 'Screen control is disabled in Admin.' }),
    revokeCurrent() { approval?.revoke(); stop('Control approval was revoked in Admin.'); },
    cancel(owner, id) { if (current?.owner === owner && current.id === id) stop(); }, stop, close() { disposed = true; clearInterval(timer); stop(); } };
}
