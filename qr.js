import QRCode from 'qrcode';

export const terminalQr = (text) => QRCode.toString(text, { type: 'terminal', small: true });
export const svgQr = (text) => QRCode.toString(text, { type: 'svg', margin: 2 });

export const qrNote = (minutes) => `Scan the QR code to log in without the password. It works once and expires in ${minutes} minutes. New code: npm run qr`;
