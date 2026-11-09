#!/usr/bin/env node
// This file must stay valid on very old Node: it only checks the version, then loads the real command line.
// POCKET_DEV_FAKE_NODE (tests only) pretends to be another Node version.
var version = process.env.POCKET_DEV_FAKE_NODE || process.versions.node;
if (parseInt(String(version).split('.')[0], 10) < 22) {
  console.error('Pocket Dev needs Node 22 or newer, and this computer has Node ' + version + '.');
  console.error('Install the current LTS from https://nodejs.org/en/download (or: nvm install 22), open a new terminal, and run pocket-dev again.');
  console.error('Check with: node -v');
  process.exit(1);
}
import('./cli.js').catch(function (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
