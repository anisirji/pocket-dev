import fs from 'node:fs';
import path from 'node:path';
import { platform } from '../platform.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const IMAGE_FILE_RE = /^[\w-]+\.(png|jpg|gif|webp)$/;
export const CONTENT_TYPE = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

// Saves each base64 image in a tool result next to the chat and returns { index -> file name }. The chat stores only
// the names, so a screenshot never bloats the saved conversation; the phone fetches the file when it opens the fold.
export function saveToolImages(dir, content, toolUseId) {
  const saved = new Map();
  if (!Array.isArray(content)) return saved;
  const safeId = String(toolUseId).replace(/[^\w-]/g, '_').slice(0, 60);
  content.forEach((block, index) => {
    const ext = EXT[block?.source?.media_type];
    const data = block?.source?.data;
    if (block?.type !== 'image' || block.source?.type !== 'base64' || !ext || typeof data !== 'string') return;
    if (data.length * 0.75 > IMAGE_MAX_BYTES) return;
    const name = `${safeId}-${index}.${ext}`;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, name), Buffer.from(data, 'base64'), { mode: 0o600 });
    saved.set(index, name);
  });
  return saved;
}

// Text parts as they are; an image that was saved shows as a picture instead, any other as its type in brackets.
export function resultText(content, saved = new Map()) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((c, i) => (c.type === 'text' ? [c.text] : saved.has(i) ? [] : [`[${c.type}]`])).join('\n');
}

export const ATTACHMENT_NAME_RE = /^([0-9a-f]{12})\.(\d{1,2})$/;
export const ATTACHMENT_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const THUMB_SIDE = 480;

// A phone photo is several MB, so the chat shows a small JPEG made once and kept with the chat's other images.
// If it cannot be made, the original is used as long as it is not large.
export function thumbnailOf(dir, key, source) {
  const thumb = path.join(dir, `thumb-${key}.jpg`);
  if (fs.existsSync(thumb)) return Promise.resolve(thumb);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return platform.resizeImage({ input: source, output: thumb, side: THUMB_SIDE, quality: 70 })
    .then(() => (fs.existsSync(thumb) ? thumb : null), () => null);
}
