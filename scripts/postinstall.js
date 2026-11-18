// Runs after `npm install -g`. Adds the Pocket Dev Admin launcher to the Dock, Start menu or applications menu. It does
// nothing for npx, a local install or CI, and it never fails an install: every error is swallowed and the exit code is 0.
try {
  const { postinstallPin } = await import('../src/setup/taskbar-pin.js');
  const line = postinstallPin(process.env);
  if (line) console.log(line);
} catch {}
process.exit(0);
