import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const DEFAULT_PORT = 7777;
const SCAN = 30;
export const FIRST_RUN_MARKER = 'first-run-done';

const canBind = (port, host) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, host, () => probe.close(() => resolve(true)));
});

// Windows lets a loopback listener share a port with a wildcard one, so a port is free only when both addresses are.
export async function isFree(port) {
  return (await canBind(port, '0.0.0.0')) && (await canBind(port, '127.0.0.1'));
}

async function ownerNote(port, ownerOf) {
  const owner = await ownerOf(port).catch(() => null);
  return owner ? ` by ${owner.command ?? 'a process'} (pid ${owner.pid})` : '';
}

// A port is explicit when the person set it: a flag, the PORT variable, or a config.json value Pocket Dev did not
// choose itself. `autoPorts` remembers what fallback chose, so editing the value later makes it explicit again.
async function pick({ key, label, flagOrEnv, saved, auto, base, taken, free, ownerOf }) {
  const explicit = flagOrEnv ? Number(flagOrEnv) : saved !== undefined && saved !== auto ? Number(saved) : null;
  if (explicit) {
    if (!(await free(explicit))) {
      throw new Error(`${label} ${explicit} is in use${await ownerNote(explicit, ownerOf)}. You set it yourself, so Pocket Dev will not change it. Quit that program or choose another port.`);
    }
    return { port: explicit, auto: false };
  }
  for (let port = auto ?? base, n = 0; n < SCAN; port++, n++) {
    if (port > 65535 || taken.includes(port)) continue;
    if (await free(port)) return { port, auto: true };
  }
  throw new Error(`No free ${label.toLowerCase()} found from ${base} up. Set one with: pocket-dev config set ${key} <number>`);
}

// Returns { port, adminPort, notes }. Saves a fallback choice to config.json so restarts keep it.
export async function resolvePorts({ config, env = process.env, free = isFree, ownerOf = async () => null }) {
  const cfg = config.read();
  const autoPorts = cfg.autoPorts ?? {};
  const main = await pick({ key: 'port', label: 'Port', flagOrEnv: env.PORT, saved: cfg.port, auto: autoPorts.port, base: DEFAULT_PORT, taken: [], free, ownerOf });
  const adminSaved = cfg.adminPort;
  const admin = await pick({ key: 'adminPort', label: 'Admin port', flagOrEnv: env.POCKET_DEV_ADMIN_PORT, saved: adminSaved, auto: autoPorts.adminPort,
    base: main.port + 1, taken: [main.port], free, ownerOf });
  const notes = [];
  const nextAuto = { ...(main.auto ? { port: main.port } : {}), ...(admin.auto ? { adminPort: admin.port } : {}) };
  const changes = {};
  if (main.auto && main.port !== DEFAULT_PORT) {
    changes.port = main.port;
    notes.push(`Port ${DEFAULT_PORT} is busy, so Pocket Dev uses ${main.port} and remembers it.`);
  }
  if (admin.auto && admin.port !== main.port + 1) {
    changes.adminPort = admin.port;
    notes.push(`The admin port is ${admin.port} because ${main.port + 1} is busy.`);
  }
  if (Object.keys(changes).length) {
    const kept = Object.fromEntries(Object.entries(nextAuto).filter(([k]) => k in changes || cfg[k] === autoPorts[k]));
    config.update({ ...changes, autoPorts: { ...autoPorts, ...kept } });
  }
  return { port: main.port, adminPort: admin.port, notes };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

// admin.json names the admin page and the process that serves it. Both must be live: a crash leaves the file behind,
// and its port may since belong to another program. The page itself is a static file, so the answer is quick.
export async function runningInstance(stateDir, fetchFn = fetch) {
  let url, pid;
  try { ({ url, pid } = JSON.parse(fs.readFileSync(path.join(stateDir, 'admin.json'), 'utf8'))); } catch { return null; }
  if (pid !== undefined && !alive(pid)) return null;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
    return res.ok ? url : null;
  } catch { return null; }
}

// Asks once, on the first interactive start, when a chat tool or cloudflared is missing. `ctx` is a setup context.
export async function firstRun({ stateDir, ctx, detect, runSetup, interactive = ctx.isTTY && !ctx.env.CI }) {
  const marker = path.join(stateDir, FIRST_RUN_MARKER);
  if (!interactive || fs.existsSync(marker)) return 'skipped';
  const missing = (await detect(ctx, ['claude', 'codex', 'cloudflared'])).filter((d) => !d.installed);
  if (!missing.length) return 'skipped';
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(marker, new Date().toISOString() + '\n');
  if (!(await ctx.ask('First time here. Set up now? (installs Claude Code, Codex, cloudflared; shows each command first) [Y/n] ', true))) {
    ctx.out('Starting without setup. You can run it later with: pocket-dev setup');
    return 'declined';
  }
  await runSetup([], ctx);
  ctx.out('Logging in to Claude Code and Codex happens in your browser. Setup shows the command; finish the login there.');
  return 'ran';
}
