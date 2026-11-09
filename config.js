import fs from 'node:fs';
import { platform } from './platform.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parse(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObject(value)) throw new Error(`${file} must hold a JSON object`);
  return value;
}

// config.json is edited by hand while the server runs, so the file is the source of truth: read() re-reads it, and
// update() re-reads it and writes back only the keys the caller changed. Readers validate what they read and fall back
// in memory; a fallback is never written, so a malformed hand edit stays on disk for the user to fix.
export function openConfig(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ port: 7777 }, null, 2) + '\n', { mode: 0o600 });
    console.log(`Created ${file}`);
  }
  let last = parse(file);
  let warned = '';

  function read() {
    try {
      last = parse(file);
      warned = '';
    } catch (err) {
      if (err.message !== warned) console.warn(`Using the last readable config: ${err.message}`);
      warned = err.message;
    }
    return last;
  }

  // An undefined value deletes the key. Throws, without writing, when the file on disk is not valid JSON.
  function update(changes) {
    let next;
    try {
      next = parse(file);
    } catch (err) {
      throw new Error(`Not saved: ${err.message}. Fix config.json on ${platform.host.the} and try again.`);
    }
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    last = next;
  }

  return { file, read, update };
}
