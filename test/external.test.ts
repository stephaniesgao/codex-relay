import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ExternalMonitor,SharedSource,type View} from '../src/external.js';
import {ObservationUnavailable} from '../src/observation.js';
import {TaskEnded} from '../src/external-policy.js';
import {assessDesktop} from '../src/external-policy.js';
import {Store} from '../src/store.js';
const now=1800000000000;
const quota={id:'turn-1',status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}};
function desktop(){return {id:'thread-1',sessionId:'session-1',hostId:'local',ephemeral:false,resumeState:'resumed',cwd:'/work',latestModel:'test',latestReasoningEffort:'high',currentPermissions:{approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}},latestThreadSettings:{model:'test'},requests:[],queuedFollowUps:[],unconfirmedTurnSubmissions:[],threadRuntimeStatus:{type:'systemError'},turns:[structuredClone(quota)]};}
function setup(t:any){const path=mkdtempSync(join(tmpdir(),'relay-external-'));t.after(()=>rmSync(path,{recursive:true,force:true}));let v:View={id:'thread-1',sessionId:'session-1',turn:quota,phase:'waiting',settings:{cwd:'/work',model:'test'},fingerprint:'baseline'};
 let accountId='account-1';let used=0;let allowed=true;let during:(()=>void)|undefined;const sends:any[]=[];let reads=0,snapshots=0;
 const source={async snapshot(){snapshots++;return structuredClone(v);},async start(id:string,messageId:string,text:string,guard:()=>boolean){during?.();if(!guard())throw Error('cancelled');sends.push({id,messageId,text});v={...v,phase:'running',turn:{id:'turn-2',status:'inProgress'},fingerprint:'running'};return 'turn-2';},close(){}};
 const api={async call(method:string){assert.equal(method,'account/rateLimits/read');reads++;return {accountId,ordinaryUsageAllowed:allowed,rateLimits:{limitId:'codex',primary:{usedPercent:used,resetsAt:(now+600000)/1000}}};}};
 const store=new Store(path),e=new ExternalMonitor(source,api,store,()=>now);return {e,source,api,store,sends,setView:(x:Partial<View>)=>v={...v,...x},setAccount:(x:string)=>accountId=x,setUsed:(x:number)=>used=x,setAllowed:(x:boolean)=>allowed=x,reads:()=>reads,snapshots:()=>snapshots,during:(f:()=>void)=>during=f};}
test('adopts existing quota-interrupted desktop task without an enrollment prompt',async t=>{const x=setup(t);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});assert.equal(x.sends.length,0);await x.e.tick();assert.equal(x.sends.length,1);assert.equal(x.sends[0].id,'thread-1');assert.equal(x.e.state.sessionId,'session-1');assert.match(x.sends[0].text,/do not duplicate/i);});
test('adopts an already running task and waits for its structured quota interruption',async t=>{const x=setup(t);x.setView({phase:'running',turn:{id:'turn-1',status:'inProgress'}});await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});await x.e.tick();assert.equal(x.sends.length,0);x.setView({phase:'waiting',turn:quota});await x.e.tick();assert.equal(x.sends.length,1);});
test('external waiting checks live cancellation even before quota deadline',async t=>{const x=setup(t);x.setUsed(100);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});await x.e.tick();const reads=x.reads();x.setView({fingerprint:'manually changed'});await x.e.tick();assert.equal(x.e.state.phase,'blocked');assert.equal(x.sends.length,0);assert.equal(x.reads(),reads);});
test('external duplicate ticks and restart preserve quota deadline',async t=>{const x=setup(t);x.setUsed(100);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});await Promise.all([x.e.tick(),x.e.tick()]);const r=new ExternalMonitor(x.source,x.api,x.store,()=>now);await r.recover();await r.tick();assert.equal(x.sends.length,0);assert.equal(x.reads(),2);});
test('uncertain external submission is not replayed after restart',async t=>{const x=setup(t);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});x.e.state.phase='submitting';x.store.save(x.e.state);const r=new ExternalMonitor(x.source,x.api,x.store,()=>now);await r.recover();await r.tick();assert.equal(r.state.phase,'blocked');assert.equal(x.sends.length,0);});
test('external pause/stop never cancel or restart the owner task',async t=>{const x=setup(t);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});await x.e.control('pause');await x.e.tick();await x.e.control('stop');await x.e.tick();assert.equal(x.sends.length,0);assert.equal(x.e.state.phase,'stopped');});
test('external stop immediately before dispatch prevents a send',async t=>{const x=setup(t);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});x.during(()=>{void x.e.control('stop');});await x.e.tick();assert.equal(x.sends.length,0);assert.equal(x.e.state.phase,'stopped');});
test('external account permission must explicitly allow included usage',async t=>{const x=setup(t);x.setAllowed(false);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});await x.e.tick();assert.equal(x.sends.length,0);assert.equal(x.e.state.phase,'waiting');});
test('desktop policy refuses manual stops, completion, pending inputs, queues and incomplete history',()=>{for(const mutate of [(s:any)=>s.turns[0].status='completed',(s:any)=>s.turns[0].status='interrupted',(s:any)=>s.requests.push({method:'approval'}),(s:any)=>s.queuedFollowUps.push({}),(s:any)=>s.unconfirmedTurnSubmissions.push({}),(s:any)=>s.threadGoal={status:'paused'},(s:any)=>s.threadRuntimeStatus={type:'active',activeFlags:['waitingOnUserInput']},(s:any)=>s.turnHistory={kind:'canonical',history:{islands:[]}}]){const s=desktop();mutate(s);assert.throws(()=>assessDesktop(s));}});
test('desktop settings and permission changes alter the dispatch fingerprint',()=>{const a=desktop(),b=desktop();b.currentPermissions.sandboxPolicy.type='readOnly';assert.notEqual(assessDesktop(a).fingerprint,assessDesktop(b).fingerprint);});
test('version-11 omitted optional queues are accepted and stable',()=>{const s:any=desktop();delete s.queuedFollowUps;delete s.unconfirmedTurnSubmissions;assert.equal(assessDesktop(s).phase,'waiting');});
test('shared CLI refuses disk-only history and never loads it privately',async()=>{const calls:string[]=[];const source=new SharedSource({async call(m:string){calls.push(m);return {data:[]};}});await assert.rejects(source.snapshot('thread-1'),/not loaded/);assert.deepEqual(calls,['thread/loaded/list']);});
test('shared CLI joins the selected live task with no execution overrides',async()=>{const calls:any[]=[];const source=new SharedSource({async call(m:string,p:any){calls.push({m,p});if(m==='thread/loaded/list')return {data:['thread-1']};if(m==='thread/resume')return {thread:{id:'thread-1'},cwd:'/work',model:'test',reasoningEffort:'high'};if(m==='thread/read')return {thread:{id:'thread-1',sessionId:'session-1',cwd:'/work',model:'test',reasoningEffort:'high',ephemeral:false,status:{type:'systemError'}}};if(m==='thread/turns/list')return {data:[quota]};}});const v=await source.snapshot('thread-1');assert.equal(v.phase,'waiting');assert.deepEqual(calls.find(x=>x.m==='thread/resume').p,{threadId:'thread-1'});source.event({serverRequest:true,params:{threadId:'thread-1'}});await assert.rejects(source.snapshot('thread-1'),/Pending/);});

test('startup read outage preserves exact enrollment and recovers after a daemon restart',async t=>{
 const x=setup(t),snapshot=x.source.snapshot;let unavailable=true;
 x.source.snapshot=async()=>{if(unavailable)throw new ObservationUnavailable('Desktop response timeout');return snapshot();};
 await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});
 assert.equal(x.store.load().phase,'connecting');assert.equal(x.store.load().external.threadId,'thread-1');assert.equal(x.store.load().enrollmentPending,true);assert.equal(x.sends.length,0);
 const restarted=new ExternalMonitor(x.source,x.api,x.store,()=>now);unavailable=false;
 await restarted.recover();assert.equal(restarted.state.phase,'connecting');
 restarted.state.nextObservationAt=now;await restarted.tick();assert.equal(restarted.state.phase,'waiting');assert.equal(x.sends.length,0);
 await restarted.tick();assert.equal(x.sends.length,1);
});
test('transient read outage retains quota deadline and never probes or sends early',async t=>{
 const x=setup(t);x.setUsed(100);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});await x.e.tick();const deadline=x.e.state.nextCheck,reads=x.reads(),snapshot=x.source.snapshot;
 x.source.snapshot=async()=>{throw new ObservationUnavailable('Desktop disconnected');};await x.e.tick();assert.equal(x.e.state.phase,'reconnecting');assert.equal(x.e.state.nextCheck,deadline);
 x.source.snapshot=snapshot;x.e.state.nextObservationAt=now;await x.e.tick();assert.equal(x.e.state.phase,'waiting');assert.equal(x.e.state.nextCheck,deadline);assert.equal(x.reads(),reads);assert.equal(x.sends.length,0);
});
test('a timed-out continuation is uncertain and is never connection-retried',async t=>{
 const x=setup(t);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});let attempts=0;
 x.source.start=async()=>{attempts++;throw new ObservationUnavailable('Desktop response timeout');};
 await x.e.tick();assert.equal(x.e.state.phase,'blocked');assert.equal(x.e.state.deliveryUncertain,true);await x.e.tick();await x.e.recover();assert.equal(attempts,1);await assert.rejects(x.e.control('resume'));
});
test('cancellation observed after reconnect disables monitoring without a continuation',async t=>{
 const x=setup(t);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});
 x.source.snapshot=async()=>{throw new ObservationUnavailable('Desktop disconnected');};await x.e.tick();
 x.source.snapshot=async()=>{throw new TaskEnded('stopped');};x.e.state.nextObservationAt=now;await x.e.tick();assert.equal(x.e.state.phase,'stopped');assert.equal(x.sends.length,0);
});
test('read retries are bounded and permission failures never inherit retry permission',async t=>{
 const x=setup(t);x.source.snapshot=async()=>{throw new ObservationUnavailable('Desktop disconnected');};await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});
 for(let i=0;i<12;i++){x.e.state.nextObservationAt=now;await x.e.tick();}assert.equal(x.e.state.phase,'blocked');assert.equal(x.e.state.retryableReadFailure,true);
 x.source.snapshot=async()=>{throw Error('Desktop task has pending approvals or user input');};await x.e.control('resume');assert.equal(x.e.state.phase,'blocked');assert.equal(x.e.state.retryableReadFailure,false);await assert.rejects(x.e.control('resume'));assert.equal(x.sends.length,0);
});
test('stop during pending enrollment prevents enrollment from being re-enabled',async t=>{
 const x=setup(t),snapshot=x.source.snapshot;
 x.source.snapshot=async()=>{await x.e.control('stop');return snapshot();};await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});assert.equal(x.e.state.phase,'stopped');assert.equal(x.sends.length,0);assert.equal(x.reads(),0);
});

test('ordinary account metadata update at startup does not falsely report an account switch',async t=>{
 const x=setup(t),snapshot=x.source.snapshot;
 x.source.snapshot=async()=>{x.e.event({method:'account/updated',params:{authMode:'chatgpt',planType:'plus'}});return snapshot();};
 await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});assert.equal(x.e.state.phase,'waiting');assert.equal(x.e.state.accountId,'account-1');assert.equal(x.sends.length,0);
});
test('same-auth-mode account changes are verified and blocked before any continuation',async t=>{
 const x=setup(t);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});
 x.setAccount('different-account');x.e.event({method:'account/updated',params:{authMode:'chatgpt'}});await x.e.tick();assert.equal(x.e.state.phase,'blocked');assert.equal(x.sends.length,0);
});
test('sign-out notifications stop monitoring immediately',async t=>{
 const x=setup(t);await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});x.e.event({method:'account/updated',params:{authMode:null}});await x.e.tick();assert.equal(x.e.state.phase,'blocked');assert.equal(x.sends.length,0);
});

test('an allowance metadata timeout retries enrollment without losing its target',async t=>{
 const x=setup(t);x.api.call=async()=>{throw Error('RPC timeout: account/rateLimits/read');};await x.e.attach({threadId:'thread-1',source:'desktop',endpoint:'/ipc'},{});assert.equal(x.e.state.phase,'connecting');assert.equal(x.e.state.external.threadId,'thread-1');assert.equal(x.e.state.checks,0);assert.equal(x.sends.length,0);
});
