// Starts the isolated demo servers and fills them with private-safe data for tools/capture-screenshots.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, until } from '../test/helpers/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(HERE, '..', 'test', 'helpers', 'fake-claude.mjs');
export const DEMO_IP = '192.168.1.20';

// startServer wants a test context for cleanup; this collects the callbacks so main() can run them at the end.
export function cleanupBag() {
  const fns = [];
  return { after: (fn) => fns.push(fn), run: async () => { for (const fn of fns.reverse()) { try { await fn(); } catch { /* best effort */ } } } };
}

const git = (cwd, args, date) => execFileSync('git', ['-c', 'user.name=Alex Demo', '-c', 'user.email=alex@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
  cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1' },
});

// A neutral zsh: prompt is "~/path $" and nothing from the real shell setup loads.
export function zdotdir(root) {
  const dir = path.join(root, 'zsh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.zshrc'), "PROMPT='%~ $ '\nRPROMPT=''\nunsetopt PROMPT_SP\nalias ls='ls -G'\nexport CLICOLOR=1\nexport LSCOLORS=ExGxFxdxCxDxDxBxBxExEx\nnpm() { cat \"$ZDOTDIR/npm-test.txt\"; }\n");
  fs.writeFileSync(path.join(dir, 'npm-test.txt'), ['', '\x1b[1m> demo-app@0.3.0 test\x1b[0m', '> vitest run', '', ' \x1b[32m✓\x1b[0m src/utils.test.js \x1b[2m(4 tests)\x1b[0m \x1b[2m3ms\x1b[0m', ' \x1b[32m✓\x1b[0m src/App.test.jsx \x1b[2m(8 tests)\x1b[0m \x1b[2m41ms\x1b[0m', '', '\x1b[2m Test Files \x1b[0m \x1b[1m\x1b[32m2 passed\x1b[0m\x1b[90m (2)\x1b[0m', '\x1b[2m      Tests \x1b[0m \x1b[1m\x1b[32m12 passed\x1b[0m\x1b[90m (12)\x1b[0m', '\x1b[2m   Duration \x1b[0m 612ms', ''].join('\n'));
  return dir;
}

export async function demoServer(bag, { name, env = {}, repo = false, logo } = {}) {
  const lanFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lan-')), 'ip');
  fs.writeFileSync(lanFile, DEMO_IP);
  const s = await startServer(bag, { env: { POCKET_DEV_CLAUDE: FAKE_CLAUDE, POCKET_DEV_LAN_IP_FILE: lanFile, ZDOTDIR: zdotdir(os.tmpdir()), POCKET_DEV_ROOM_PING_MS: '500', POCKET_DEV_TASK_SYNC_MS: '400', POCKET_DEV_CHAT_SYNC_MS: '200', ...env } });
  s.deviceName = name;
  s.demo = path.join(s.home, 'projects', 'demo-app');
  s.cookie = (await s.login()).cookie;
  s.call = (method, url, body) => s.request(method, url, { cookie: s.cookie, body });
  if (repo) seedProject(s, s.demo, { logo });
  return s;
}

export function seedProject(s, dir = s.demo, { logo } = {}) {
  const w = (file, text) => { const f = path.join(dir, file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  fs.mkdirSync(dir, { recursive: true });
  const day = (d) => `2026-11-0${d}T10:${10 + d}:00`;
  git(dir, ['init', '-q'], day(1));
  w('README.md', '# Demo App\n\nA small React app used to try out Pocket Dev.\n\n## Run it\n\n```\nnpm install\nnpm run dev\n```\n');
  w('package.json', JSON.stringify({ name: 'demo-app', version: '0.3.0', private: true, scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' }, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }, null, 2) + '\n');
  w('index.html', '<!doctype html>\n<div id="root"></div>\n<script type="module" src="/src/main.jsx"></script>\n');
  w('vite.config.js', "import { defineConfig } from 'vite';\nexport default defineConfig({});\n");
  w('LICENSE', 'ISC License\n');
  w('.gitignore', 'node_modules\ndist\n');
  w('src/main.jsx', "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n");
  w('src/App.jsx', "import { useState } from 'react';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return <main>\n    <h1>Demo App</h1>\n    <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>\n  </main>;\n}\n");
  w('src/styles.css', ':root {\n  --bg: #ffffff;\n  --fg: #1a1a1a;\n}\n\nbody { background: var(--bg); color: var(--fg); }\n');
  git(dir, ['add', '-A'], day(1)); git(dir, ['commit', '-qm', 'Start the demo app'], day(1));
  w('src/utils.js', 'export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\n');
  git(dir, ['add', '-A'], day(2)); git(dir, ['commit', '-qm', 'Add a clamp helper'], day(2));
  git(dir, ['checkout', '-qb', 'feature/settings-page'], day(3));
  w('src/Settings.jsx', 'export default function Settings() {\n  return <section><h2>Settings</h2></section>;\n}\n');
  git(dir, ['add', '-A'], day(3)); git(dir, ['commit', '-qm', 'Add an empty settings page'], day(3));
  w('src/Settings.jsx', 'export default function Settings() {\n  return <section><h2>Settings</h2><label><input type="checkbox" /> Notifications</label></section>;\n}\n');
  git(dir, ['add', '-A'], day(4)); git(dir, ['commit', '-qm', 'Settings: notifications switch'], day(4));
  git(dir, ['checkout', '-q', 'main'], day(5));
  w('src/styles.css', ':root {\n  --bg: #ffffff;\n  --fg: #1a1a1a;\n  --accent: #3b82f6;\n}\n\nbody { background: var(--bg); color: var(--fg); }\n');
  git(dir, ['add', '-A'], day(5)); git(dir, ['commit', '-qm', 'Add an accent colour'], day(5));
  git(dir, ['merge', '-q', '--no-ff', 'feature/settings-page', '-m', 'Merge the settings page'], day(6));
  w('docs/notes.md', '# Notes\n\n- Ship the dark mode toggle\n- Remember the choice between visits\n');
  git(dir, ['add', '-A'], day(7)); git(dir, ['commit', '-qm', 'Write down next steps'], day(7));
  // Working tree: two modified, one staged, two untracked.
  w('src/App.jsx', "import { useState } from 'react';\nimport { clamp } from './utils.js';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return <main>\n    <h1>Demo App</h1>\n    <button onClick={() => setCount(clamp(count + 1, 0, 10))}>Clicked {count} times</button>\n  </main>;\n}\n");
  w('README.md', '# Demo App\n\nA small React app used to try out Pocket Dev.\n\n## Run it\n\n```\nnpm install\nnpm run dev\n```\n\n## Test it\n\n```\nnpm test\n```\n');
  git(dir, ['add', 'README.md'], day(7));
  w('src/Footer.jsx', 'export default function Footer() {\n  return <footer>Made with Pocket Dev</footer>;\n}\n');
  w('.env.example', 'API_URL=http://localhost:3000\n');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  if (logo) fs.writeFileSync(path.join(dir, 'assets', 'logo.png'), logo);
  // Spread the modified times so the list does not read "just now" everywhere.
  const when = (name, daysAgo) => { const t = new Date(Date.now() - daysAgo * 86400_000 - 3600_000 * (name.length % 7)); try { fs.utimesSync(path.join(dir, name), t, t); } catch { /* skip */ } };
  [['README.md', 1], ['package.json', 3], ['index.html', 8], ['vite.config.js', 8], ['LICENSE', 8], ['src', 0], ['docs', 2], ['assets', 4], ['src/App.jsx', 0], ['src/Footer.jsx', 0], ['src/styles.css', 4], ['src/utils.js', 7], ['src/main.jsx', 8], ['src/Settings.jsx', 5]].forEach(([n, d]) => when(n, d));
  fs.mkdirSync(path.join(s.home, 'projects', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(s.home, 'projects', 'notes', 'todo.txt'), 'buy milk\n');
}

const put = (dir, file, text, daysAgo = 3) => {
  const f = path.join(dir, file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
  const t = new Date(Date.now() - daysAgo * 86400_000); fs.utimesSync(f, t, t);
};

// A plain folder tree for the other devices, so their Files screens look lived in.
function seedStudio(s) {
  const p = path.join(s.home, 'Projects');
  put(p, 'campaign-site/index.html', '<h1>Spring campaign</h1>\n', 2);
  put(p, 'campaign-site/styles.css', 'body { margin: 0; }\n', 4);
  put(p, 'brand-kit/palette.txt', 'blue #3b82f6\nviolet #8b5cf6\n', 9);
  put(p, 'render-notes.md', '# Render notes\n\nExport at 4K, 30 fps.\n', 1);
  put(s.home, 'Documents/invoice-march.pdf', '%PDF-1.4\n', 12);
  put(s.home, 'Documents/storyboard.md', '# Storyboard\n', 6);
  put(s.home, 'Downloads/old_videos/clip-01.mov', 'x', 40);
  put(s.home, 'Downloads/old_videos/clip-02.mov', 'x', 40);
  put(s.home, 'Downloads/reference.png', 'x', 5);
  put(s.home, 'Music/loop.wav', 'x', 20);
  fs.mkdirSync(path.join(s.home, 'Movies'), { recursive: true });
}
function seedLinux(s) {
  const p = path.join(s.home, 'code');
  put(p, 'api-server/main.go', 'package main\n', 1);
  put(p, 'api-server/go.mod', 'module api-server\n', 8);
  put(p, 'api-server/Dockerfile', 'FROM golang:1.22\n', 8);
  put(p, 'scripts/backup.sh', '#!/bin/sh\n', 14);
  put(s.home, 'notes/standup.txt', 'blocked on the staging cert\n', 0);
  put(s.home, 'data/export.csv', 'id,name\n1,a\n', 2);
}

// The three devices of the room: Home Mac hosts, Studio PC and Work Linux box join as admin devices.
export async function demoRoom(bag, { env = {}, logo, picture } = {}) {
  const home = await demoServer(bag, { name: 'Home Mac', repo: true, logo, env });
  const studio = await demoServer(bag, { name: 'Studio PC', env });
  const linux = await demoServer(bag, { name: 'Work Linux box', env });
  seedStudio(studio); seedLinux(linux);
  const all = [home, studio, linux];
  for (const [s, phone] of [[home, 'iPhone'], [studio, 'iPad'], [linux, 'Pixel 8']]) {
    s.api = (method, endpoint = '', body) => s.request(method, `/api/room${endpoint}`, { cookie: s.cookie, body });
    s.id = (await s.api('GET', '')).data.deviceId;
    s.to = (target, method, endpoint, body) => s.request(method, `/m/${target.id}${endpoint}`, { cookie: s.cookie, body });
    const me = (await s.call('GET', '/api/settings')).data.currentDeviceId;
    await s.call('PATCH', `/api/devices/${me}`, { name: phone });
    s.phone = phone;
  }
  const created = await home.api('POST', '/create', { name: 'Home Mac', addresses: [home.base] });
  if (created.status !== 200) throw new Error(`room create failed: ${JSON.stringify(created.data)}`);
  for (const s of [studio, linux]) {
    const { data: { code } } = await home.api('POST', '/invite');
    const r = await s.api('POST', '/join', { code, host: home.base, name: s.deviceName, addresses: [s.base], level: 'admin' });
    if (r.status !== 200) throw new Error(`join failed: ${JSON.stringify(r.data)}`);
  }
  await until(async () => (await studio.api('GET', '')).data.room?.members.length === 3);
  return { home, studio, linux, all };
}
