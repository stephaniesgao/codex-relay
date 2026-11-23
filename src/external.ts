import { randomUUID } from 'node:crypto';
import { allowance, CONTINUE, quotaFailure, type Turn } from './policy.js';
import { assessDesktop, hash, TaskEnded } from './external-policy.js';
import { Desktop } from './desktop.js';
import { Store } from './store.js';
import type { API } from './rpc.js';
export type Attachment={threadId:string;source:'desktop'|'cli';endpoint:string;limitId?:string};
export type View={id:string;sessionId:string;turn:Turn;phase:'running'|'waiting';settings:any;fingerprint:string};
export interface Source {snapshot(id:string):Promise<View>;start(id:string,messageId:string,text:string,guard:()=>boolean):Promise<string>;close():void;}
export class DesktopSource implements Source {
 constructor(public desktop:Desktop){}
 async snapshot(id:string):Promise<View>{const s=await this.desktop.snapshot(id),a=assessDesktop(s);if(typeof s.sessionId!=='string'||!s.sessionId)throw Error('Unknown desktop session identity');return {id:s.id,sessionId:s.sessionId,...a};}
 start(id:string,messageId:string,text:string,guard:()=>boolean){return this.desktop.start(id,messageId,text,guard);}
 close(){this.desktop.close();}
}
export class SharedSource implements Source {
 private settings:any; private id?:string; private invalid?:string;
 constructor(private api:API){}
 event(m:any){if(m.serverRequest && (!m.params?.threadId||m.params.threadId===this.id))this.invalid='Pending server request';if(m.params?.threadId===this.id && (['thread/settings/updated','thread/closed','thread/archived','thread/deleted','thread/reverted','thread/queue/changed','thread/goal/updated','thread/goal/cleared'].includes(m.method)))this.invalid='Shared task settings, queue, goal or lifecycle changed';}
 async snapshot(id:string):Promise<View>{
  if(this.invalid)throw Error(this.invalid);
  // A private server's disk history can never establish live ownership.
  const loaded=await this.api.call('thread/loaded/list');if(!loaded.data?.includes(id))throw Error('CLI task is not loaded in the selected shared app-server');
  this.id=id;
  if(!this.settings){const r=await this.api.call('thread/resume',{threadId:id});if(r.thread?.id!==id)throw Error('Shared owner returned a different task');this.settings={cwd:r.cwd,model:r.model,modelProvider:r.modelProvider,reasoningEffort:r.reasoningEffort,serviceTier:r.serviceTier,approvalPolicy:r.approvalPolicy,approvalsReviewer:r.approvalsReviewer,sandbox:r.sandbox,collaborationMode:r.collaborationMode,disabledPluginIds:r.disabledPluginIds};}
  const {thread}=await this.api.call('thread/read',{threadId:id,includeTurns:false});
  if(thread?.id!==id||!thread.sessionId||thread.ephemeral!==false||thread.cwd!==this.settings.cwd||thread.model!==this.settings.model||thread.reasoningEffort!==this.settings.reasoningEffort)throw Error('Shared task identity or settings changed');
  const turns=await this.api.call('thread/turns/list',{threadId:id,sortDirection:'desc',limit:1});const turn=turns.data?.[0];
  if(!turn?.id||thread.status?.activeFlags?.length)throw Error('Shared task requires user input or has no canonical turn');
  const phase=thread.status?.type==='active'&&turn.status==='inProgress'?'running':(['idle','systemError'].includes(thread.status?.type)&&quotaFailure(turn)?'waiting':undefined);
  if(!phase){if(turn.status==='completed')throw new TaskEnded('completed');if(turn.status==='interrupted')throw new TaskEnded('stopped');throw Error('CLI task has no verified quota failure');}
  if(this.invalid)throw Error(this.invalid);
  return {id,sessionId:thread.sessionId,turn,phase,settings:this.settings,fingerprint:hash({id,sessionId:thread.sessionId,settings:this.settings,turn,status:thread.status})};
 }
 async start(id:string,messageId:string,text:string,guard:()=>boolean){await new Promise<void>(r=>setImmediate(r));if(this.invalid||!guard())throw Error('Shared task changed before dispatch');const r=await this.api.call('turn/start',{threadId:id,clientUserMessageId:messageId,input:[{type:'text',text,text_elements:[]}]});if(!r.turn?.id)throw Error('Uncertain shared submission');return r.turn.id;}
 close(){}
}
export class ExternalMonitor {
 state:any;busy=false;
 constructor(private source:Source,private usage:API,private store:Store,private now=()=>Date.now()){this.state=store.load();}
 private persist(event:string,details:any={}){this.store.save(this.state);this.store.log(event,details);}
 block(reason:string){if(this.state&&!['completed','stopped'].includes(this.state.phase)){this.state.phase='blocked';this.state.reason=reason;this.persist('external_attention',{reason});}}
 async attach(target:Attachment,capabilities:any){
  if(this.state)throw Error('State directory already has a task; choose another RELAY_HOME');
  const view=await this.source.snapshot(target.threadId);const u=await this.usage.call('account/rateLimits/read');if(!u.accountId)throw Error('Cannot bind external task account');
  this.state={version:1,external:target,threadId:view.id,sessionId:view.sessionId,settings:view.settings,accountId:u.accountId,limitId:target.limitId??'codex',phase:view.phase,turnId:view.turn.id,failedTurnId:view.phase==='waiting'?view.turn.id:undefined,fingerprint:view.phase==='waiting'?view.fingerprint:undefined,nextCheck:this.now(),checks:0,capabilities};
  this.persist('external_enrolled',{threadId:view.id,source:target.source,phase:view.phase});
 }
 private bind(v:View){if(v.id!==this.state.threadId||v.sessionId!==this.state.sessionId||hash(v.settings)!==hash(this.state.settings))throw Error('External task identity or execution settings changed');}
 private failure(e:any){if(e instanceof TaskEnded){this.state.phase=e.phase;this.persist('external_'+e.phase);}else this.block(e.message);}
 async recover(){if(!this.state?.external)throw Error('Missing external enrollment');if(this.state.phase==='submitting')this.block('Uncertain external submission; inspect the original task manually');else if(['running','waiting'].includes(this.state.phase)){try{await this.inspect();}catch(e:any){this.failure(e);}}}
 private async inspect():Promise<View>{const v=await this.source.snapshot(this.state.threadId);this.bind(v);if(v.turn.id!==this.state.turnId){if(this.state.settleUntil>this.now()&&v.turn.id===this.state.previousTurnId&&quotaFailure(v.turn))return {...v,phase:'running'};throw Error('Latest external turn changed outside Relay');}this.state.settleUntil=undefined;this.state.previousTurnId=undefined;
  if(v.phase==='waiting') {if(this.state.fingerprint&&v.fingerprint!==this.state.fingerprint)throw Error('External task changed while waiting');if(this.state.phase==='running'){this.state.fingerprint=v.fingerprint;this.state.phase='waiting';this.state.failedTurnId=v.turn.id;this.state.checks=0;this.state.nextCheck=this.now();this.persist('external_usage_interruption',{turnId:v.turn.id});}this.state.fingerprint=v.fingerprint;}
  return v;
 }
 async tick(){const s=this.state;if(this.busy||!s||!['running','waiting'].includes(s.phase))return;this.busy=true;let release:(()=>void)|undefined;
  try {
   release=this.store.lock('session-'+s.threadId);const view=await this.inspect();if(!['running','waiting'].includes(s.phase)||view.phase!=='waiting'||(s.nextCheck??0)>this.now())return;
   const u=await this.usage.call('account/rateLimits/read');if(s.phase!=='waiting')return;if(u.accountId!==s.accountId)throw Error('External account changed');
   const d=allowance(u,s.limitId,this.now());this.store.log('external_reset_check',d);
   if(!d.ready){if(++s.checks>12)throw Error('Allowance unavailable after 12 checks');s.nextCheck=d.next??this.now()+Math.min(3600000,60000*2**(s.checks-1));this.persist('external_retry_scheduled',{at:s.nextCheck,reason:d.reason});return;}
   const fresh=await this.source.snapshot(s.threadId);this.bind(fresh);if(s.phase!=='waiting')return;
   if(fresh.phase!=='waiting'||fresh.fingerprint!==view.fingerprint||fresh.turn.id!==s.failedTurnId)throw Error('External task changed before continuation');
   s.phase='submitting';s.messageId=randomUUID();this.persist('external_submission_pending',{turnId:s.failedTurnId,messageId:s.messageId});
   const turnId=await this.source.start(s.threadId,s.messageId,CONTINUE,()=>s.phase==='submitting');
   s.previousTurnId=s.failedTurnId;s.settleUntil=this.now()+30000;s.turnId=turnId;s.fingerprint=undefined;s.failedTurnId=undefined;s.checks=0;if(s.phase==='submitting')s.phase='running';this.persist('external_submission_acknowledged',{turnId});
  }catch(e:any){this.failure(e);}finally{release?.();this.busy=false;}
 }
 async control(command:string){const s=this.state;if(!s)throw Error('No enrolled task');if(command==='stop'){s.phase='stopped';this.persist('external_monitoring_stopped');}else if(command==='pause'){if(!['running','waiting'].includes(s.phase))throw Error('Cannot pause this state');s.pausedFrom=s.phase;s.phase='paused';this.persist('external_monitoring_paused');}else if(command==='resume'){if(s.phase!=='paused')throw Error('Only explicitly paused external monitoring can resume');s.phase=s.pausedFrom;this.persist('external_monitoring_resumed');try{await this.inspect();}catch(e:any){this.failure(e);}}return s;}
}
