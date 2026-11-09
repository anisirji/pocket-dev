import { createLoginLimiter } from './auth.js';
import { clientIp } from './transport.js';

// Failed attempts at the room's peer routes (ping, accept, notify, sync) and at forwarded requests that carry a room secret.
// The login limiter's pattern, twice: one count per address and claimed sender (a guesser against one device's secret),
// and a looser one per address (a guesser that changes the name it claims). A success never clears a count, so a
// guesser cannot reset its own by also making valid calls.
const WINDOW_MS = Number(process.env.POCKET_DEV_PEER_LOCK_MS) || undefined;
export function createPeerGuard({ perSender = 10, perAddress = 40, windowMs = WINDOW_MS } = {}) {
  const bySender = createLoginLimiter({ max: perSender, windowMs });
  const byAddress = createLoginLimiter({ max: perAddress, windowMs });
  const key = (req, sender) => `${clientIp(req)}|${typeof sender === 'string' ? sender.slice(0, 64) : ''}`;
  return {
    // Milliseconds this caller is locked out for, 0 if it may try.
    lockedForMs: (req, sender) => Math.max(byAddress.lockedForMs(clientIp(req)), bySender.lockedForMs(key(req, sender))),
    // null to go on, otherwise the 429 reply.
    refuse(req, sender) {
      const ms = this.lockedForMs(req, sender);
      return ms ? { status: 429, error: lockedMessage(ms) } : null;
    },
    fail(req, sender) { byAddress.fail(clientIp(req)); bySender.fail(key(req, sender)); },
  };
}
export const lockedMessage = (ms) => `Too many wrong attempts. Try again in ${Math.max(1, Math.ceil(ms / 60_000))} min.`;
