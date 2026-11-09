// Invite codes and invite text for joining a room. Pure: runs in the browser (join form, invite sheet) and in node (room.js, tests).

// 31 letters and digits with nothing that looks like another: no 0, O, 1, I or L.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

// "abcd efgh", "ABCD-EFGH" and "abcdefgh" are the same code.
export const normalizeCode = (text) => String(text ?? '').toUpperCase().replace(/[\s-]+/g, '');
export const isCode = (text) => normalizeCode(text).length === CODE_LENGTH && [...normalizeCode(text)].every((c) => CODE_ALPHABET.includes(c));
export const formatCode = (text) => { const c = normalizeCode(text); return c.length === CODE_LENGTH ? `${c.slice(0, 4)}-${c.slice(4)}` : c; };

// 127.x.x.x, localhost, ::1 and 0.0.0.0 name the device they are typed on, never another one.
export function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || h === '::' || /^127(\.\d{1,3}){3}$/.test(h) || /^::ffff:127\./.test(h);
}
export function isLoopbackAddress(address) {
  try { return isLoopbackHost(new URL(address).hostname); } catch { return false; }
}

// "192.168.1.5:7681" and "laptop.example.com" are fine to type; the server needs a full http or https address.
export function hostAddress(text) {
  const t = String(text || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t.replace(/^https?/i, (x) => x.toLowerCase());
  return /^(\d{1,3}(\.\d{1,3}){3}|localhost)(:\d+)?$|:\d+$/i.test(t) ? `http://${t}` : `https://${t}`;
}

// The address as people type it: no http:// for the usual local case.
export const shortAddress = (address) => String(address || '').replace(/^http:\/\//i, '').replace(/\/+$/, '');

// The single line shown to the host, copied, shared and put in the QR picture: "192.168.1.24:58765  ABCD-EFGH".
export const inviteLine = (address, code) => `${shortAddress(address)}  ${formatCode(code)}`;

// Reads whatever a person pasted or typed: "http://192.168.1.24:58765/ABCD-EFGH", "192.168.1.24:58765 abcd efgh",
// "192.168.1.24:58765/abcdefgh", a bare code. Returns the address as a full URL ('' when none was given) and the
// code as 8 characters ('' when none was found). Does not judge them; see inviteProblem.
const TAIL = new RegExp(`(^|[\\s/=:,|])([${CODE_ALPHABET}]{4})[\\s-]*([${CODE_ALPHABET}]{4})[\\s/]*$`, 'i');
export function parseInvite(text) {
  const raw = String(text ?? '').trim();
  const m = TAIL.exec(raw);
  const code = m ? (m[2] + m[3]).toUpperCase() : '';
  const rest = (m ? raw.slice(0, m.index + m[1].length) : raw).trim().replace(/[\s/,|:=]+$/, '').replace(/\?(code|invite)$/i, '').trim();
  const first = rest.split(/\s+/)[0] || '';
  return { host: first ? hostAddress(first) : '', code };
}

export const SAME_DEVICE_TEXT = '127.0.0.1 means this device itself. Use the Wi-Fi address of the host, like 192.168.1.24:7777';

// A plain sentence for the first thing wrong with what was entered, or '' when it can be sent.
// `knownHost` is the host's real address when this device has learned it; `allowLoopback` is for test setups.
export function inviteProblem({ host, code, knownHost = '', allowLoopback = false }) {
  if (!code) return 'Type the 8-character code from the host, like ABCD-EFGH. Codes never contain 0, O, 1, I or L.';
  if (!host) return 'Type the address of the host too, like 192.168.1.24:7777.';
  let url;
  try { url = new URL(host); } catch { return 'That address does not look right. Use something like 192.168.1.24:7777.'; }
  if (!/^https?:$/.test(url.protocol)) return 'The address must start with http or https, or be just the host and port.';
  if (isLoopbackHost(url.hostname) && !allowLoopback) return `${SAME_DEVICE_TEXT}${knownHost ? `. The host said it is ${shortAddress(knownHost)}.` : '.'}`;
  return '';
}

// Words for something that went wrong while joining. `message` is what the server (or the network) said.
export function joinError(message, { host = '', offline = false } = {}) {
  const m = String(message || '');
  if (offline || /failed to fetch|networkerror|load failed/i.test(m)) return 'This device is offline. Check its connection and try again.';
  const tried = /could not reach the host at ([^\s]+?)\.?(\s|$)/i.exec(m)?.[1] || (host && /unreachable|fetch failed|timed out|timeout|ECONN|ENOTFOUND/i.test(m) ? host : '');
  if (tried) {
    const port = (() => { try { return new URL(tried).port; } catch { return ''; } })();
    return `Could not reach the host at ${shortAddress(tried)}. The most likely causes: (1) the two devices are not on the same Wi-Fi; (2) a firewall on the host blocks it${port ? ` (allow port ${port}, on Windows allow Node.js through the firewall)` : ''}; (3) the port in the address is wrong.`;
  }
  if (/already used/i.test(m)) return 'That code was already used. Each code works once. Ask the host to tap "Get a new code".';
  if (/expired/i.test(m)) return 'That code has expired. Codes last 10 minutes. Ask the host to tap "Get a new code".';
  if (/not right|not valid|wrong/i.test(m)) return 'That code is wrong. Check it against the host screen, letter by letter.';
  if (/too many/i.test(m)) return m;
  if (/not in a room/i.test(m)) return 'That device is not hosting a room. Check the address, or create the room on the host first.';
  if (/already in a room/i.test(m)) return 'This device is already in a room.';
  return m || 'Something went wrong. Try again.';
}
