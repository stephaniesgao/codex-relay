import { connect, type Socket } from 'node:net';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FrameDecoder } from './frames.js';
import { ObservationUnavailable, observationError, prefixObservation } from './observation.js';

/** Experimental installed Desktop IPC: never registers an owner or approval handler. */
export class Desktop {
 private socket?:Socket;
 private decoder=new FrameDecoder(message=>this.receive(message));
 private waiters=new Set<()=>void>();
 private replies=new Map<string,any>();
 private failure?:Error;
 private clientId='initializing-client';
 owner?:string;
 threadId?:string;
 state:any;
 generation=0;
 constructor(public endpoint:string,public readonly timeout=120000){}
 get ready(){return !!this.socket&&!this.socket.destroyed&&!this.failure&&this.clientId!=='initializing-client';}
 async open() {
  for(const p of [dirname(this.endpoint),this.endpoint]){let s;try{s=lstatSync(p);}catch(e){throw observationError(e);}if(s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw Error('Unsafe desktop IPC owner or permissions');}
  if(!lstatSync(this.endpoint).isSocket())throw Error('Desktop endpoint is not a socket');
  this.socket=connect(this.endpoint);
  this.socket.on('data',data=>{try{this.decoder.push(data);}catch(e:any){this.failure=e;this.socket?.destroy();}this.wake();});
  this.socket.on('error',e=>{this.failure=observationError(e);this.wake();});this.socket.on('close',()=>{this.failure??=new ObservationUnavailable('Desktop disconnected');this.wake();});
  let reply:any;try{reply=await this.request('initialize',{clientType:'codex-relay'},0);}catch(e){this.close();throw e;}
  if(typeof reply.result?.clientId!=='string')throw Error('Desktop initialization did not return a client ID');this.clientId=reply.result.clientId;
 }
 private wake(){for(const w of this.waiters)w();}
 private send(msg:any){if(this.failure)throw this.failure;const body=Buffer.from(JSON.stringify(msg));const head=Buffer.alloc(4);head.writeUInt32LE(body.length);this.socket!.write(Buffer.concat([head,body]));}
 private receive(m:any){
  if(m.type==='client-discovery-request')this.send({type:'client-discovery-response',requestId:m.requestId,response:{canHandle:false}});
  else if(m.type==='request'){this.send({type:'response',requestId:m.requestId,resultType:'error',error:'unsupported-by-codex-relay'});this.failure=Error('Desktop requested user or owner handling');}
  else if(m.type==='response')this.replies.set(m.requestId,m);
  else if(m.type==='broadcast'&&m.method==='thread-stream-state-changed'&&m.sourceClientId===this.owner&&m.params?.conversationId===this.threadId&&m.params.hostId==='local'){
   if(m.version!==11)throw Error('Unsupported desktop stream version');this.generation++;
   this.state=m.params.change?.type==='snapshot'?m.params.change.conversationState:undefined;
  } else if(m.type==='broadcast'&&['ipc-connection-reset','thread-archived'].includes(m.method)) {if(m.method==='ipc-connection-reset'||m.params?.conversationId===this.threadId){this.failure=Error('Desktop owner or lifecycle changed');this.state=undefined;}}
 }
 private async until(check:()=>boolean){const deadline=Date.now()+this.timeout;while(true){if(this.failure)throw this.failure;if(check())return;const ms=deadline-Date.now();if(ms<=0)throw new ObservationUnavailable('Desktop response timeout');await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);this.waiters.delete(done);resolve();};const timer=setTimeout(done,ms);this.waiters.add(done);});}}
 async request(method:string,params:any,version:number,target?:string){
  if(!['initialize','thread-owner-discovery','thread-follower-start-turn'].includes(method))throw Error('Forbidden desktop operation');
  const id=randomUUID();this.send({type:'request',requestId:id,sourceClientId:this.clientId,method,params,version,timeoutMs:this.timeout,...(target?{targetClientId:target}:{})});
  try{await this.until(()=>this.replies.has(id));}catch(e:any){throw prefixObservation(method,e);}const r=this.replies.get(id);this.replies.delete(id);if(r.resultType!=='success'){if(method==='thread-owner-discovery'&&r.error==='no-client-found')throw new ObservationUnavailable('Desktop owner temporarily unavailable');throw Error('Desktop request rejected or incompatible: '+method);}if(r.method!==method)throw Error('Desktop response method mismatch');return r;
 }
 private follow(following:boolean){this.send({type:'broadcast',sourceClientId:this.clientId,targetClientIds:[this.owner],method:'thread-stream-following-changed',version:1,params:{hostId:'local',conversationId:this.threadId,following}});}
 async snapshot(id:string){
  this.threadId=id;const r=await this.request('thread-owner-discovery',{hostId:'local',conversationId:id},1);
  if(typeof r.handledByClientId!=='string')throw Error('No verified desktop owner');
  if(this.owner&&this.owner!==r.handledByClientId)throw Error('Desktop owner changed');this.owner=r.handledByClientId;
  this.follow(false);this.state=undefined;this.follow(true);try{await this.until(()=>this.state!==undefined);}catch(e:any){throw prefixObservation('desktop snapshot',e);}
  if(this.state?.id!==id||this.state.hostId!=='local')throw Error('Desktop identity mismatch');return this.state;
 }
 async start(id:string,messageId:string,text:string,guard:()=>boolean){
  const generation=this.generation;
  // Give queued socket events a chance to invalidate this snapshot before dispatch.
  await new Promise<void>(r=>setImmediate(r));
  if(!this.state||generation!==this.generation||!guard())throw Error('Desktop state changed before dispatch');
  const r=await this.request('thread-follower-start-turn',{conversationId:id,turnStart:{request:{threadId:id,clientUserMessageId:messageId,input:[{type:'text',text,text_elements:[]}]}}},2,this.owner);
  const turnId=r.result?.result?.turn?.id;if(typeof turnId!=='string'||!turnId)throw Error('Uncertain desktop submission');return turnId;
 }
 close(){try{if(this.owner)this.follow(false);}catch{}this.socket?.destroy();}
}
