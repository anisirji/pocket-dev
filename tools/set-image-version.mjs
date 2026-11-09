#!/usr/bin/env node
// Not packaged. npm's page cannot show relative images and the repository is private, so README.md points at
// https://unpkg.com/@anisirji/pocket-dev@__VERSION__/docs/... Before `npm publish`, run this to replace the token with
// package.json's version; afterwards run it with --restore to put the token back. Both directions are idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = path.join(root, 'README.md');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const TOKEN = '__VERSION__';
const URL_PART = 'https://unpkg.com/@anisirji/pocket-dev@';

const text = fs.readFileSync(readme, 'utf8');
const restore = process.argv.includes('--restore');
const pattern = new RegExp(`${URL_PART.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}[^/\\s"']+/`, 'g');
const next = text.replace(pattern, `${URL_PART}${restore ? TOKEN : version}/`);
if (next !== text) fs.writeFileSync(readme, next);
console.log(`${restore ? 'Restored the version token' : `Set image links to ${version}`} in README.md${next === text ? ' (already done)' : ''}`);
