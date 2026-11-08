import { isIP } from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Only the connector on this Mac may supply proxy information. LAN clients cannot choose their rate-limit IP.
export const fromConnector = (req) => LOOPBACK.has(req.socket.remoteAddress)
  && req.headers['x-forwarded-proto'] === 'https' && isIP(req.headers['cf-connecting-ip'] ?? '') !== 0;

export const clientIp = (req) => fromConnector(req) ? req.headers['cf-connecting-ip']
  : (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

// The address a cookie is issued for: the tunnel hostname the request came in on, or 'lan' for any direct address.
export const cookieHost = (req) => (fromConnector(req) ? (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '') : 'lan');

export const secureCookie = (req, cookie) => `${cookie}${req.socket.encrypted || fromConnector(req) ? '; Secure' : ''}`;

export const sameOrigin = (req) => !req.headers.origin
  || [`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin);
