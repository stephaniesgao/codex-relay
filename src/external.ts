import { randomUUID } from 'node:crypto';
import { allowance, CONTINUE, quotaFailure, type Turn } from './policy.js';
import { assessDesktop, hash, TaskEnded } from './external-policy.js';
import { Desktop } from './desktop.js';
import { Store } from './store.js';
import type { API } from './rpc.js';
import { ObservationUnavailable } from './observation.js';
export type Attachment={threadId:string;source:'desktop'|'cli';endpoint:string;limitId?:string};
export type View={id:string;sessionId:string;turn:Turn;phase:'running'|'waiting';settings:any;fingerprint:string};
export interface Source {snapshot(id:string):Promise<View>;start(id:string,messageId:string,text:string,guard:()=>boolean):Promise<string>;close():void;}
export class DesktopSource implements Source {
 constructor(public desktop:Desktop){}
 async snapshot(id:string):Promise<View>{
  try {
   if(!this.desktop.ready)await this.desktop.open();
   const s=await this.desktop.snapshot(id),a=assessDesktop(s);
   if(typeof s.sessionId!=='string'||!s.sessionId)throw Error('Unknown desktop session identity');
   return {id:s.id,sessionId:s.sessionId,...a};
  }catch(error){
   if(error instanceof ObservationUnavailable){
    const previous=this.desktop;previous.close();
    this.desktop=new Desktop(previous.endpoint,previous.timeout);
    // Reconnecting must not silently accept a new owner.
    this.desktop.owner=previous.owner;
   }
   throw error;
  }
 }
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
/** Record the exact target BEFORE probing/connecting or consuming bootstrap state. */
export function pendingAttachment(target:Attachment,capabilities:any={}) {
 return {version:1,external:target,threadId:target.threadId,phase:'connecting',enrollmentPending:true,
  limitId:target.limitId??'codex',checks:0,readRetries:0,nextObservationAt:0,capabilities};
}

export class ExternalMonitor {
 state:any;
 busy=false;
 constructor(private source:Source,private usage:API,private store:Store,private now=()=>Date.now()){this.state=store.load();}
 private persist(event:string,details:any={}){this.store.save(this.state);this.store.log(event,details);}
 block(reason:string,retryableReadFailure=false){
  if(this.state&&!['completed','stopped'].includes(this.state.phase)){
   if(this.state.phase==='submitting')this.state.deliveryUncertain=true;
   this.state.retryableReadFailure=retryableReadFailure;this.state.phase='blocked';this.state.reason=reason;this.persist('external_attention',{reason});
  }
 }
 event(message:any){
  const s=this.state;if(!s)return;
  if(message.serverRequest&&(!message.params?.threadId||message.params.threadId===s.threadId)){
   this.block('Server requested approval, authentication or user input');return;
  }
  if(message.method==='account/updated'){
   if(!['chatgpt','chatgptAuthTokens'].includes(message.params?.authMode)){this.block('Authentication unavailable or changed');return;}
   // This notification reports auth mode/plan, not an account ID. Verify identity
   // with a fresh read instead of treating ordinary startup metadata as a switch.
   s.accountGeneration=(s.accountGeneration??0)+1;s.accountRecheckRequired=true;
   this.persist('account_metadata_updated');
  }
  if(message.method==='account/rateLimits/updated')this.store.log('usage_update_received');
 }
 private async readUsage(){
  const generation=this.state.accountGeneration??0;
  let result;try{result=await this.usage.call('account/rateLimits/read');}catch(error:any){if(error.message==='RPC timeout: account/rateLimits/read')throw new ObservationUnavailable('Allowance read timed out');throw error;}
  if((this.state.accountGeneration??0)!==generation)throw new ObservationUnavailable('Account metadata changed during verification');
  this.state.accountRecheckRequired=false;return result;
 }
 async attach(target:Attachment,capabilities:any){
  if(this.state)throw Error('State directory already has a task; choose another RELAY_HOME');
  this.state=pendingAttachment(target,capabilities);this.persist('external_enrollment_pending',{threadId:target.threadId,source:target.source});
  await this.tick(); // Enrollment is read-only. Continuation happens only in a later tick.
 }
 private enabled(){return this.state&&['running','waiting','connecting','reconnecting'].includes(this.state.phase);}
 private async enroll(){
  const s=this.state;
  const view=await this.source.snapshot(s.threadId);if(!this.enabled())return;
  const u=await this.readUsage();if(!this.enabled())return;
  if(view.id!==s.threadId||!view.sessionId||!u.accountId)throw Error('Cannot bind external task or account identity');
  Object.assign(s,{sessionId:view.sessionId,settings:view.settings,accountId:u.accountId,phase:view.phase,
   turnId:view.turn.id,failedTurnId:view.phase==='waiting'?view.turn.id:undefined,
   fingerprint:view.phase==='waiting'?view.fingerprint:undefined,nextCheck:this.now(),checks:0,
   lastObservedAt:this.now(),enrollmentPending:false,readRetries:0,nextObservationAt:0,retryableReadFailure:false,reason:undefined});
  this.persist('external_enrolled',{threadId:view.id,source:s.external.source,phase:view.phase});
 }
 private bind(v:View){if(v.id!==this.state.threadId||v.sessionId!==this.state.sessionId||hash(v.settings)!==hash(this.state.settings))throw Error('External task identity or execution settings changed');}
 private failure(error:any){
  if(['stopped','completed','paused'].includes(this.state?.phase))return;
  if(error instanceof TaskEnded){this.state.phase=error.phase;this.persist('external_'+error.phase);}
  else this.block(error.message);
 }
 private retryRead(error:ObservationUnavailable){
  const s=this.state;if(!this.enabled())return;
  s.readRetries=(s.readRetries??0)+1;s.retryableReadFailure=true;
  if(s.readRetries>12){this.block('Desktop observation unavailable after 12 retries: '+error.message,true);return;}
  if(s.phase!=='connecting'&&s.phase!=='reconnecting')s.reconnectPhase=s.phase;
  s.phase=s.enrollmentPending?'connecting':'reconnecting';s.reason=error.message;
  s.nextObservationAt=this.now()+Math.min(300000,5000*2**(s.readRetries-1));
  this.persist('external_observation_retry',{attempt:s.readRetries,at:s.nextObservationAt,reason:error.message});
 }
 async recover(){
  if(!this.state?.external)throw Error('Missing external enrollment');
  if(this.state.phase==='submitting'||this.state.deliveryUncertain){this.block('Uncertain external submission; inspect the original task manually');return;}
  if(this.enabled())await this.tick();
 }
 private async inspect():Promise<View>{
  const v=await this.source.snapshot(this.state.threadId);this.bind(v);this.state.lastObservedAt=this.now();
  if(v.turn.id!==this.state.turnId){
   if(this.state.settleUntil>this.now()&&v.turn.id===this.state.previousTurnId&&quotaFailure(v.turn))return {...v,phase:'running'};
   throw Error('Latest external turn changed outside Relay');
  }
  this.state.settleUntil=undefined;this.state.previousTurnId=undefined;
  if(v.phase==='waiting'&&this.state.fingerprint&&v.fingerprint!==this.state.fingerprint)throw Error('External task changed while waiting');
  return v;
 }
 async tick(){
  const s=this.state;
  if(this.busy||!this.enabled()||(s.nextObservationAt??0)>this.now())return;
  this.busy=true;let release:(()=>void)|undefined;let submitting=false;
  try {
   release=this.store.lock('session-'+s.threadId);
   if(s.enrollmentPending){await this.enroll();return;}
   const view=await this.inspect();if(!this.enabled())return;
   if(s.accountRecheckRequired){const u=await this.readUsage();if(!this.enabled())return;if(u.accountId!==s.accountId)throw Error('External account changed');this.persist('external_account_verified');}
   if(s.phase==='reconnecting'){
    s.phase=s.reconnectPhase??view.phase;s.reason=undefined;s.retryableReadFailure=false;
    s.readRetries=0;s.nextObservationAt=0;this.persist('external_observation_recovered');
   }
   s.readRetries=0;s.nextObservationAt=0;
   if(view.phase==='waiting'){
    if(s.phase==='running'){
     s.phase='waiting';s.failedTurnId=view.turn.id;s.checks=0;s.nextCheck=this.now();
     s.fingerprint=view.fingerprint;this.persist('external_usage_interruption',{turnId:view.turn.id});
    }
    s.fingerprint=view.fingerprint;
   }
   if(this.now()-(s.lastPersistedObservationAt??0)>=30000){s.lastPersistedObservationAt=this.now();this.store.save(s);}
   if(s.phase!=='waiting'||view.phase!=='waiting'||(s.nextCheck??0)>this.now())return;
   const u=await this.readUsage();if(s.phase!=='waiting')return;
   if(u.accountId!==s.accountId)throw Error('External account changed');
   const d=allowance(u,s.limitId,this.now());this.store.log('external_reset_check',d);
   if(!d.ready){
    if(++s.checks>12)throw Error('Allowance unavailable after 12 checks');
    s.nextCheck=d.next??this.now()+Math.min(3600000,60000*2**(s.checks-1));
    this.persist('external_retry_scheduled',{at:s.nextCheck,reason:d.reason});return;
   }
   const fresh=await this.source.snapshot(s.threadId);this.bind(fresh);if(s.phase!=='waiting')return;
   if(s.accountRecheckRequired)return;
   if(fresh.phase!=='waiting'||fresh.fingerprint!==view.fingerprint||fresh.turn.id!==s.failedTurnId)throw Error('External task changed before continuation');
   s.phase='submitting';s.messageId=randomUUID();submitting=true;
   this.persist('external_submission_pending',{turnId:s.failedTurnId,messageId:s.messageId});
   const turnId=await this.source.start(s.threadId,s.messageId,CONTINUE,()=>s.phase==='submitting'&&!s.accountRecheckRequired);
   s.previousTurnId=s.failedTurnId;s.settleUntil=this.now()+30000;s.turnId=turnId;
   s.fingerprint=undefined;s.failedTurnId=undefined;s.checks=0;s.deliveryUncertain=false;
   if(s.phase==='submitting')s.phase='running';this.persist('external_submission_acknowledged',{turnId});
  }catch(error:any){
   // Even a transport timeout AFTER submission intent is an uncertain write.
   if(error instanceof ObservationUnavailable&&!submitting)this.retryRead(error);else this.failure(error);
  }finally{release?.();this.busy=false;}
 }
 async control(command:string){
  const s=this.state;if(!s)throw Error('No enrolled task');
  if(command==='stop'){s.phase='stopped';this.persist('external_monitoring_stopped');}
  else if(command==='pause'){
   if(!this.enabled())throw Error('Cannot pause this state');s.pausedFrom=s.phase;s.phase='paused';this.persist('external_monitoring_paused');
  }else if(command==='resume'){
   if(s.phase==='paused')s.phase=s.pausedFrom;
   else if(s.phase==='blocked'&&s.retryableReadFailure&&!s.deliveryUncertain){s.phase=s.enrollmentPending?'connecting':'reconnecting';s.readRetries=0;}
   else throw Error('Only paused monitoring or a verified read-only connection failure can resume');
   s.nextObservationAt=0;this.persist('external_monitoring_resumed');await this.recover();
  }
  return s;
 }
}
