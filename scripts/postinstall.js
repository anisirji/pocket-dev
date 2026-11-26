// Runs after `npm install -g`: adds the Admin launcher and prepares camera support. Local installs,
// npx and CI skip both. Each optional step is isolated so neither can fail Pocket Dev's install.
try {
  const { postinstallPin } = await import('../src/setup/taskbar-pin.js');
  const line = postinstallPin(process.env);
  if (line) console.log(line);
} catch {}
try {
  const { postinstallCamera } = await import('../src/setup/camera-support.js');
  await postinstallCamera(process.env);
} catch {}
process.exit(0);
