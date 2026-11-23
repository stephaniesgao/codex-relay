import { allowance, quotaFailure, CONTINUE, type Turn, type Usage } from './policy.js';
import { Store } from './store.js';
import type { API } from './rpc.js';
export type State = {version:1; threadId:string; sessionId:string; settings:any; accountId:string; limitId:string; phase:'running'|'waiting'|'submitting'|'paused'|'blocked'|'completed'|'stopped'; turnId?:string; failedTurnId?:string; nextCheck?:number; checks:number; reason?:string; pausedFrom?:string; capabilities:any};
function settings(r:any) {return {cwd:r.cwd,model:r.model,modelProvider:r.modelProvider,serviceTier:r.serviceTier,approvalPolicy:r.approvalPolicy,approvalsReviewer:r.approvalsReviewer,sandbox:r.sandbox,reasoningEffort:r.reasoningEffort};}
export class Engine {
 state:State|null; busy=false;
 constructor(public api:API,public store:Store,public now=()=>Date.now()) {this.state=store.load();if(this.state && (this.state.version!==1 || !this.state.threadId || !this.state.sessionId || !this.state.settings || !this.state.accountId))throw Error('Invalid or incomplete persisted state; manual inspection required');}
 persist(event:string,details:any={}) {this.store.save(this.state);this.store.log(event,details);}
 block(reason:string) {if(this.state && !['completed','stopped'].includes(this.state.phase)){this.state.phase='blocked';this.state.reason=reason;this.persist('attention',{reason});}}
 async create(prompt:string,cwd:string,model:string|undefined,capabilities:any,limitId='codex') {
  if(this.state) throw Error('State already exists. Use a separate RELAY_HOME for a new task.');
  const usage:Usage=await this.api.call('account/rateLimits/read');
  if(!usage.accountId) throw Error('Cannot bind account identity; no task started');
  const r=await this.api.call('thread/start',{cwd,...(model?{model}:{}),ephemeral:false});
  if(!r.thread?.id || !r.thread.sessionId || r.cwd!==cwd || r.modelProvider!=='openai' || r.approvalsReviewer!=='user' || r.approvalPolicy==='never' || r.sandbox?.type==='dangerFullAccess') throw Error('Unsupported identity, provider or unsafe automatic permission configuration');
  this.state={version:1,threadId:r.thread.id,sessionId:r.thread.sessionId,settings:settings(r),accountId:usage.accountId,limitId,phase:'submitting',checks:0,capabilities};
  this.persist('session_registered',{threadId:r.thread.id,sessionId:r.thread.sessionId});
  await this.submit(prompt);
 }
 async submit(text:string) {
  const s=this.state!;s.phase='submitting';this.persist('submission_pending',{failedTurnId:s.failedTurnId});
  const r=await this.api.call('turn/start',{threadId:s.threadId,input:[{type:'text',text,text_elements:[]}]});
  if(!r.turn?.id) throw Error('Missing turn identity');
  s.turnId=r.turn.id;
  if((s as State).phase==='stopped')await this.api.call('turn/interrupt',{threadId:s.threadId,turnId:r.turn.id});
  if(s.phase==='submitting') s.phase='running';
  this.persist('submission_acknowledged',{turnId:r.turn.id});
 }
 async latest():Promise<{thread:any;turn:Turn}> {
  const s=this.state!;
  const {thread}=await this.api.call('thread/read',{threadId:s.threadId,includeTurns:false});
  if(thread?.id!==s.threadId || thread.sessionId!==s.sessionId || thread.cwd!==s.settings.cwd || thread.ephemeral!==false) throw Error('Uncertain session identity');
  const r=await this.api.call('thread/turns/list',{threadId:s.threadId,sortDirection:'desc',limit:1});
  if(!r.data?.[0]?.id) throw Error('Cannot verify latest turn');
  return {thread,turn:r.data[0]};
 }
 async recover() {
  const s=this.state;if(!s || ['paused','blocked','completed','stopped'].includes(s.phase))return;
  if(s.phase==='submitting') {this.block('Uncertain previous submission; inspect original thread manually');return;}
  const {thread,turn}=await this.latest();
  if(turn.id!==s.turnId) {this.block('Latest turn changed outside Relay');return;}
  if(thread.status?.type==='active') {this.block('Session active outside this private server');return;}
  if(quotaFailure(turn)) {s.phase='waiting';s.failedTurnId=turn.id;this.persist('recovered_interruption');}
  else if(turn.status==='completed') {s.phase='completed';this.persist('completed');}
  else this.block('Session stopped or interrupted without verified quota failure');
 }
 event(m:any) {
  const s=this.state;if(!s)return;
  if(m.serverRequest) {this.block('Server requested approval, authentication, tool handling or user input: '+m.method);return;}
  if(m.method==='account/updated') {this.block('Account changed; manual verification required');return;}
  if(m.method==='account/rateLimits/updated') {this.store.log('usage_update_received');return;} // Sparse events never authorize a send.
  if(m.params?.threadId!==s.threadId)return;
  if(['thread/settings/updated','thread/archived','thread/deleted','thread/closed','thread/reverted'].includes(m.method)) {this.block('Session settings or lifecycle changed');return;}
  if(m.method==='thread/status/changed' && m.params.status?.activeFlags?.length) {this.block('Session waiting for approval or user input');return;}
  if(m.method==='error' && m.params.error?.codexErrorInfo==='unauthorized') {this.block('Authentication failure');return;}
  if(m.method!=='turn/completed' || !['running','submitting','waiting','paused'].includes(s.phase))return;
  const wasPaused=s.phase==='paused';
  const t:Turn=m.params.turn;
  if(!t?.id || (s.turnId && s.phase!=='submitting' && t.id!==s.turnId)) {this.block('Unexpected turn identity');return;}
  if(s.failedTurnId===t.id && s.phase==='waiting')return;
  s.turnId=t.id;
  if(quotaFailure(t)) {s.failedTurnId=t.id;s.phase=wasPaused?'paused':'waiting';if(wasPaused)s.pausedFrom='waiting';s.checks=0;s.nextCheck=this.now();this.persist('usage_interruption',{turnId:t.id});}
  else if(t.status==='completed') {s.phase='completed';this.persist('completed');}
  else this.block(t.status==='interrupted'?'Manually cancelled':'Non-quota failure');
 }
 async tick() {
  const s=this.state;
  if(this.busy || !s || s.phase!=='waiting' || (s.nextCheck??0)>this.now())return;
  const release=this.store.lock('session-'+s.threadId);
  this.busy=true;
  try {
   const usage:Usage=await this.api.call('account/rateLimits/read');
   if(s.phase!=='waiting')return;
   if(usage.accountId!==s.accountId) throw Error('Missing or changed account identity');
   const decision=allowance(usage,s.limitId,this.now());this.store.log('reset_check',decision);
   if(!decision.ready) {
    if(++s.checks>12) {this.block('Allowance unavailable after 12 checks; inspect status');return;}
    s.nextCheck=decision.next??this.now()+Math.min(3600000,60000*2**(s.checks-1));
    this.persist('retry_scheduled',{at:s.nextCheck,reason:decision.reason});return;
   }
   const before=await this.latest();
   if(s.phase!=='waiting')return;
   if(before.turn.id!==s.failedTurnId || !quotaFailure(before.turn) || !['idle','systemError','notLoaded'].includes(before.thread.status?.type)) throw Error('Task changed, completed, cancelled or active');
   const r=await this.api.call('thread/resume',{threadId:s.threadId});
   if(s.phase!=='waiting')return;
   if(r.thread?.id!==s.threadId || r.thread.sessionId!==s.sessionId || JSON.stringify(settings(r))!==JSON.stringify(s.settings)) throw Error('Resumed identity or execution settings changed');
   const after=await this.latest();
   if(s.phase!=='waiting')return;
   if(after.turn.id!==s.failedTurnId || !quotaFailure(after.turn) || after.thread.status?.type==='active') throw Error('Session changed during resume');
   await this.submit(CONTINUE);
  } catch(e:any) {this.block(e.message);} finally {release();this.busy=false;}
 }
 async control(command:string) {
  const s=this.state;if(!s)throw Error('No monitored session');
  if(command==='pause') {if(!['waiting','running'].includes(s.phase))throw Error('Cannot pause this state');s.pausedFrom=s.phase;s.phase='paused';this.persist('paused');}
  else if(command==='resume') {if(s.phase!=='paused')throw Error('Only explicitly paused monitoring can resume; blocked sessions require manual inspection');s.phase=s.pausedFrom==='waiting'?'waiting':'running';this.persist('monitoring_resumed');await this.recover();}
  else if(command==='stop') {const active=s.phase==='running'||s.phase==='submitting';s.phase='stopped';this.persist('stopped');if(active&&s.turnId)await this.api.call('turn/interrupt',{threadId:s.threadId,turnId:s.turnId});}
  return s;
 }
}
