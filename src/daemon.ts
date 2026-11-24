import { createServer } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RPC, probe } from './rpc.js';
import { Store, controlSocket } from './store.js';
import { Engine } from './engine.js';
import { Desktop } from './desktop.js';
import { DesktopSource, SharedSource, ExternalMonitor, pendingAttachment, type Attachment, type Source } from './external.js';
import { lstatSync } from 'node:fs';
export async function daemon(dir:string, binary:string, initial?:{prompt?:string;cwd?:string;model?:string;limitId?:string;attachment?:Attachment}) {
 const store=new Store(dir), unlock=store.lock('daemon');
 let rpc:RPC|undefined;let source:Source|undefined;
 try {
  let saved=store.load();
  if(saved?.bootstrap){initial=saved.bootstrap;if(!initial?.attachment)store.save(null);store.log('bootstrap_consumed');}
  const attachment:Attachment|undefined=initial?.attachment??saved?.external;
  if(attachment&&(!saved?.external)){
   saved=pendingAttachment(attachment);store.save(saved);store.log('external_enrollment_pending',{threadId:attachment.threadId,source:attachment.source});
  }
  const capabilities=probe(binary);store.log('capabilities',capabilities);
  if(attachment?.source==='cli'){const st=lstatSync(attachment.endpoint);if(!st.isSocket()||st.uid!==process.getuid?.()||(st.mode&0o077))throw Error('Unsafe shared CLI socket');}
  rpc=new RPC(binary,attachment?.source==='cli'?attachment.endpoint:undefined);
  let engine:Engine|ExternalMonitor;
  if(attachment){
   if(attachment.source==='desktop'){source=new DesktopSource(new Desktop(attachment.endpoint));}else source=new SharedSource(rpc);
   const external=new ExternalMonitor(source,rpc,store);engine=external;engine.state.capabilities=capabilities;
   rpc.onEvent=m=>{if(source instanceof SharedSource)source.event(m);external.event(m);};
  }else{const own=new Engine(rpc,store);engine=own;rpc.onEvent=m=>own.event(m);}
  rpc.onFailure=e=>engine.block(e.message);
  await rpc.initialize();
  const account=await rpc.call('account/read',{refreshToken:false});
  if(account.account?.type!=='chatgpt'){engine.block('A signed-in ChatGPT account is required; run codex login manually');throw Error('A signed-in ChatGPT account is required; run codex login manually');}
  if(!attachment){
   if(initial?.prompt)await (engine as Engine).create(initial.prompt,initial.cwd!,initial.model,capabilities,initial.limitId);
   else {try{await engine.recover();}catch(e:any){engine.block(e.message);}}
  }
  const socket=controlSocket(dir,true);if(existsSync(socket))unlinkSync(socket);
  const server=createServer(c=>{let data='';c.setTimeout(5000,()=>c.destroy());c.on('data',chunk=>{data+=chunk;if(data.length>4096){c.destroy();return;}if(!data.includes('\n'))return;c.pause();void (async()=>{try {const {command}=JSON.parse(data.trim());if(!['status','stop','pause','resume','shutdown'].includes(command))throw Error('Invalid command');if(command==='shutdown'){if(engine.state && (engine.state.phase==='submitting'||(engine.state.phase==='running'&&!attachment)))throw Error('Cannot hand over an active turn; wait for quota interruption');c.end(JSON.stringify({result:'shutdown'})+'\n');setTimeout(shutdown,100);return;}const result=command==='status'?engine.state:await engine.control(command);c.end(JSON.stringify({result})+'\n');}catch(e:any){c.end(JSON.stringify({error:e.message})+'\n');}})();});});
  server.on('error',e=>{engine.block(e.message);source?.close();rpc?.close();unlock();process.exit(1);});
  server.listen(socket,()=>chmodSync(socket,0o600));
  const timer=setInterval(()=>void engine.tick().catch(e=>engine.block(e.message)),attachment?5000:1000);
  const shutdown=()=>{clearInterval(timer);server.close();source?.close();rpc?.close();if(existsSync(socket))unlinkSync(socket);unlock();process.exit(0);};
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  if(attachment)void engine.recover().catch(e=>engine.block(e.message));
 }catch(e){source?.close();rpc?.close();unlock();throw e;}
}
