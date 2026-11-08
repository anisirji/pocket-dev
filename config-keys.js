// The config.json keys a person may set from the terminal. Everything else in the file (devices' access flag, recent
// folders, chat defaults, the password hash) is written by the app and stays out of `pocket-dev config set`.
const integer = (min, max) => (text) => {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`must be a whole number from ${min} to ${max}`);
  return n;
};
const oneOf = (...values) => (text) => {
  if (!values.includes(text)) throw new Error(`must be one of: ${values.join(', ')}`);
  return text;
};
const boolean = (text) => {
  if (text !== 'true' && text !== 'false') throw new Error('must be true or false');
  return text === 'true';
};
const hostList = (text) => {
  const hosts = text.split(',').map((h) => h.trim()).filter(Boolean);
  if (!hosts.length) throw new Error('must list at least one host; use `config unset` to clear it');
  return hosts;
};

export const KEYS = {
  port: { parse: integer(1024, 65535), restart: true, help: 'Phone port (default 7777)' },
  adminPort: { parse: integer(1024, 65535), restart: true, help: 'Admin page port on this Mac (default: port + 1)' },
  awake: { parse: oneOf('off', 'plugged', 'always'), restart: false, help: 'Keep the Mac awake: off, plugged, always' },
  requireApproval: { parse: boolean, restart: false, help: 'New devices wait for approval on the Mac: true or false' },
  approveFromDevices: { parse: boolean, restart: false, help: 'Let a logged-in phone approve waiting logins: true or false (default false)' },
  maxDevices: { parse: integer(1, 20), restart: false, help: 'Most devices that can be logged in (1 to 20)' },
  chatIdleMinutes: { parse: integer(1, 1440), restart: false, help: 'Minutes before an idle chat engine stops (default 10)' },
  batteryAlertPercent: { parse: integer(5, 90), restart: false, help: 'Alert the phone when the Mac battery is at or below this percent and not charging (default 20)' },
  temperatureAlertC: { parse: integer(30, 70), restart: false, help: 'Alert the phone when the Mac battery temperature reaches this many \u00b0C (default 40)' },
  screenView: { parse: boolean, restart: false, help: 'Let a logged-in phone see this Mac\u2019s screen: true or false (default true)' },
  allowedHosts: { parse: hostList, restart: false, help: 'Extra Host names to accept, comma separated (a tunnel domain)' },
};
