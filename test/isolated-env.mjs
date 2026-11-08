import path from 'node:path';

// These name the owner's Claude Code and Codex history, or their running Codex daemon. A copy inherited from the shell
// that runs the tests would send a test's claude or codex there however HOME is set.
const OWNER_PATHS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'POCKET_DEV_CLAUDE_DIR', 'POCKET_DEV_CODEX_DIR', 'POCKET_DEV_CODEX_SOCKET', 'POCKET_DEV_CHAT_DIR'];

// The environment for a Pocket Dev server, CLI or shell that a test starts. A claude or codex started under it (a resumed
// terminal, a chat engine, a shortcut typed into a test terminal) writes its history inside `home`, never in ~/.claude or
// ~/.codex. test/hygiene.test.mjs fails for a test that starts server.js without it.
export function isolatedEnv(home, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !OWNER_PATHS.includes(key)));
  return {
    ...env,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    POCKET_DEV_CLAUDE_DIR: path.join(home, '.claude', 'projects'),
    POCKET_DEV_CODEX_DIR: path.join(home, '.codex'),
    ...extra,
  };
}
