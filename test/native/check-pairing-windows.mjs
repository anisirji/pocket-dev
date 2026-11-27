// Native Windows/Edge QR pairing against two disposable servers. No owner state or media capture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isolatedEnv } from '../isolated-env.mjs';
assert.equal(process.platform, 'win32');
const [pkg, resultFile] = process.argv.slice(2);
assert.ok(pkg && resultFile);
const require = createRequire(path.join(pkg, 'package.json')), WebSocket = require('ws');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-pairing-native-'));
const report = { platform: process.platform, node: process.version, checks: [], screens: [], error: null };
const servers = [], logs = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
let edge, profile, socket, diagnose;
async function until(fn, label, timeout = 45000) {
  fs.writeFileSync(path.join(path.dirname(resultFile), 'pairing-progress.json'), JSON.stringify({ phase: label }));
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(100); }
  throw new Error('Timed out: ' + label);
}
async function port() { const s = net.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const n=s.address().port; await new Promise(r=>s.close(r)); return n; }
async function start(name) {
  const home = path.join(work, name); fs.mkdirSync(home); const state = path.join(home, 'state'); fs.mkdirSync(state);
  const main = await port(), adminPort = await port(), config = path.join(home,'config.json'), password = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(config, JSON.stringify({ password, awake:'off',fileRoots:[home],maxDevices:20,network:{wifi:false,internet:{kind:'off'}} }));
  const log = fs.openSync(path.join(home,'server.log'),'a'); logs.push(log);
  const proc=spawn(process.execPath,[path.join(pkg,'server.js')],{cwd:pkg,env:isolatedEnv(home,{PORT:String(main),POCKET_DEV_ADMIN_PORT:String(adminPort),POCKET_DEV_CONFIG:config,POCKET_DEV_STATE_DIR:state,POCKET_DEV_NO_OPEN:'1',POCKET_DEV_ROOM_ALLOW_LOOPBACK:'1'}),windowsHide:true,stdio:['ignore',log,log]});
  const s={home,state,proc,base:`http://127.0.0.1:${main}`,admin:`http://127.0.0.1:${adminPort}`,cookie:''};servers.push(s);
  s.call=async(method,route,body,admin=false)=>{const r=await fetch((admin?s.admin:s.base)+route,{method,headers:{...(!admin&&{cookie:s.cookie}),[admin?'x-pocket-admin':'x-pocket-dev']:'1',...(body!==undefined&&{'content-type':'application/json'})},...(body!==undefined&&{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});return{status:r.status,data:await r.json().catch(()=>null)};};
  await until(async()=>{assert.equal(proc.exitCode,null);try{return(await s.call('GET','/api/status')).status===200;}catch{return false;}},name+' server');
  const r=await fetch(s.base+'/api/login',{method:'POST',headers:{'content-type':'application/json','x-pocket-dev':'1'},body:JSON.stringify({password})});assert.ok(r.ok);s.cookie=r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  await s.call('POST','/api/permissions/setup',{status:'skipped'},true);
  return s;
}
try {
  const a=await start('A'),b=await start('B');
  // Ownership choices must agree; showing a QR first must not block a later scan.
  for(const [show,scan] of [['personal','personal'],['personal','external'],['external','personal'],['external','external']]) {
    const invite=await a.call('POST','/api/connections/invite',{connectionType:show},true);assert.equal(invite.status,200);assert.match(invite.data.svg,/<svg/);assert.equal(new URL(invite.data.address).port,new URL(a.base).port);
    assert.equal((await b.call('POST','/api/connections/invite',{connectionType:scan},true)).status,200);
    const before=fs.readFileSync(path.join(b.state,'room.json'),'utf8');
    assert.equal((await b.call('POST','/api/connections/join',{code:'WRNG-WRNG',host:a.base,connectionType:scan})).status,403);
    assert.equal(fs.readFileSync(path.join(b.state,'room.json'),'utf8'),before);
    const joined=await b.call('POST','/api/connections/join',{code:invite.data.code,host:a.base,connectionType:scan});assert.equal(joined.status,200);assert.equal(joined.data.callback.ok,true);
    for(const s of [a,b]){const state=(await s.call('GET','/api/connections')).data;assert.equal(state.computers.find(c=>!c.self).computerAccess,show==='personal'&&scan==='personal');}
    assert.equal((await b.call('POST','/api/connections/join',{code:invite.data.code,host:a.base})).status,409);
    assert.equal((await b.call('POST','/api/connections/leave',{},true)).status,200);
    await until(async()=>(await a.call('GET','/api/connections')).data.computers.length===1,'leave preserves host');
  }
  report.checks.push('four ownership combinations','empty-network recovery','invalid code preserves state','existing network protected','public port in QR','native callbacks in both directions');
  const executable=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean).map(r=>path.join(r,'Microsoft','Edge','Application','msedge.exe')).find(fs.existsSync);assert.ok(executable);
  profile=path.join(work,'edge-profile');edge=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const activePort=path.join(profile,'DevToolsActivePort');await until(()=>fs.existsSync(activePort),'Edge');
  const debug=`http://127.0.0.1:${fs.readFileSync(activePort,'utf8').split('\n')[0]}`;
  const target=await(await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json();socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});
  let serial=0;const pending=new Map(),exceptions=[];
  socket.on('message',raw=>{const m=JSON.parse(String(raw));if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
  function send(method,params={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
  async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
  const wait=selector=>until(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`),selector);
  diagnose=async()=>({screen:await evaluate("document.querySelector('.cc')?.innerText || document.body.innerText"),exceptions});
  const click=async selector=>{await wait(selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
  const clickText=async text=>{await until(()=>evaluate(`[...document.querySelectorAll('.cc button')].some(n=>n.textContent===${JSON.stringify(text)})`),text);await evaluate(`[...document.querySelectorAll('.cc button')].find(n=>n.textContent===${JSON.stringify(text)}).click()`);};
  async function navigate(url){await evaluate('window.__pairNavigatePending=true');await send('Page.navigate',{url});await until(async()=>{try{return await evaluate("!window.__pairNavigatePending && document.readyState==='complete' && !!document.querySelector('#connectedComputersBtn, #settingsBtn')");}catch(e){if(/context|navigat/i.test(e.message))return false;throw e;}},'page ready');}
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('pd-welcome-shown','1')"});
  await send('Network.setCookie',{name:b.cookie.slice(0,b.cookie.indexOf('=')),value:b.cookie.slice(b.cookie.indexOf('=')+1),url:b.base,httpOnly:true});
  report.browser=await evaluate('navigator.userAgent');
  for(const width of [390,1280]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<700});
    await navigate(a.admin+'#devices');await click('#connectedComputersBtn');await clickText('Connect another computer');
    await evaluate("const own=document.querySelector('.cc-field input[type=checkbox]');own.checked=true;own.dispatchEvent(new Event('change',{bubbles:true}))");
    await clickText('Show QR');await wait('.cc-pair-qr svg');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const png=await send('Page.captureScreenshot',{format:'png'});const image=path.join(work,'connection.png');fs.writeFileSync(image,Buffer.from(png.data,'base64'));
    fs.writeFileSync(path.join(path.dirname(resultFile),`pairing-qr-windows-${width}.png`),Buffer.from(png.data,'base64'));
    await navigate(b.base);await click('#settingsBtn');await click('[data-category=computers]');await clickText('Connect another computer');
    await evaluate("const own=document.querySelector('.cc-field input[type=checkbox]');own.checked=true;own.dispatchEvent(new Event('change',{bubbles:true}))");
    await clickText('Show QR');await wait('.cc-pair-qr svg');await clickText('Scan QR');await wait('.cc-manual summary');
    await click('.cc-manual summary');await wait('.cc-manual input');
    assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth || document.querySelector('.cc .rs-body').scrollWidth>document.querySelector('.cc .rs-body').clientWidth+1"),false);
    const manual=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(path.dirname(resultFile),`pairing-manual-windows-${width}.png`),Buffer.from(manual.data,'base64'));
    const doc=await send('DOM.getDocument'),input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.cc input[type=file]'});
    await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[image]});
    await until(async()=>{const error=await evaluate("document.querySelector('.cc .st-err')?.textContent || ''");if(error)throw new Error(error);return evaluate("document.querySelectorAll('.cc-computer').length===2");},'real QR photo pairing');
    assert.equal(await evaluate("document.querySelector('.cc-message').textContent"),'Computer connected.');
    assert.equal((await b.call('GET','/api/connections')).data.computers.find(c=>!c.self).computerAccess,true);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    const done=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(path.dirname(resultFile),`pairing-done-windows-${width}.png`),Buffer.from(done.data,'base64'));
    report.screens.push({width,height:900,passed:true});
    assert.equal((await b.call('POST','/api/connections/leave',{},true)).status,200);
    await until(async()=>(await a.call('GET','/api/connections')).data.computers.length===1,'reset disposable pairing');
  }
  assert.deepEqual(exceptions,[]);report.checks.push('native Edge phone/desktop','actual QR screenshot decoding','Admin QR + phone Settings scan','manual fallback layout','no horizontal overflow','no JavaScript exceptions');report.passed=true;
}catch(e){report.passed=false;report.error=e.stack;if(diagnose)try{report.diagnostic=await diagnose();}catch{}process.exitCode=1;}
finally{
  socket?.close();
  if(profile){const ps=`$pdProfile='${profile.replaceAll("'","''")}';Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'msedge.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($pdProfile,[StringComparison]::OrdinalIgnoreCase) -ge 0} | ForEach-Object {& taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null}`;try{execFileSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,stdio:'ignore'});}catch{}}
  if(edge?.pid)try{execFileSync('taskkill.exe',['/PID',String(edge.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
  for(const s of servers){try{for(const session of(await s.call('GET','/api/sessions')).data||[])await s.call('DELETE','/api/sessions/'+session.id);}catch{};try{execFileSync('taskkill.exe',['/PID',String(s.proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
  await pause(1000);for(const fd of logs)fs.closeSync(fd);
  try{fs.rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:200});report.cleanupComplete=true;}catch(e){report.cleanupComplete=false;report.error||=e.message;process.exitCode=1;}
  fs.writeFileSync(resultFile,JSON.stringify(report,null,2));
}
