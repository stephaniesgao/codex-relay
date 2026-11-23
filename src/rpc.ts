import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function probe(binary:string) {
 const version=execFileSync(binary,['--version'],{encoding:'utf8'}).trim();
 const tmp=mkdtempSync(join(tmpdir(),'relay-probe-'));
 try {
  execFileSync(binary,['app-server','generate-ts','--out',tmp],{stdio:['ignore','ignore','pipe']});
  const req=readFileSync(join(tmp,'ClientRequest.ts'),'utf8'), notifications=readFileSync(join(tmp,'ServerNotification.ts'),'utf8');
  for(const m of ['account/read','account/rateLimits/read','thread/list','thread/loaded/list','thread/start','thread/read','thread/resume','thread/turns/list','turn/start','turn/interrupt']) if(!req.includes('"'+m+'"')) throw Error('Unsupported method: '+m);
  if(!notifications.includes('"account/rateLimits/updated"')) throw Error('Missing usage notifications');
  if(!readFileSync(join(tmp,'v2/GetAccountRateLimitsResponse.ts'),'utf8').includes('ordinaryUsageAllowed')) throw Error('This version cannot explicitly verify ordinary allowance');
  return {version,transport:'private stdio',verifiedAt:new Date().toISOString()};
 } finally {rmSync(tmp,{recursive:true,force:true});}
}
export interface API { call(method:string, params?:any):Promise<any>; }
export class RPC implements API {
 child: ChildProcessWithoutNullStreams; seq=0; pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
 onEvent: (m:any)=>void = ()=>{}; onFailure:(e:Error)=>void=()=>{};
 constructor(binary:string,proxySocket?:string) {
  this.child=spawn(binary,proxySocket?['app-server','proxy','--sock',proxySocket]:['app-server','--listen','stdio://'],{stdio:'pipe'});
  this.child.stderr.resume(); // Never persist auth or tool output from stderr.
  createInterface({input:this.child.stdout}).on('line',line=>{try {this.message(JSON.parse(line));} catch {this.onFailure(Error('Invalid protocol frame'));}});
  this.child.on('error',e=>this.fail(e)); this.child.on('exit',()=>this.fail(Error('App-server disconnected')));
 }
 fail(e:Error) { for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);} this.pending.clear();this.onFailure(e); }
 message(m:any) {
  if(m.method) { if(m.id!==undefined) { // No approval, elicitation, refresh or tool request is ever auto-answered.
    this.onEvent({...m,serverRequest:true});
   } else this.onEvent(m); return; }
  const p=this.pending.get(m.id); if(!p)return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error('RPC request failed (code '+String(m.error.code)+')')) : p.resolve(m.result);
 }
 call(method:string,params:any={}) { const id=++this.seq; return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('RPC timeout: '+method));},30000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');}); }
 async initialize() {await this.call('initialize',{clientInfo:{name:'codex_relay',title:'Codex Relay',version:'0.2.0'},capabilities:{experimentalApi:false}});this.child.stdin.write(JSON.stringify({method:'initialized'})+'\n');}
 close() {this.child.stdin.end();this.child.kill();}
}
