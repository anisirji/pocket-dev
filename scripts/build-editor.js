import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const result = await build({ entryPoints: ['scripts/workspace-editor.js'], bundle: true, format: 'esm', minify: true,
  outfile: 'public/vendor/workspace-editor.js', metafile: true, logLevel: 'info' });
const packages = new Set(Object.keys(result.metafile.inputs).flatMap((file) => {
  const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file);
  return match ? [match[1]] : [];
}));
const notices = ['Third-party notices for the bundled CodeMirror editor. Rebuild: npm run build:editor.\n'];
for (const name of [...packages].sort()) {
  const root = path.join('node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].map((file) => path.join(root, file)).find(fs.existsSync);
  if (!license) throw new Error(`Missing license notice for ${name}.`);
  notices.push(`\n${name} ${pkg.version}\n${fs.readFileSync(license, 'utf8')}`);
}
fs.writeFileSync('public/vendor/workspace-editor.LICENSE.txt', notices.join('\n'));
