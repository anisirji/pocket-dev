#!/usr/bin/env node
// Capture the shipping UI against disposable servers. Never reads owner conversations or camera/desktop pixels.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, until, pause, HOSTNAME, TOKEN } from '../test/helpers/server.mjs';
import { seedProject } from './capture-stack.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
if(process.argv.includes('--help')){console.log('node tools/capture-v3-media.mjs [--only=workspace,developer-tools]');process.exit(0);}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'docs/media/v3');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-v3-media-'));
const cleanups = [], t = { after: (f) => cleanups.push(f) }, evidence = [];
const wanted = new Set((process.argv.find(a => a.startsWith('--only='))?.slice(7) || '').split(',').filter(Boolean));
const want = id => !wanted.size || wanted.has(id);
let browser;
const write = (name, body) => { const p = path.join(scratch, name); fs.writeFileSync(p, body, { mode: 0o700 }); return p; };
const inputRecord = path.join(scratch, 'inert-inputs.jsonl');
const input = write('inert-input', `#!/usr/bin/env node
const fs=require('node:fs');const ready=()=>console.log(JSON.stringify({state:'ready',code:'READY',message:'Documentation demo adapter'}));ready();if(!process.argv.includes('--check'))require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.event)fs.appendFileSync(process.env.POCKET_DEV_INPUT_RECORD,JSON.stringify(r.event)+'\\n');console.log(JSON.stringify({id:r.id,state:'ready'}));});
`);
const displays = write('inert-displays', `#!/usr/bin/env node
console.log(process.argv.some(v=>v.includes('NSScreen.screens'))?JSON.stringify([{index:1,id:123,name:'Demo display',width:1280,height:800}]):'[]');
`);
const shell = write('demo-shell', '#!/bin/sh\nexport PS1="demo-app \\$ "\nexec /bin/bash --noprofile --norc\n');
const hostRecord = path.join(scratch, 'camera-host-url');
const fake = write('demo-agent.mjs', fs.readFileSync(path.join(repo, 'test/helpers/fake-claude.mjs'),'utf8').replaceAll("model: 'fake'","model: 'demo'").replace('Done. The app now has a dark mode toggle and all 12 tests still pass. Want me to remember the choice between visits?', 'Demo response: the proposed theme toggle is shown above. Review the changes before applying them.').replace('Tests: 12 passed','Scripted demo command output')); 
const manifestFile = path.join(out, 'capture-manifest.json');
let manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile)) : { version: '3.0.0', assets: [] };
async function cleanPage(page, servers) {
  const replacements = servers.flatMap(s => [[fs.realpathSync(s.home), '~/demo'], [s.home, '~/demo'], [fs.realpathSync(s.root), '/tmp/pocket-demo'], [s.root, '/tmp/pocket-demo']]).sort((a,b)=>b[0].length-a[0].length);
  replacements.push([os.hostname(), 'Demo Mac'], [os.homedir(), '~']);
  await page.addInitScript((pairs) => {
    localStorage.setItem('pd-welcome-shown', '1');
    const scrub = () => {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let n; while ((n = walker.nextNode())) { let next = n.nodeValue; for (const [a,b] of pairs) next = next.split(a).join(b); next=next.replace(/pocket-dev-internet-[A-Za-z0-9_-]+\/home/g,'demo/project'); if (next !== n.nodeValue) n.nodeValue = next; }
      for (const e of document.querySelectorAll('input,textarea')) if (!['password','hidden'].includes(e.type)) { let next=e.value; for (const [a,b] of pairs) next=next.split(a).join(b); if (next!==e.value && document.activeElement!==e) e.value=next; }
    };
    document.addEventListener('DOMContentLoaded', () => { scrub(); new MutationObserver(scrub).observe(document.body, { childList:true, subtree:true, characterData:true }); });
  }, replacements);
}
async function pageFor(server, { width = 1280, height = 800, workspace = false } = {}, servers = [server]) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark', permissions: ['microphone'] });
  const login = await server.login(); const eq=login.cookie.indexOf('=');
  await context.addCookies([{ name:login.cookie.slice(0,eq),value:login.cookie.slice(eq+1),url:server.base }]);
  const page=await context.newPage(); await cleanPage(page,servers);
  if (workspace) await page.addInitScript(root => localStorage.setItem('pd.workspace', JSON.stringify({root})), server.demo);
  await page.goto(server.base + (workspace ? '/workspace.html' : '/'));
  page.setDefaultTimeout(12000);
  return {page,context,cookie:login.cookie};
}
async function frame(page, id, index) {
  await page.evaluate(() => document.fonts.ready); await pause(350);
  for (const child of page.frames()) {
    const found = await child.evaluate(() => ({ text:document.body?.innerText||'', loginQr:[...document.querySelectorAll('[aria-label="One-time Pocket Dev login QR"]')].some(n=>n.getClientRects().length&&n.querySelector('svg')), fields:[...document.querySelectorAll('input,textarea')].filter(e=>e.type!=='password').map(e=>e.value).join('\n') })).catch(()=>({text:'',fields:''}));
    const hay=found.text+'\n'+found.fields;
    assert.ok(!hay.includes(os.homedir()),'owner path excluded');
    assert.ok(!/\b(?:ghp_|github_pat_|sk-ant-|sk-proj-)[A-Za-z0-9_-]+/.test(hay),'credentials excluded');
    assert.ok(!/[?&](?:k|h|token)=[a-f0-9]{32,}/i.test(hay),'connection credentials excluded');
    assert.ok(!found.loginQr,'never capture a usable login QR');
  }
  const file=path.join(scratch,`${id}-${index}.png`);await page.screenshot({path:file});return file;
}
function finish(id, frames, checks, note, primary=frames.length-1, extras=[]) {
  const png=path.join(out,id+'.png');fs.copyFileSync(frames[primary],png);
  const concat=path.join(scratch,id+'.txt');fs.writeFileSync(concat,frames.map(f=>`file '${f.replaceAll("'","'\\''")}'\nduration 1.1`).join('\n')+`\nfile '${frames.at(-1)}'\n`);
  const gif=path.join(out,id+'.gif');
  execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',concat,'-filter_complex','fps=5,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3','-loop','0',gif],{stdio:'pipe'});
  const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const asset={id,version:'3.0.0',source:'Actual Pocket Dev UI on disposable local servers',data:'Sanitized sample project and scripted provider responses; no owner files or conversations',note,checks,files:[png,gif,...extras].map(p=>({path:path.relative(repo,p),bytes:fs.statSync(p).size,sha256:hash(p)})),manualStability:'pending'};
  manifest.assets=manifest.assets.filter(a=>a.id!==id).concat(asset);manifest.assets.sort((a,b)=>a.id.localeCompare(b.id));fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
  console.log('CAPTURED '+id+' '+asset.files.map(f=>Math.round(f.bytes/1024)+' KB').join(' / '));
}
async function settings(page, key) { await page.locator('#settingsBtn').click(); await page.locator(`[data-category="${key}"]`).click(); }
try {
  fs.mkdirSync(out,{recursive:true});
  const a=await startServer(t,{ network:{wifi:true,internet:{kind:'off'}},token:TOKEN,env:{POCKET_DEV_CLAUDE:fake,POCKET_DEV_ROOM_PING_MS:'200',POCKET_DEV_OSASCRIPT:displays,POCKET_DEV_INPUT_PYTHON:input,POCKET_DEV_INPUT_RECORD:inputRecord,POCKET_DEV_CAMERA_HOST_RECORD:hostRecord,SHELL:shell,BASH_SILENCE_DEPRECATION_WARNING:'1'} });
  a.demo=path.join(a.home,'projects','demo-app');seedProject(a,a.demo);
  await a.local('POST','/api/permissions/setup',{status:'skipped'});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--mute-audio']});
  const cookie=(await a.login()).cookie;const call=(method,url,body)=>a.request(method,url,{cookie,body});
  let chat;
  if(want('ai-chat')||want('ai-sharing')||want('notifications')||want('workspace')||want('developer-tools')) {
    chat=(await call('POST','/api/chat',{tool:'claude',cwd:a.demo,title:'Demo: review the theme toggle'})).data;
    assert.ok(chat.id);assert.equal((await call('POST',`/api/chat/${chat.id}/message`,{text:'Add a dark mode toggle to the demo app'})).status,202);
    await until(async()=> (await call('GET',`/api/chat/${chat.id}`)).data.events.some(e=>JSON.stringify(e).includes('Demo response:')),20000);
  }
  if(want('ai-chat')) {
    const {page,context}=await pageFor(a);await page.goto(a.base+'/#chat='+chat.id);await page.locator('.chat-assistant').first().waitFor();
    const frames=[await frame(page,'ai-chat',0)];await page.locator('.chat-menu').click();await page.getByRole('button',{name:'Continue on computer',exact:true}).waitFor();frames.push(await frame(page,'ai-chat',1));
    assert.equal(await page.getByRole('button',{name:'Continue on computer',exact:true}).isEnabled(),true);
    await page.goBack();await page.setViewportSize({width:390,height:844});const mobile=path.join(out,'ai-chat-mobile.png');fs.copyFileSync(await frame(page,'ai-chat-mobile',0),mobile);
    finish('ai-chat',frames,['Scripted agent response rendered in the real conversation UI','Existing Continue on computer action available after a session starts'],'AI output is scripted sample data. Native provider handoff is not executed by this capture.',0,[mobile]);await context.close();
  }
  if(want('workspace')||want('developer-tools')) {
    const {page,context}=await pageFor(a,{workspace:true});await page.getByRole('button',{name:'Folder src',exact:true}).click();await page.getByRole('button',{name:'File App.jsx',exact:true}).click();await page.locator('.cm-content').waitFor();
    
    const frames=[await frame(page,'workspace',0)];await page.locator('.cm-content').click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('// Reviewed in Pocket Dev\n');await page.getByRole('button',{name:'Save',exact:true}).click();await until(()=>fs.readFileSync(path.join(a.demo,'src/App.jsx'),'utf8').includes('Reviewed in Pocket Dev'));frames.push(await frame(page,'workspace',1));
    await page.getByRole('button',{name:'New project terminal',exact:false}).click();const tools=page.frameLocator('#toolsFrame');await tools.locator('.term.active').filter({hasText:'demo-app $'}).waitFor();await tools.locator('#cmd').fill('printf "Demo project ready\\n"; git status --short');await tools.locator('#send').click();await tools.locator('.term.active').filter({hasText:'Demo project ready'}).waitFor();frames.push(await frame(page,'workspace',2));
    await page.locator('#activityGit').click();await tools.locator('.g-graph').waitFor();frames.push(await frame(page,'workspace',3));
    await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Editor',exact:true}).click();const mobile=path.join(out,'workspace-mobile.png');fs.copyFileSync(await frame(page,'workspace-mobile',0),mobile);await page.setViewportSize({width:1280,height:800});
    if(want('workspace'))finish('workspace',frames,['Real scratch Git repository','Editor save verified on disk','Project terminal output received','Existing Git Graph opened'],'Only generated demo project files, scripted conversation and disposable terminals are shown.',2,[mobile]);
    if(want('developer-tools'))finish('developer-tools',frames.slice(2),['PTY output received from the demo project','Git status and graph use a real scratch repository'],'Developer tools shown with disposable project files and terminals.',1);
    await context.close();
  }
  if(want('ai-sharing')) {
    const b=await startServer(t,{env:{POCKET_DEV_CLAUDE:fake,POCKET_DEV_ROOM_PING_MS:'200'}});b.demo=b.home;
    const bCookie=(await b.login()).cookie;const bc=(method,url,body)=>b.request(method,url,{cookie:bCookie,body});
    const aId=(await call('GET','/api/room')).data.deviceId;const bId=(await bc('GET','/api/room')).data.deviceId;
    const invite=(await call('POST','/api/connections/invite',{connectionType:'external'})).data;
    assert.equal((await bc('POST','/api/connections/join',{host:a.base,code:invite.code,name:'Demo workspace',addresses:[b.base]})).status,200);
    await call('PATCH',`/api/connections/${bId}`,{ai:['claude']});await call('PATCH','/api/connections/providers/claude',{enabled:true});
    await until(async()=> (await bc('GET','/api/connections')).data.computers.some(c=>c.deviceId===aId),15000);
    const remote=(await bc('POST','/api/chat',{tool:`claude@${aId}`,cwd:b.home,title:'Demo: authorized AI source'})).data;assert.ok(remote.id);
    const {page,context}=await pageFor(b,{},[a,b]);await settings(page,'computers');await page.locator('.cc-computer').first().waitFor();const frames=[await frame(page,'ai-sharing',0)];await page.locator('.st-close').click();await page.goto(b.base+'/#chat='+remote.id);await page.locator('.chat-provider-chip').waitFor();await page.locator('.chat-provider-chip').click();await page.locator('.chat-switch-item').first().waitFor();frames.push(await frame(page,'ai-sharing',1));
    assert.equal((await bc('GET',`/m/${aId}/api/performance`)).status,403);finish('ai-sharing',frames,['Two isolated servers paired through the real connection APIs','Provider grant applied and shared provider selected','AI-only grant refused computer performance access'],'Both demo computers run on this Mac. This does not represent a physical Windows/Linux connection or transfer subscription entitlement.',0);await context.close();
  }
  if(want('notifications')) {
    const {page,context}=await pageFor(a);await settings(page,'service');const panel=page.locator('.pd-notification-preferences');await panel.waitFor();const frames=[await frame(page,'notifications',0)];
    await panel.getByRole('switch',{name:'Notification sounds',exact:true}).check();await until(()=>page.evaluate(()=>PocketDevNotifications.preferences().sounds));await panel.getByRole('heading',{name:'Notifications',exact:true}).click();
    await page.evaluate(()=>{window.demoSoundCount=0;const create=AudioContext.prototype.createOscillator;AudioContext.prototype.createOscillator=function(...args){window.demoSoundCount++;return create.apply(this,args);};});
    await page.evaluate(async()=>{const n={id:'documentation-demo-complete',category:'aiTasks',title:'Demo task completed',body:'Ready for review',sound:true};await PocketDevNotifications.notify(n);await PocketDevNotifications.notify(n);});
    assert.equal(await page.locator('.pd-alert:visible').count(),1);assert.equal(await page.evaluate(()=>demoSoundCount),1);frames.push(await frame(page,'notifications',1));await page.locator('.pd-alert-close').click();assert.equal(await page.locator('.pd-alert:visible').count(),0);frames.push(await frame(page,'notifications',2));finish('notifications',frames,['Same completion ID delivered twice creates one toast and one sound request','Toast dismissed through its existing Close control'],'Sound synthesis was counted with browser output muted. A GIF cannot demonstrate audible quality; vendor push is not exercised.',1);await context.close();
  }
  if(want('computer-management')) {
    const {page,context}=await pageFor(a);await settings(page,'controls');const frames=[await frame(page,'computer-management',0)];await page.locator('[data-act="health"]').click();await page.locator('.health-group').first().waitFor();frames.push(await frame(page,'computer-management',1));finish('computer-management',frames,['Computer controls and Device health opened','No power or application-management action executed'],'Available readings come from the isolated server; unavailable platform sensors remain unavailable.');await context.close();
  }
  if(want('connectivity')) {
    assert.equal((await a.local('PUT','/api/network',{wifi:true,internet:{kind:'domain',hostname:HOSTNAME}})).status,200);await a.tunnelStatus('connected');const {page,context}=await pageFor(a);await page.goto(a.admin+'/#sharing');await page.locator('#shareQrBtn:enabled').click();const share=page.locator('#shareQr');await share.locator('svg').waitFor();await share.scrollIntoViewIfNeeded();const frames=[await frame(page,'connectivity',0)];await share.getByRole('tab',{name:'Remote connection',exact:true}).click();await share.locator('svg').waitFor();frames.push(await frame(page,'connectivity',1));finish('connectivity',frames,['Local and Remote selector rendered with Local as default','Only share-address codes captured; no login code minted'],'Remote connectivity uses a local tunnel fixture and reserved example hostname, not a real public tunnel.');await context.close();await a.local('PUT','/api/network',{internet:{kind:'off'}});
  }
  if(want('setup')) {
    const server=await startServer(t);const context=await browser.newContext({viewport:{width:1280,height:800}});const page=await context.newPage();await cleanPage(page,[server]);await page.goto(server.admin);await page.locator('#setup').waitFor({state:'visible'});const frames=[await frame(page,'setup',0)];await page.locator('#setup').getByRole('button',{name:'Continue',exact:true}).click();await page.getByText('Tools on this computer',{exact:true}).waitFor();frames.push(await frame(page,'setup',1));await page.locator('#setup').getByRole('button',{name:'Pause setup',exact:true}).click();await page.evaluate(()=>PocketGuides.open('setup'));await page.locator('dialog.pd-guide').waitFor();frames.push(await frame(page,'setup',2));finish('setup',frames,['Graphical setup welcome and tool inspection opened without installing tools','Existing contextual Help dialog opened'],'No installer, permission dialog, password change or login QR was invoked.',1);await context.close();
  }
  if(want('screen')) {
    const {page,context}=await pageFor(a);await page.waitForFunction(()=>typeof openScreenSheet==='function');
    const desktop=fs.existsSync(path.join(out,'workspace.png'))?fs.readFileSync(path.join(out,'workspace.png')):null;assert.ok(desktop,'capture Workspace first');await page.route('**/api/screen?**',r=>r.fulfill({body:desktop,contentType:'image/png'}));await page.evaluate(()=>openScreenSheet());const screen=page.locator('.screen-sheet');await screen.locator('img').waitFor();const frames=[await frame(page,'screen',0)];await screen.getByRole('button',{name:'Control',exact:true}).click();const admin=await context.newPage();await admin.goto(a.admin);await admin.getByRole('button',{name:'Allow and remember',exact:true}).click();await screen.getByRole('button',{name:'Stop control',exact:true}).waitFor();await screen.locator('img').click({position:{x:100,y:60}});await until(()=>fs.existsSync(inputRecord));frames.push(await frame(page,'screen',1));await admin.getByRole('button',{name:'Stop and revoke',exact:true}).click();await screen.getByRole('button',{name:'Control',exact:true}).waitFor();finish('screen',frames,['Control request approved through local Admin','Input received by an inert adapter only','Admin Stop revoked control'],'Desktop picture is a previously captured demo Workspace; native capture and OS input are simulated to protect the owner desktop.');await context.close();
  }
  if(want('camera-audio')) {
    const generated=()=>{const Native=RTCPeerConnection;window.demoPeers=[];window.RTCPeerConnection=class extends Native{constructor(...args){super(...args);demoPeers.push(this);}};navigator.mediaDevices.getUserMedia=async c=>{const tracks=[];if(c.video){const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const draw=()=>{const x=canvas.getContext('2d');x.fillStyle='#172b3c';x.fillRect(0,0,640,360);x.fillStyle='#b9e8d9';x.font='24px system-ui';x.fillText('DEMO VIDEO SOURCE',40,70);x.fillStyle='#dfebf2';x.font='18px system-ui';x.fillText('Generated locally. No physical camera.',40,106);x.fillStyle='#62bfa5';x.fillRect(40+(Date.now()/40%360),180,100,90);};draw();const timer=setInterval(draw,80);const tr=canvas.captureStream(12).getVideoTracks()[0],stop=tr.stop.bind(tr);tr.stop=()=>{clearInterval(timer);stop();};tracks.push(tr);}if(c.audio){const a=new AudioContext(),o=a.createOscillator(),d=a.createMediaStreamDestination();o.connect(d);o.start();await a.resume();const tr=d.stream.getAudioTracks()[0],stop=tr.stop.bind(tr);tr.stop=()=>{if(tr.readyState==='ended')return;stop();o.stop();a.close();};tracks.push(tr);}return new MediaStream(tracks);};};
    const {page,context}=await pageFor(a);await context.addInitScript(generated);await page.reload();await page.waitForFunction(()=>typeof openCameraSheet==='function');await page.evaluate(()=>openCameraSheet());await page.getByRole('button',{name:'Start camera',exact:true}).click();await until(()=>fs.existsSync(hostRecord));const hc=await browser.newContext({permissions:['microphone','camera']});await hc.addInitScript(generated);const host=await hc.newPage();await host.goto(fs.readFileSync(hostRecord,'utf8'));await page.waitForFunction(()=>!document.querySelector('.camera-audio-controls button[aria-pressed]').disabled);await host.locator('#state').click();const frames=[await frame(page,'camera-audio',0)];await page.getByLabel('Listen',{exact:true}).check();await page.waitForFunction(()=>!document.querySelector('.camera-audio-controls button[aria-pressed]').disabled);const talk=page.getByRole('button',{name:'Hold to speak',exact:true});const box=await talk.boundingBox();await page.mouse.move(box.x+8,box.y+8);await page.mouse.down();await until(()=>host.evaluate(async()=>{for(const p of demoPeers)for(const s of (await p.getStats()).values())if(s.type==='inbound-rtp'&&s.kind==='audio'&&s.bytesReceived>0)return true;return false;}),15000);frames.push(await frame(page,'camera-audio',1));await page.mouse.up();assert.equal(await talk.getAttribute('aria-pressed'),'false');await host.getByRole('button',{name:'Stop camera & audio',exact:true}).click();finish('camera-audio',frames,['Generated video transported through the actual WebRTC pipeline','Listen enabled independently','Push-to-talk RTP received and release cleared speaking state','Host Stop ended the session'],'Generated video and audio only. A GIF has no sound; physical media permissions, audible quality and network performance require manual validation.');await hc.close();await context.close();
  }
  assert.ok(wanted.size ? [...wanted].every(id=>manifest.assets.some(a=>a.id===id)) : manifest.assets.length===10);
  console.log('PASS media capture: isolated UI, privacy checks and per-feature assertions');
} finally { await browser?.close();for(const f of cleanups.reverse())await f();fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
