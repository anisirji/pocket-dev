import QRCode from 'qrcode';

export const terminalQr = (text) => QRCode.toString(text, { type: 'terminal', small: true });
export const svgQr = (text) => QRCode.toString(text, { type: 'svg', margin: 2 });

export function connectionQrOptions(urls, { remoteEnabled = false, remoteHostname = null } = {}) {
  return {
    // A .local name still exists while Wi-Fi is disconnected; it is not proof
    // that the phone can reach a local listener.
    local: urls.lan || null,
    remote: urls.remote || (remoteEnabled && remoteHostname ? `https://${remoteHostname}` : null),
    remoteEnabled: remoteEnabled || Boolean(urls.remote),
  };
}

// Only select addresses supplied by this server. Clients cannot turn QR generation
// into an arbitrary URL generator. Omitted selection retains the legacy API default.
export function qrConnectionAddress(options, connection) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (connection !== undefined && !['local', 'remote'].includes(connection)) fail(400, 'Choose Local or Remote connection.');
  if (connection === 'remote' && !options.remoteEnabled) fail(409, 'Remote access is disabled. Use the local connection.');
  const address = connection ? options[connection] : options.remote || options.local;
  if (!address) fail(409, connection === 'local'
    ? 'Local access is unavailable. Check Wi-Fi and local network access on the computer.'
    : 'The remote link is not ready. Local access remains available on the same network.');
  return address;
}

export const qrNote = (minutes) => `Scan the QR code to log in without the password. It works once and expires in ${minutes} minutes. New code: pocket-dev qr`;
