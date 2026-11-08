import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_URL_PATH } from '../admin.js';

// pocket-dev message: send a message to Messages as the Mac, through the Admin page's API.
const USAGE = `usage: pocket-dev message [text] [--to <name or device code>] [--file <path> ...]
Text comes from the argument or piped stdin, for example: pbpaste | pocket-dev message`;
const NOT_RUNNING = 'Pocket Dev is not running. Start it with pocket-dev start (or pocket-dev service install), then try again.';

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const words = [], files = [];
let to;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--to' || args[i] === '--file') {
    const value = args[++i];
    if (value === undefined) fail(`${args[i - 1]} needs a value.\n${USAGE}`, 2);
    if (args[i - 1] === '--to') to = value;
    else files.push(value);
  } else words.push(args[i]);
}

let text = words.join(' ');
if (!text && !process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  // `echo hi | pocket-dev message` should send "hi", not "hi" and a line break.
  text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
if (!text.trim() && !files.length) fail(USAGE, 2);
for (const file of files) if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail(`Not a file: ${file}`, 2);

let url;
try { ({ url } = JSON.parse(fs.readFileSync(ADMIN_URL_PATH, 'utf8'))); } catch { fail(NOT_RUNNING); }

async function call(method, pathname, body, headers = { 'content-type': 'application/json' }) {
  let res;
  try {
    res = await fetch(url + pathname, { method, headers: { 'x-pocket-admin': '1', ...headers }, body });
  } catch {
    fail(NOT_RUNNING);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error ?? `The admin page answered ${res.status}.`);
  return data;
}

const ids = [];
for (const file of files) {
  const blob = await fs.openAsBlob(file);
  const headers = { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(path.basename(file)) };
  ids.push((await call('POST', '/api/messages/files', blob, headers)).id);
}
const sent = await call('POST', '/api/messages', JSON.stringify({ text, files: ids, ...(to !== undefined && { to }) }));
console.log(`Sent to ${sent.to?.name ?? 'Everyone'}.`);
