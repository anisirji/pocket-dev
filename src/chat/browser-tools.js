import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findBin } from './env.js';

export const BROWSER_MCP_NAME = 'pocket_dev_browser';
export const BROWSER_TOOLS = Object.freeze(['browser_navigate', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_drag', 'browser_wait_for', 'browser_tabs', 'browser_handle_dialog', 'browser_console_messages', 'browser_network_requests', 'browser_navigate_back', 'browser_resize', 'browser_take_screenshot', 'browser_evaluate', 'browser_close']);
const require = createRequire(import.meta.url);
export function browserExecutable({ platform = process.platform, env = process.env, exists = fs.existsSync, find = findBin } = {}) {
  if (env.POCKET_DEV_BROWSER_EXECUTABLE) return exists(env.POCKET_DEV_BROWSER_EXECUTABLE) ? env.POCKET_DEV_BROWSER_EXECUTABLE : null;
  const candidates = platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : platform === 'win32' ? [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean).flatMap((root) => [path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map((name) => find(name)).filter(Boolean);
  return candidates.find(exists) || null;
}
export function browserAutomationStatus({ resolvePackage = () => require.resolve('@playwright/mcp/package.json'), exists = fs.existsSync, executable = browserExecutable() } = {}) {
  let cli;
  try { cli = path.join(path.dirname(resolvePackage()), 'cli.js'); } catch {}
  if (!cli || !exists(cli)) return { state: 'setup-required', available: false, message: 'Install Pocket Dev with optional dependencies enabled to add the Playwright browser tools.' };
  if (!executable || !exists(executable)) return { state: 'setup-required', available: false, message: 'Install Chrome, Edge or Chromium on this computer, then check again.' };
  return { state: 'ready', available: true, message: 'Separate browser sessions are available for personal Codex chats. Choose Browser in the chat settings to enable one.' };
}
export function browserMcpConfig(chat, { executable = browserExecutable(), headless = process.env.POCKET_DEV_BROWSER_HEADLESS === '1' } = {}) {
  const status = browserAutomationStatus({ executable });
  if (!status.available || !executable) throw Object.assign(new Error(status.message), { code: 'SETUP_REQUIRED', recoverable: true, action: 'open-setup', feature: 'browser' });
  const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
  const outputDir = path.join(chat.imageDir, 'browser'); fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  return { command: process.execPath, cwd: chat.cwd, args: [cli, '--isolated', '--executable-path', executable, '--idle-timeout', '60000', '--output-dir', outputDir, ...(headless ? ['--headless'] : [])], env_vars: [], enabled_tools: [...BROWSER_TOOLS], enabled: true, startup_timeout_sec: 30 };
}
