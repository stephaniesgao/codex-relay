import { createHash } from 'node:crypto';
import { quotaFailure, type Turn } from './policy.js';
export class TaskEnded extends Error {constructor(public phase:'completed'|'stopped'){super(phase==='completed'?'Task completed normally':'Task was manually stopped');}}
export function canonicalTurn(state:any):Turn {
 let t:any;
 if(state.turnHistory?.kind==='canonical'){
  const h=state.turnHistory.history,tail=h?.islands?.at(-1);
  if(tail?.newerBoundary?.status!=='exhausted'||!tail.entries?.length)throw Error('Incomplete desktop history tail');
  t=h.entitiesByKey?.[tail.entries.at(-1).value];
 }else t=state.turns?.at(-1);
 if(!t||typeof (t.turnId??t.id)!=='string')throw Error('Latest live turn is unavailable');
 return {id:t.turnId??t.id,status:t.status,error:t.error};
}
export function assessDesktop(state:any):{turn:Turn;phase:'running'|'waiting';settings:any;fingerprint:string}{
 if(state.hostId!=='local'||(state.ephemeral!==undefined&&state.ephemeral!==false)||state.resumeState!=='resumed')throw Error('Desktop task is not a resumed local persistent task');
 if(!Array.isArray(state.requests)||state.requests.length)throw Error('Desktop task has pending approvals or user input');
 for(const k of ['queuedFollowUps','unconfirmedTurnSubmissions'])if(state[k]!==undefined&&(!Array.isArray(state[k])||state[k].length))throw Error('Desktop task has queued or uncertain submissions');
 if(state.threadGoalResumeConfirmation||(state.threadGoal!=null&&state.threadGoal.status!=='active'))throw Error('Desktop goal requires attention or was stopped');
 const runtime=state.threadRuntimeStatus;
 if(!runtime||!['active','idle','systemError'].includes(runtime.type)||runtime.activeFlags?.length)throw Error('Unsupported runtime or task awaiting user input');
 if(!state.cwd||!state.latestModel||!state.currentPermissions||!state.latestThreadSettings)throw Error('Incomplete desktop execution settings');
 const turn=canonicalTurn(state);
 let phase:'running'|'waiting';
 if(runtime.type==='active'&&turn.status==='inProgress')phase='running';
 else if(['idle','systemError'].includes(runtime.type)&&quotaFailure(turn))phase='waiting';
 else {if(turn.status==='completed')throw new TaskEnded('completed');if(turn.status==='interrupted')throw new TaskEnded('stopped');throw Error('Task is not running or quota interrupted');}
 const settings={cwd:state.cwd,model:state.latestModel,reasoningEffort:state.latestReasoningEffort??state.latestThreadSettings.effort??state.latestCollaborationMode?.settings?.reasoning_effort??null,collaborationMode:state.latestCollaborationMode,permissions:state.currentPermissions,threadSettings:state.latestThreadSettings,environments:state.environments,environmentSelectionEvidence:state.environmentSelectionEvidence,threadAccess:state.threadAccess};
 const fingerprint=hash({id:state.id,settings,turn,goal:state.threadGoal,requests:state.requests,queued:state.queuedFollowUps,unconfirmed:state.unconfirmedTurnSubmissions,runtime,resumeState:state.resumeState});
 return {turn,phase,settings,fingerprint};
}
function sorted(value:any):any {if(Array.isArray(value))return value.map(sorted);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,sorted(value[k])]));return value;}
export function hash(value:any){return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');}
