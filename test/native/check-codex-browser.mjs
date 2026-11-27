// Native Codex → Playwright MCP → real browser check, with a private Codex home and no model calls.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';
import {connectCodexRpc} from '../../src/chat/codex-rpc.js';
import {browserMcpConfig,BROWSER_MCP_NAME,BROWSER_TOOLS} from '../../src/chat/browser-tools.js';
import {isolatedEnv} from '../isolated-env.mjs';
const bin=process.argv[2] || process.env.POCKET_DEV_CODEX;
if(!bin) throw new Error('Pass the path to an installed Codex executable.');
const reportFile=process.argv[3] || path.join(os.tmpdir(),'pocket-codex-browser-native.json');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pd-browser-native-'));let rpc,server,threadId;
const report={checks:[],error:null};
try {
 fs.mkdirSync(path.join(root,'.codex'));fs.writeFileSync(path.join(root,'.codex','config.toml'),'[mcp_servers.preserve]\ncommand = "node"\nargs = []\nenabled = false\n');
 server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Pocket browser validation</title><button onclick="document.querySelector(\'p\').textContent=\'Clicks: 1\'">Increment</button><p>Clicks: 0</p>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 // Keep Windows known-folder identity valid for Chromium. CODEX_HOME and all
 // tool histories remain private; the browser still creates its own isolated profile.
 rpc=await connectCodexRpc({bin,env:isolatedEnv(root, process.platform === 'win32' ? { USERPROFILE:process.env.USERPROFILE,APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA } : {}),experimental:true});
 const config=(await rpc.call('config/read',{includeLayers:false,cwd:root})).config;
 assert.ok(config.mcp_servers.preserve); report.checks.push('isolated native Codex configuration');
 const settings=browserMcpConfig({cwd:root,imageDir:path.join(root,'images')},{headless:true});
 const started=await rpc.call('thread/start',{cwd:root,model:null,approvalPolicy:'untrusted',sandbox:'workspace-write',ephemeral:false,config:{['mcp_servers.'+BROWSER_MCP_NAME]:settings}});
 threadId=started.thread.id;report.sandboxType=started.sandbox?.type;report.checks.push('browser MCP injected without replacing existing configuration');
 let inventory;
 for(let i=0;i<60;i++){inventory=await rpc.call('mcpServerStatus/list',{threadId,limit:100});if(inventory.data?.some(s=>s.name===BROWSER_MCP_NAME&&Object.keys(s.tools||{}).length))break;await new Promise(r=>setTimeout(r,500));}
 const browser=inventory.data.find(s=>s.name===BROWSER_MCP_NAME);assert.ok(browser,'native Codex discovered browser MCP');report.tools=Object.keys(browser.tools||{});assert.ok(report.tools.length);assert.ok(report.tools.every(name=>BROWSER_TOOLS.includes(name)));report.checks.push('only approved browser tools are exposed');
 const call=(tool,args={})=>rpc.call('mcpServer/tool/call',{threadId,server:BROWSER_MCP_NAME,tool,arguments:args});
 const nav=await call('browser_navigate',{url});assert.notEqual(nav.isError,true,JSON.stringify(nav));
 const snapshots=()=>fs.readdirSync(path.join(root,'images','browser')).filter(name=>name.endsWith('.yml')).sort();
 const latestSnapshot=()=>fs.readFileSync(path.join(root,'images','browser',snapshots().at(-1)),'utf8');
 const text=latestSnapshot();const match=/button "Increment" \[ref=([^\]]+)/.exec(text);
 if(!match)throw new Error('No Increment button reference');
 const targetKey=browser.tools.browser_click.inputSchema.properties.target ? 'target' : 'ref';const clicked=await call('browser_click',{element:'Increment',[targetKey]:match[1]});assert.notEqual(clicked.isError,true);const evaluated=await call('browser_evaluate',{function: '() => document.querySelector("p").textContent'});assert.match(JSON.stringify(evaluated),/Clicks: 1/); report.checks.push('native browser navigation and click');
 await call('browser_close');report.checks.push('owned browser closed');
 await rpc.call('thread/inject_items',{threadId,items:[{type:'message',role:'user',content:[{type:'input_text',text:'Local browser fixture validation. No model execution requested.'}]}]});
 await new Promise(resolve=>setTimeout(resolve,100));
 await rpc.call('thread/unsubscribe',{threadId});
 await rpc.call('thread/resume',{threadId,cwd:root,model:null,approvalPolicy:'untrusted',sandbox:'workspace-write',excludeTurns:true,config:{['mcp_servers.'+BROWSER_MCP_NAME]:{command:process.execPath,args:['-e','process.exit(0)'],enabled:false}}});
 const disabled=await rpc.call('mcpServerStatus/list',{threadId,limit:100});assert.equal(disabled.data.some(s=>s.name===BROWSER_MCP_NAME&&Object.keys(s.tools||{}).length),false);report.checks.push('browser tools removed after disabling');
 assert.deepEqual(Object.keys((await rpc.call('config/read',{includeLayers:false,cwd:root})).config.mcp_servers),['preserve']);report.checks.push('global MCP configuration preserved');
}catch(error){report.error=error.stack||String(error);process.exitCode=1;}
finally{if(threadId)await rpc?.call('thread/unsubscribe',{threadId}).catch(()=>{});await rpc?.close();if(server)await new Promise(r=>server.close(r));fs.writeFileSync(reportFile,JSON.stringify(report,null,2));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});console.log(JSON.stringify(report,null,2));}
