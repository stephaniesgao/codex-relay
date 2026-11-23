#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, openSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { daemon } from './src/daemon.js';
import { Store, controlSocket } from './src/store.js';
import { probe, RPC } from './src/rpc.js';
import { Desktop } from './src/desktop.js';
import { DesktopSource, SharedSource, type Attachment } from './src/external.js';
const args=process.argv.slice(2), command=args.shift()??'help';
const baseDir=resolve(process.env.RELAY_HOME??join(homedir(),'.local/state/codex-relay'));
const threadId=option('--thread');
if(threadId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId))throw Error('Use the exact thread UUID');
const dir=threadId?join(baseDir,'threads',threadId):baseDir;
const codexHome=resolve(process.env.CODEX_HOME??join(homedir(),'.codex'));
function attachmentOptions():Attachment|undefined{const source=option('--source')??'desktop';if(!['desktop','cli'].includes(source))throw Error('--source must be desktop or cli');const endpoint=resolve(option('--socket')??join(codexHome,source==='desktop'?'ipc/ipc.sock':'app-server-control/app-server-control.sock'));return threadId?{threadId,source:source as 'desktop'|'cli',endpoint}:undefined;}
const binary=process.env.RELAY_CODEX_BIN??'codex';
function option(name:string) {const i=args.indexOf(name);if(i<0)return undefined;const v=args[i+1];if(!v||v.startsWith('--'))throw Error('Missing value for '+name);args.splice(i,2);return v;}
async function control(cmd:string):Promise<any> {return new Promise((resolve,reject)=>{let data='';const c=connect(controlSocket(dir));c.setTimeout(5000,()=>c.destroy(Error('Daemon control timeout')));c.on('connect',()=>c.write(JSON.stringify({command:cmd})+'\n'));c.on('data',x=>data+=x);c.on('error',reject);c.on('end',()=>{try{const r=JSON.parse(data);r.error?reject(Error(r.error)):resolve(r.result);}catch(e){reject(e);}});});}
function xml(s:string){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');}
async function main() {
 if(command==='daemon') {await daemon(dir,binary);return;}
 if(command==='list') {const rpc=new RPC(binary);try{await rpc.initialize();let cursor:any;do{const page=await rpc.call('thread/list',{cursor,limit:100,archived:false,modelProviders:[],sourceKinds:['cli','vscode','exec','appServer','unknown'],sortKey:'updated_at'});for(const t of page.data??[])console.log(JSON.stringify({threadId:t.id,name:t.name,cwd:t.cwd,source:t.source,status:t.status}));cursor=page.nextCursor;}while(cursor);}finally{rpc.close();}return;}
 if(command==='inspect'){if(!threadId)throw Error('inspect requires --thread UUID');const target=attachmentOptions()!,rpc=new RPC(binary,target.source==='cli'?target.endpoint:undefined);let source:DesktopSource|SharedSource|undefined;try{if(target.source==='desktop'){const d=new Desktop(target.endpoint);await d.open();source=new DesktopSource(d);}else{source=new SharedSource(rpc);rpc.onEvent=m=>(source as SharedSource).event(m);}await rpc.initialize();const v=await source.snapshot(threadId);console.log(JSON.stringify({threadId:v.id,sessionId:v.sessionId,phase:v.phase,turnId:v.turn.id,settings:{cwd:v.settings.cwd,model:v.settings.model,reasoningEffort:v.settings.reasoningEffort,permissions:v.settings.permissions??{approvalPolicy:v.settings.approvalPolicy,approvalsReviewer:v.settings.approvalsReviewer,sandbox:v.settings.sandbox}}},null,2));}finally{source?.close();rpc.close();}return;}
 if(command==='doctor') {console.log(JSON.stringify(probe(binary),null,2));return;}
 if(command==='start') {
  const attachment=attachmentOptions();const prompt=option('--prompt'),cwd=resolve(option('--cwd')??process.cwd()),model=option('--model'),limitId=option('--limit-id')??'codex';
  const launchd=args.includes('--launchd'),foreground=args.includes('--foreground');
  if(args.some(a=>!['--launchd','--foreground'].includes(a)))throw Error('Unknown start option');
  if(attachment&&(prompt||model))throw Error('Existing tasks inherit their prompt and settings; omit --prompt and --model');
  const store=new Store(dir);const releaseEnrollment=store.lock('enrollment');try {
  if((prompt||attachment) && store.load() && !(attachment&&store.load()?.threadId===attachment.threadId))throw Error('Existing session found; use a different RELAY_HOME for a new task');
  if(!prompt && !attachment && !store.load())throw Error('First start requires --prompt or --thread UUID');
  const initial=attachment&&!store.load()?{attachment:{...attachment,limitId}}:prompt?{prompt,cwd,model,limitId}:undefined;
  if(launchd && foreground)throw Error('--launchd and --foreground are mutually exclusive');
  if(launchd) {
   if(process.platform!=='darwin')throw Error('launchd requires macOS');
   const codex= binary.includes('/')?resolve(binary):execFileSync('/usr/bin/which',[binary],{encoding:'utf8'}).trim();
   const label='local.codex-relay'+(threadId?'.'+threadId:'');const agentDir=join(homedir(),'Library/LaunchAgents');mkdirSync(agentDir,{recursive:true});
   const plist=join(agentDir,label+'.plist');
   writeFileSync(plist,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath,fileURLToPath(import.meta.url),'daemon'].map(x=>'<string>'+xml(x)+'</string>').join('')}</array><key>EnvironmentVariables</key><dict><key>RELAY_HOME</key><string>${xml(dir)}</string><key>RELAY_CODEX_BIN</key><string>${xml(codex)}</string>${process.env.CODEX_HOME?'<key>CODEX_HOME</key><string>'+xml(process.env.CODEX_HOME)+'</string>':''}<key>PATH</key><string>${xml(process.env.PATH??'/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(dir,'daemon.log'))}</string><key>StandardErrorPath</key><string>${xml(join(dir,'daemon.log'))}</string></dict></plist>`,{mode:0o600});
   try {await control('shutdown');await new Promise(r=>setTimeout(r,300));}catch(e:any){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
   if(initial)store.save({bootstrap:initial});
   try{execFileSync('/bin/launchctl',['print',`gui/${process.getuid!()}/${label}`],{stdio:'ignore'});execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid!()}/${label}`],{stdio:'ignore'});}catch{}
   execFileSync('/bin/launchctl',['bootstrap',`gui/${process.getuid!()}`,plist]);console.log('Installed '+plist+'; monitoring state is preserved.');return;
  }
  try {const s=await control('status');console.log('Daemon already running: '+JSON.stringify(s));return;}catch(e:any){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
  if(foreground){await daemon(dir,binary,initial);return;}
  // Prompt travels in a private file, never in the child command line.
  if(initial)store.save({bootstrap:initial});
  const fd=openSync(join(dir,'daemon.log'),'a',0o600);
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'boot'],{detached:true,stdio:['ignore',fd,fd],env:{...process.env,RELAY_HOME:dir,RELAY_CODEX_BIN:binary}});closeSync(fd);child.unref();
  for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));try{const s=await control('status');console.log(JSON.stringify(s,null,2));return;}catch{}}
  throw Error('Daemon did not become ready. Run relay logs and inspect daemon.log.');
  }finally{releaseEnrollment();}
 }
 if(command==='boot') {await daemon(dir,binary);return;}
 if(command==='logs') {const p=join(dir,'relay.jsonl');if(!existsSync(p)){console.log('No log yet');return;}if(args.includes('--follow')){const child=spawn('/usr/bin/tail',['-n','100','-f',p],{stdio:'inherit'});await new Promise(r=>child.on('exit',r));}else console.log(readFileSync(p,'utf8').trim().split('\n').slice(-100).join('\n'));return;}
 if(['status','pause','resume','stop'].includes(command)) {try{console.log(JSON.stringify(await control(command),null,2));}catch(e:any){if(command==='status'&&['ENOENT','ECONNREFUSED'].includes(e.code)){console.log(JSON.stringify({daemon:'offline',state:new Store(dir).load()},null,2));}else if(['stop','pause'].includes(command)&&['ENOENT','ECONNREFUSED'].includes(e.code)){const store=new Store(dir),release=store.lock('daemon');try{const s=store.load();if(!s?.threadId)throw Error('No enrolled session');if(command==='pause'){if(!['running','waiting'].includes(s.phase))throw Error('Cannot pause this state');s.pausedFrom=s.phase;s.phase='paused';}else s.phase='stopped';store.save(s);store.log(command==='stop'?'stopped_offline':'paused_offline');console.log(JSON.stringify(s,null,2));}finally{release();}}else throw e;}return;}
 console.log(`Codex Relay\n  relay doctor\n  relay start --prompt "TASK" [--cwd DIR] [--model MODEL] [--limit-id codex] [--foreground]\n  relay start                 restart persisted monitoring\n  relay start --launchd [--prompt "TASK"]  install macOS login service\n  relay status | pause | resume | stop | logs [--follow]\nRELAY_HOME selects isolated state. RELAY_CODEX_BIN selects the official CLI executable.\nrelay list | inspect --thread UUID [--source desktop|cli] [--socket PATH]\n  relay start --thread UUID [--source desktop|cli] [--launchd]\nUse --thread UUID with status/pause/resume/stop/logs for an enrolled external task.`);
}
main().catch(e=>{console.error('Codex Relay: '+e.message);process.exitCode=1;});
