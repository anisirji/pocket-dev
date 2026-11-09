#!/usr/bin/env node
// Not packaged. Writes the HTML sources in docs/install-guide/src/ and renders each one to docs/install-guide/NAME.png
// with headless Chrome (2x). Every mock-up carries an "illustration" label. Run: node tools/build-install-guide-images.mjs [name...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'install-guide');
const srcDir = path.join(outDir, 'src');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(srcDir, { recursive: true });

const css = `
*{box-sizing:border-box;margin:0}
body{background:#0f1419;color:#e6edf3;font:16px/1.4 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;position:relative;overflow:hidden}
.badge{position:absolute;top:12px;right:14px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9aa7b4;border:1px solid #3a4654;border-radius:5px;padding:3px 8px;background:#161d25;z-index:20}
.cap{position:absolute;left:0;right:0;bottom:0;padding:14px 24px;background:#161d25;border-top:1px solid #2a3440;font-size:19px;font-weight:600;color:#fff;z-index:20}
.cap b{color:#ff6b6b}
.n{position:absolute;width:34px;height:34px;border-radius:50%;background:#e5322d;color:#fff;font-weight:800;font-size:19px;display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 2px 8px #0008;z-index:15}
.ring{position:absolute;border:4px solid #e5322d;border-radius:10px;z-index:14}
.win{position:absolute;background:#0c0f13;border:1px solid #33404d;border-radius:10px;overflow:hidden;box-shadow:0 10px 30px #0008}
.bar{height:36px;background:#1d2630;display:flex;align-items:center;padding:0 14px;gap:8px;font-size:13px;color:#a9b6c3}
.dot{width:12px;height:12px;border-radius:50%;background:#ff5f57}.dot.y{background:#febc2e}.dot.g{background:#28c840}
pre.t{font:16px/1.5 Menlo,Consolas,"DejaVu Sans Mono",monospace;color:#d6dde5;padding:16px 18px;white-space:pre-wrap}
.hl{background:#5a4a00;color:#ffe27a;border-radius:4px;padding:1px 4px}
.red{color:#ff6b6b}.grn{color:#5fd38d}.dim{color:#8693a0}.cur{background:#d6dde5;color:#000}
kbd{background:#2a3440;border:1px solid #455364;border-bottom-width:3px;border-radius:6px;padding:2px 9px;font:700 16px Menlo,monospace;color:#fff}
.btn{display:inline-block;border-radius:8px;padding:12px 22px;font-weight:700}
.phone{position:absolute;width:300px;border:10px solid #2a323b;border-radius:38px;background:#000;overflow:hidden;box-shadow:0 10px 30px #0008}
.side{position:absolute;font-size:20px;line-height:1.6}
`;

const page = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8"><title>install guide illustration</title><style>${css}</style></head>
<body style="width:${w}px;height:${h}px">${body}</body></html>`;
const n = (x, y, num) => `<div class="n" style="left:${x}px;top:${y}px">${num}</div>`;
const ring = (x, y, w, h) => `<div class="ring" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`;
const frame = (inner, caption, label = 'Illustration') => `<div class="badge">${label}</div>${inner}<div class="cap">${caption}</div>`;
const term = (x, y, w, h, title, text, style = 'win') => `<div class="win" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">
<div class="bar">${style === 'mac' ? '<span class="dot"></span><span class="dot y"></span><span class="dot g"></span>' : ''}<span style="${style === 'mac' ? 'margin-left:auto;margin-right:auto' : ''}">${title}</span></div><pre class="t">${text}</pre></div>`;

// ring around characters c0..c1 of line `line` inside a term() placed at (x, y)
const tl = (x, y, line, c0, c1) => ring(x + 18 + c0 * 9.6 - 6, y + 52 + 24 * line - 4, (c1 - c0) * 9.6 + 12, 32);
const qr = (() => {
  let seed = 7; let cells = '';
  const N = 13;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const finder = (r < 4 && c < 4) || (r < 4 && c >= N - 4) || (r >= N - 4 && c < 4);
    if (finder ? (r % 3 === 0 || c % 3 === 0) : (seed >> 8) % 2) cells += `<rect x="${c * 10}" y="${r * 10}" width="10" height="10"/>`;
  }
  return `<svg width="150" height="150" viewBox="-10 -10 150 150" style="display:block;margin:6px 0;background:#fff"><g fill="#000">${cells}</g></svg>`;
})();

const scenes = {};

scenes['open-powershell'] = [1000, 600, frame(`
<div style="position:absolute;left:150px;top:30px;width:700px;height:490px;background:#202a36;border:1px solid #3a4a5c;border-radius:12px;box-shadow:0 10px 30px #0008">
 <div style="margin:22px;background:#2f3b4a;border:2px solid #5aa9ff;border-radius:22px;padding:12px 20px;font-size:20px;color:#fff">Search: PowerShell<span class="cur">&nbsp;</span></div>
 <div style="margin:0 22px;color:#9fb0c2;font-size:14px">Best match</div>
 <div style="margin:8px 22px;background:#3b4b5f;border-radius:8px;padding:16px;display:flex;gap:16px;align-items:center">
  <div style="width:48px;height:48px;background:#1b4fa3;border-radius:8px;color:#fff;font:700 22px Consolas,monospace;display:flex;align-items:center;justify-content:center">&gt;_</div>
  <div><div style="font-size:20px;font-weight:700;color:#fff">Windows PowerShell</div><div style="color:#9fb0c2;font-size:14px">App</div></div></div>
 <div style="margin:18px 22px 0;color:#9fb0c2;font-size:14px">Other results</div>
 <div style="margin:8px 22px;color:#c7d3df;font-size:16px;line-height:2.2">Windows PowerShell ISE<br>Windows PowerShell (x86)</div>
 <div style="position:absolute;left:0;right:0;bottom:0;height:52px;background:#18212b;border-radius:0 0 12px 12px;display:flex;align-items:center;justify-content:center;gap:12px;color:#9fb0c2">Windows key is the key between Ctrl and Alt</div>
</div>
${ring(168, 46, 664, 68)}${ring(168, 150, 664, 90)}
${n(115, 62, 1)}${n(115, 178, 2)}
<div style="position:absolute;left:870px;top:215px;width:110px;text-align:center"><kbd>Enter</kbd><div style="margin-top:8px;font-size:14px;color:#c7d3df">3. press it</div></div>`,
'<b>1</b> Press the Windows key and type <b>PowerShell</b>. <b>2</b> Pick <b>Windows PowerShell</b> (not "as administrator"). <b>3</b> Press Enter.')];

scenes['open-terminal-mac'] = [1000, 520, frame(`
<div style="position:absolute;left:180px;top:50px;width:640px;background:#2b2f36;border:1px solid #4a515c;border-radius:16px;box-shadow:0 10px 30px #0008;padding:18px 22px">
 <div style="font-size:30px;color:#fff">Search: Terminal<span class="cur">&nbsp;</span></div>
 <hr style="border:0;border-top:1px solid #444b55;margin:16px 0">
 <div style="background:#3a74e0;border-radius:8px;padding:12px 14px;display:flex;align-items:center;gap:14px;color:#fff;font-size:20px;font-weight:600">
  <div style="width:42px;height:42px;background:#111;border:2px solid #888;border-radius:8px;font:700 18px Menlo,monospace;display:flex;align-items:center;justify-content:center">&gt;_</div> Terminal <span style="margin-left:auto;font-size:14px;font-weight:400">Application</span></div>
</div>
${ring(176, 44, 648, 76)}${ring(176, 148, 648, 70)}
${n(130, 62, 1)}${n(130, 166, 2)}
<div style="position:absolute;left:180px;top:300px;font-size:20px;color:#e6edf3"><kbd>Cmd</kbd> + <kbd>Space</kbd> opens the search box. Type, then press <kbd>Enter</kbd>.</div>`,
'<b>1</b> Press Cmd + Space and type <b>Terminal</b>. <b>2</b> Press Enter when Terminal is highlighted.')];

scenes['open-terminal-linux'] = [1000, 520, frame(`
<div style="position:absolute;left:40px;top:80px;width:340px;text-align:center"><div style="font-size:18px;color:#c7d3df;margin-bottom:14px">Press these three keys together</div><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd>
<div style="margin-top:18px;font-size:15px;color:#9fb0c2">No luck? Open the apps menu and search for <b>Terminal</b>.</div></div>
${term(420, 50, 540, 360, 'user@computer: ~', '<span class="grn">user@computer</span>:<span style="color:#6cb6ff">~</span>$ <span class="cur">&nbsp;</span>\n\n<span class="dim">A window with a blinking cursor.\nType here.</span>', 'linux')}
${ring(410, 40, 560, 380)}
${n(375, 20, 2)}${n(5, 90, 1)}`,
'<b>1</b> Press Ctrl + Alt + T. <b>2</b> A window with a blinking cursor opens. It is safe: nothing happens until you press Enter.')];

scenes['nodejs-download'] = [1000, 640, frame(`
<div class="win" style="left:60px;top:40px;width:880px;height:500px;background:#fff">
 <div class="bar" style="background:#e7ebf0;color:#333"><span class="dot"></span><span class="dot y"></span><span class="dot g"></span>
  <span style="margin-left:14px;background:#fff;border-radius:14px;padding:4px 18px;width:420px;color:#222;font-size:14px">nodejs.org</span></div>
 <div style="padding:34px 60px;color:#222;text-align:center;font-family:Arial,sans-serif">
  <div style="font-size:34px;font-weight:700;color:#1b1f23">Run JavaScript Everywhere</div>
  <div style="margin-top:10px;color:#555;font-size:17px">Download the program that Pocket Dev needs.</div>
  <div style="margin-top:46px"><span class="btn" style="background:#3c873a;color:#fff;font-size:24px;padding:20px 40px">Download Node.js (LTS)</span></div>
  <div style="margin-top:24px;color:#555;font-size:15px">LTS = the safe, recommended version. It should say 22 or higher.</div>
  <div style="margin-top:44px;color:#777;font-size:15px">Other buttons, such as "Current" or "Docs": ignore them.</div>
 </div></div>
${ring(246, 226, 508, 96)}${n(205, 226, 1)}
<div style="position:absolute;left:60px;top:560px;font-size:15px;color:#9fb0c2">Simplified drawing, not the real page. The real site looks a bit different. Look for the big green LTS button.</div>`,
'<b>1</b> Open nodejs.org and click the big green <b>LTS</b> button. A file downloads.')];

scenes['paste-in-powershell'] = [1000, 520, frame(`
${term(60, 40, 600, 330, 'Windows PowerShell', 'PS C:\\Users\\you&gt; <span class="hl">npm install -g @anisirji/pocket-dev</span><span class="cur">&nbsp;</span>\n\n<span class="dim">The command appeared after the paste.\nNow press Enter.</span>')}
<div style="position:absolute;left:700px;top:120px;width:260px;background:#f2f4f7;color:#111;border-radius:8px;box-shadow:0 8px 24px #0009;padding:8px 0;font-size:16px">
 <div style="padding:8px 18px;color:#999">Copy</div><div style="padding:8px 18px;background:#bcd7ff;font-weight:700">Paste</div><div style="padding:8px 18px;color:#999">Select all</div></div>
${ring(698, 162, 266, 46)}${n(658, 168, 1)}${n(645, 90, 2)}
<div style="position:absolute;left:60px;top:400px;font-size:18px;color:#c7d3df">Mac Terminal: <kbd>Cmd</kbd>+<kbd>V</kbd> &nbsp; Linux Terminal: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd></div>`,
'<b>1</b> In PowerShell, <b>right-click</b> inside the window. It pastes what you copied. <b>2</b> Press Enter.')];

scenes['node-version-ok'] = [1000, 400, frame(`
${term(60, 30, 880, 250, 'Terminal', '$ node -v\n<span class="hl">v22.11.0</span>\n$ <span class="cur">&nbsp;</span>', 'mac')}
${tl(60, 30, 0, 2, 10)}${tl(60, 30, 1, 0, 8)}${n(236, 100, 1)}
<div style="position:absolute;left:300px;top:160px;font-size:17px;color:#9fdcb4;width:620px">Good: it starts with <b>v22</b> or a bigger number (v23, v24...). The numbers after it may differ. If it says "not recognized" or "command not found", go to step 3.</div>`,
'<b>1</b> Type <b>node -v</b> and press Enter. You want <b>v22</b> or higher.')];

scenes['install-output'] = [1000, 520, frame(`
${term(60, 30, 880, 380, 'Terminal', '$ <span class="hl">npm install -g @anisirji/pocket-dev</span>\n<span class="dim">npm WARN deprecated some-old-package@1.0.0: no longer supported</span>\n\n<span class="grn">added 134 packages in 41s</span>\n\n<span class="dim">18 packages are looking for funding\n  run `npm fund` for details</span>\n$ <span class="cur">&nbsp;</span>', 'mac')}
${tl(60, 30, 0, 2, 38)}${n(20, 78, 1)}
${tl(60, 30, 1, 0, 66)}${n(760, 104, 3)}
${tl(60, 30, 3, 0, 31)}${n(20, 150, 2)}
${ring(66, 198, 340, 64)}${n(420, 212, 3)}`,
'<b>1</b> Type it exactly, with @ and -g. <b>2</b> "added N packages" means success (N changes). <b>3</b> WARN and "funding" lines are harmless.')];

scenes['start-output'] = [1000, 700, frame(`
${term(60, 30, 880, 580, 'Terminal', `$ <span class="hl">pocket-dev start</span>${qr}Pocket Dev running at <span class="hl">http://192.168.1.20:7777</span>\n<span class="hl">Password: Xk3p9QwR2tLm</span>\nScan the QR code to log in without the password...\nAdmin (this computer only): http://127.0.0.1:7778`, 'mac')}
${tl(60, 30, 0, 2, 19)}${n(20, 78, 1)}
${ring(72, 104, 166, 166)}${n(20, 170, 2)}
${tl(60, 30, 0, 0, 0).replace(/top:[^;]+/, 'top:262px').replace(/left:[^;]+/, 'left:72px').replace(/width:[^;]+/, 'width:470px')}${n(20, 258, 3)}
${ring(72, 286, 250, 32)}${n(332, 288, 4)}
<div style="position:absolute;left:480px;top:150px;font-size:15px;color:#9fb0c2;width:400px">The QR code is a square of dots.<br>The address and password here are made up.</div>`,
'<b>1</b> Run it. <b>2</b> QR code (phone camera). <b>3</b> Address for the phone. <b>4</b> Password: copy it now, it shows only once. Keep this window open.')];

scenes['firewall-prompt'] = [1000, 660, frame(`
<div style="position:absolute;left:200px;top:30px;width:600px;background:#fff;color:#111;border:1px solid #888;box-shadow:0 10px 30px #000a;font-family:'Segoe UI',Arial,sans-serif">
 <div style="padding:10px 14px;border-bottom:1px solid #ddd;font-size:14px">Windows Security Alert</div>
 <div style="padding:16px 22px;font-size:20px;color:#1a4d8f">Windows Defender Firewall has blocked some features of this app</div>
 <div style="padding:6px 22px;font-size:14px;line-height:1.6">Windows Defender Firewall has blocked some features of <b>Node.js JavaScript Runtime</b> on all public and private networks.<br><br>Allow Node.js JavaScript Runtime to communicate on these networks:</div>
 <div style="padding:6px 22px;font-size:14px;line-height:2.2"><span style="display:inline-block;width:16px;height:16px;border:2px solid #333;vertical-align:middle;text-align:center;line-height:12px;font-weight:700;margin-right:8px">&#10003;</span><b>Private networks, such as my home or work network</b><br>
 <span style="display:inline-block;width:16px;height:16px;border:2px solid #333;vertical-align:middle;margin-right:8px"></span>Public networks, such as those in airports and coffee shops (not recommended)</div>
 <div style="padding:16px 22px;text-align:right"><span style="display:inline-block;background:#0067c0;color:#fff;padding:7px 26px;border-radius:4px;font-size:14px;font-weight:700">Allow access</span> <span style="display:inline-block;background:#e5e5e5;padding:7px 26px;border-radius:4px;font-size:14px;margin-left:6px">Cancel</span></div>
</div>
${ring(212, 262, 584, 38)}${n(165, 264, 1)}
${ring(524, 344, 152, 46)}${n(480, 350, 2)}`,
'<b>1</b> Tick <b>Private networks</b>. <b>2</b> Click <b>Allow access</b>. If you click Cancel, the phone cannot connect (see "If something goes wrong").')];

scenes['phone-address-bar'] = [1000, 520, frame(`
<div class="phone" style="left:60px;top:30px;height:400px;background:#fff">
 <div style="height:60px;background:#eceff3;display:flex;align-items:center;padding:0 12px">
  <div style="flex:1;background:#fff;border:3px solid #e5322d;border-radius:20px;padding:8px 12px;font-size:13px;color:#111;white-space:nowrap">http://192.168.1.20:7777</div></div>
 <div style="padding:60px 24px;color:#888;text-align:center;font-size:15px">The Pocket Dev login page opens here.</div></div>
${n(380, 44, 1)}
<div class="side" style="left:440px;top:40px;width:520px;line-height:1.55">
 Type the address from step 5 into the <b>address bar</b> at the top of the phone browser.<br><br>
 <span class="red"><b>Not</b></span> in a Google search box.<br>
 Start with <b>http://</b> (not https).<br>
 Use <b>your</b> address from the computer. It often starts with <b>192.168</b>, <b>10.</b> or <b>172.</b> It never starts with 127.0.0.1.<br><br>
 <span class="dim" style="font-size:15px">192.168.1.20 is a made-up example.</span></div>`,
'<b>1</b> Phone browser address bar: type the address, then press Go.')];

const phoneShot = (file, caption, side, top = 0) => [1000, 440, frame(`
<div class="phone" style="left:60px;top:30px;width:410px;height:330px;border-radius:44px"><img src="../../screenshots/${file}" style="width:100%;height:auto;display:block;margin-top:-${top}px"></div>
<div class="side" style="left:500px;top:40px;width:460px">${side}</div>`, caption, 'Real screenshot in a phone frame')];
scenes['phone-login'] = phoneShot('01-login.png', 'You should see the Pocket Dev login page.',
  '<b style="color:#ff6b6b">Login page.</b> Type the password from step 5 and tap the button. Or scan the QR code from the computer with the phone camera.<br><br>Wrong passwords are counted. After 10 wrong tries in 15 minutes you wait 15 minutes.', 290);
scenes['success'] = phoneShot('02-terminal.png', 'Success: a terminal of your computer, on your phone.',
  '<b style="color:#5fd38d">It works.</b> The phone now shows a terminal that runs on your computer.<br><br>Make it open like an app: Android Chrome, menu (three dots), <b>Add to Home screen</b>. iPhone Safari, Share button, <b>Add to Home Screen</b>.');

scenes['error-red-text'] = [1000, 600, frame(`
${term(60, 30, 880, 340, 'Windows PowerShell', 'PS C:\\Users\\you&gt; npm install -g @anisirji/pocket-dev\n<span class="red">npm error code ENOENT\nnpm error syscall spawn cmd.exe\nnpm error path C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@anisirji\nnpm error enoent spawn cmd.exe ENOENT\nnpm error A complete log of this run can be found in:\nnpm error   C:\\Users\\you\\AppData\\Local\\npm-cache\\_logs\\debug-0.log</span>\nPS C:\\Users\\you&gt;')}
<div style="position:absolute;left:64px;top:74px;width:870px;height:178px;border:4px dashed #ffd24a;border-radius:10px;z-index:14"></div>
${n(20, 150, 1)}
<div style="position:absolute;left:60px;top:395px;font-size:17px;line-height:1.5;color:#c7d3df;width:880px">Red text is not a disaster: it says what went wrong. Drag the mouse over the red lines and the command above them, copy, and send it to whoever helps you.</div>`,
'<b>1</b> Copy the red lines and the command above them. Windows: select, then right-click. Mac: Cmd+C. Linux: Ctrl+Shift+C.')];

const only = process.argv.slice(2);
for (const [name, [w, h, body]] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const html = path.join(srcDir, `${name}.html`);
  const png = path.join(outDir, `${name}.png`);
  fs.writeFileSync(html, page(w, h, body));
  execFileSync(CHROME, ['--headless', '--disable-gpu', `--screenshot=${png}`, `--window-size=${w},${h}`, '--hide-scrollbars', '--force-device-scale-factor=2', `file://${html}`], { stdio: 'ignore' });
  console.log(name, `${w}x${h}`, `${Math.round(fs.statSync(png).size / 1024)} KB`);
}
