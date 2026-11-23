import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RPC} from '../src/rpc.js';
test('real subprocess transport: initialization, structured events, correlation and disconnect',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-rpc-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const executable=join(dir,'fake-codex');
 writeFileSync(executable,`#!${process.execPath}\nconst r=require('node:readline').createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');r.on('line',l=>{const q=JSON.parse(l);if(!q.method)process.exit(5);if(q.method==='initialized')return;if(q.method==='disconnect')process.exit(0);if(q.method==='account/rateLimits/read')send({method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex'}}});if(q.method==='approval')send({id:99,method:'item/commandExecution/requestApproval',params:{threadId:'t'}});send({id:q.id,result:{method:q.method}});});`,{mode:0o700});
 const rpc=new RPC(executable);rpc.onFailure=()=>{};t.after(()=>rpc.close());const events:any[]=[];rpc.onEvent=m=>events.push(m);
 await rpc.initialize();const result=await rpc.call('account/rateLimits/read');assert.equal(result.method,'account/rateLimits/read');assert.equal(events[0].method,'account/rateLimits/updated');await rpc.call('approval');assert.equal(events[1].serverRequest,true);await assert.rejects(rpc.call('disconnect'),/disconnected/);
});
