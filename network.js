import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { STATE_DIR } from './paths.js';

export const INTERNET_KINDS = ['off', 'quick', 'domain'];
export const TOKEN_PATH = path.join(STATE_DIR, 'tunnel-token');
const CLOUDFLARED_PATHS = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
const TRACE_URL = process.env.POCKET_DEV_TRACE_URL || 'https://1.1.1.1/cdn-cgi/trace';
const PUBLIC_IP_FRESH_MS = 15 * 60_000;
const PUBLIC_IP_RETRY_MS = 30_000;

const DEFAULT = () => ({ wifi: true, internet: { kind: 'off', hostname: null } });
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
export const isHostname = (h) => typeof h === 'string' && h.length <= 253 && h.includes('.') && !isIP(h)
  && h.split('.').every((label) => LABEL.test(label));
export const isToken = (t) => typeof t === 'string' && /^[A-Za-z0-9+/_=-]{20,4096}$/.test(t);

// `network` in config.json: { wifi, internet: { kind, hostname } }. Anything unusable falls back to Wi-Fi only with
// internet off, the behavior Pocket Dev had before this setting existed. The hostname is kept only for the domain kind.
export function readNetwork(config) {
  const value = config.read().network;
  const net = DEFAULT();
  if (!value || typeof value !== 'object') return net;
  if (typeof value.wifi === 'boolean') net.wifi = value.wifi;
  const kind = value.internet?.kind;
  if (kind === 'quick') net.internet = { kind, hostname: null };
  else if (kind === 'domain' && isHostname(value.internet.hostname)) net.internet = { kind, hostname: value.internet.hostname.toLowerCase() };
  if (!net.wifi && net.internet.kind === 'off') net.wifi = true;
  return net;
}

// Why a saved value cannot be accepted, or null. `hasToken` says whether a tunnel token is saved or arrives with it.
export function networkError({ wifi, internet }, { hasToken }) {
  if (typeof wifi !== 'boolean') return 'wifi must be true or false.';
  if (!internet || !INTERNET_KINDS.includes(internet.kind)) return `internet.kind must be one of: ${INTERNET_KINDS.join(', ')}.`;
  if (internet.kind === 'domain' && !isHostname(internet.hostname)) return 'Enter the public hostname you gave the tunnel, such as pocket.example.com.';
  if (internet.kind === 'domain' && !hasToken) return 'Paste the tunnel token from the Cloudflare dashboard.';
  if (!wifi && internet.kind === 'off') return 'Turn on internet access before turning Wi-Fi access off, or nothing could reach Pocket Dev.';
  return null;
}

export const hasToken = () => fs.existsSync(TOKEN_PATH);
export const readToken = () => {
  try { return fs.readFileSync(TOKEN_PATH, 'utf8').trim() || null; } catch { return null; }
};
export function writeToken(token) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${TOKEN_PATH}.tmp`;
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_PATH);
}

// winget puts cloudflared in Program Files and links it in WinGet\Links; a bare PATH lookup covers anything else.
function cloudflaredPaths() {
  if (process.platform !== 'win32') return CLOUDFLARED_PATHS;
  const dirs = [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'cloudflared'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'cloudflared'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
    ...(process.env.PATH ?? '').split(path.delimiter)];
  return dirs.filter(Boolean).map((d) => path.join(d, 'cloudflared.exe'));
}

export const findCloudflared = () => [process.env.POCKET_DEV_CLOUDFLARED, ...cloudflaredPaths()].find((p) => p && fs.existsSync(p)) ?? null;

// The first 64 bits of an IPv6 address as four groups, or null for anything else (IPv4-mapped addresses included).
export function ipv6Prefix(ip) {
  if (isIP(ip) !== 6 || ip.includes('.')) return null;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.slice(0, 4).map((g) => g.padStart(4, '0').toLowerCase()).join(':');
}

async function fetchTrace(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  const ip = /^ip=(.+)$/m.exec(await res.text())?.[1].trim();
  if (!ip || !isIP(ip)) throw new Error('no ip line');
  return ip;
}

// Whether a request that came through the tunnel started on the Mac's own network. IPv6 clients are compared by /64
// with the Mac's global addresses; IPv4 clients with the Mac's public address, learned from Cloudflare's trace
// endpoint. Unknown is null, never true. `key(ip)` is a short hash of the client's network for the phone to remember a
// dismissed prompt under, without seeing the address.
export function createSameNetwork({ traceUrl = TRACE_URL, trace = fetchTrace, interfaces = os.networkInterfaces } = {}) {
  let cached = { ip: null, at: 0 };
  let inflight = null;

  const globalV6 = () => Object.values(interfaces()).flat()
    .filter((a) => a?.family === 'IPv6' && !a.internal && !/^(fe[89ab]|f[cd])/i.test(a.address))
    .map((a) => ipv6Prefix(a.address));

  function publicIp() {
    if (Date.now() - cached.at < (cached.ip ? PUBLIC_IP_FRESH_MS : PUBLIC_IP_RETRY_MS)) return Promise.resolve(cached.ip);
    inflight ??= trace(traceUrl).then((ip) => ip, () => null)
      .then((ip) => { cached = { ip, at: Date.now() }; inflight = null; return ip; });
    return inflight;
  }

  return {
    // Called at startup and when the LAN address changes: the public address likely changed too.
    refresh() {
      cached = { ip: null, at: 0 };
      publicIp();
    },
    async hint(ip) {
      if (isIP(ip) === 6) {
        const prefixes = globalV6();
        return prefixes.length ? prefixes.includes(ipv6Prefix(ip)) : null;
      }
      const mine = await publicIp();
      return mine === null ? null : mine === ip;
    },
    key: (ip) => crypto.createHash('sha256').update(ipv6Prefix(ip) ?? ip).digest('hex').slice(0, 12),
  };
}
