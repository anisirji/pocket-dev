#!/usr/bin/env node
// Not packaged. npm's page cannot show relative images and the repository is private, so README.md and
// docs/INSTALL_BEGINNERS.md point at https://unpkg.com/@anisirji/pocket-dev@<version>/docs/... The committed files carry the
// released version. Before `npm publish`, run this to set package.json's version in both files; run it with --restore to
// put the __VERSION__ token back (for example to bump the version). Both directions are idempotent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['README.md', path.join('docs', 'INSTALL_BEGINNERS.md')];
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const TOKEN = '__VERSION__';
const URL_PART = 'https://unpkg.com/@anisirji/pocket-dev@';
const restore = process.argv.includes('--restore');
const pattern = new RegExp(`${URL_PART.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}[^/\\s"')]+/`, 'g');

for (const name of FILES) {
  const file = path.join(root, name);
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(pattern, `${URL_PART}${restore ? TOKEN : version}/`);
  if (next !== text) fs.writeFileSync(file, next);
  console.log(`${restore ? 'Restored the version token' : `Set image links to ${version}`} in ${name.replace(/\\/g, '/')}${next === text ? ' (already done)' : ''}`);
}
