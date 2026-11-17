import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// A desktop notification on the computer Pocket Dev runs on, through the system's own mechanism. Never a dialog: a
// dialog would block until someone clicked it. Every failure is silent, because a missing notification must never
// affect the server. Everything outside is a parameter so tests never show anything on a real screen.

export const NOTIFY_TITLE = 'Pocket Dev';

// osascript receives the text as arguments, not inside the script, so no text can change what the script does.
export function macCommand({ title, message }) {
  return {
    cmd: 'osascript',
    args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message],
  };
}

// The toast API that ships with Windows (no module to install). The text goes in through environment variables.
export function windowsCommand({ title, message }) {
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$text = $xml.GetElementsByTagName("text")',
    '$text.Item(0).AppendChild($xml.CreateTextNode($env:PD_NOTIFY_TITLE)) | Out-Null',
    '$text.Item(1).AppendChild($xml.CreateTextNode($env:PD_NOTIFY_MESSAGE)) | Out-Null',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Pocket Dev").Show($toast)',
  ].join('; ');
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], env: { PD_NOTIFY_TITLE: title, PD_NOTIFY_MESSAGE: message } };
}

export function linuxCommand({ title, message }) {
  return { cmd: 'notify-send', args: ['--app-name=Pocket Dev', title, message] };
}

function realRun({ cmd, args, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', env: { ...process.env, ...env }, windowsHide: true });
    } catch { return resolve(false); }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 8000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

// `notify({ message, title })` resolves true when the system took it and false otherwise. It never rejects.
export function createNotifier({
  platform = process.platform, env = process.env, run = realRun,
  hasProgram = (name) => (env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, name))),
} = {}) {
  // Test seams: a record file captures what would have been shown; the other two switches show nothing at all.
  // NODE_TEST_CONTEXT is set for everything `node --test` starts, a server a test starts included.
  async function notify({ message, title = NOTIFY_TITLE }) {
    try {
      if (env.POCKET_DEV_NOTIFY_RECORD) {
        fs.appendFileSync(env.POCKET_DEV_NOTIFY_RECORD, JSON.stringify({ title, message }) + '\n');
        return true;
      }
      if (env.POCKET_DEV_NO_DESKTOP_NOTIFY || env.NODE_TEST_CONTEXT) return false;
      const build = platform === 'darwin' ? macCommand : platform === 'win32' ? windowsCommand : platform === 'linux' ? linuxCommand : null;
      if (!build) return false;
      const command = build({ title, message });
      if (platform === 'linux' && !hasProgram(command.cmd)) return false;
      return Boolean(await run(command));
    } catch { return false; }
  }
  return { notify };
}

// The scheduled reminder. `tick()` is called after every look at the registry (and once at start). It speaks when a
// newer version is pending, at most once every six hours, and goes quiet the moment this copy is current or the person
// turned the check or the notification off.
export const REMIND_EVERY_MS = 6 * 60 * 60_000;

export function createUpdateReminder({ versionCheck, notifier, config = null, env = process.env, now = Date.now, everyMs = REMIND_EVERY_MS } = {}) {
  let lastAt = null;
  const wanted = () => {
    const v = env.POCKET_DEV_NO_UPDATE_CHECK;
    if (v && v !== '0' && v.toLowerCase() !== 'false') return false;
    const saved = config?.read?.() ?? {};
    return saved.updateCheck !== false && saved.updateNotify !== false;
  };
  async function tick() {
    if (!wanted()) { lastAt = null; return false; }
    const view = versionCheck.view();
    if (!view?.available) { lastAt = null; return false; }
    if (lastAt !== null && now() - lastAt < everyMs) return false;
    lastAt = now();
    await notifier.notify({ message: `Pocket Dev ${view.latest} is available. Open Pocket Dev Admin and tap Update.` });
    return true;
  }
  return { tick };
}
