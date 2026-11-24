import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Desktop} from '../src/desktop.js';
import {DesktopSource} from '../src/external.js';
import {ObservationUnavailable} from '../src/observation.js';
function frame(x:any){const b=Buffer.from(JSON.stringify(x)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);}
async function fixture(t:any,version=11,ignoreFirstSnapshot=false){const dir=mkdtempSync(join(tmpdir(),'relay-ipc-'));chmodSync(dir,0o700);const path=join(dir,'ipc.sock');let socket:Socket|undefined;const messages:any[]=[];let snapshots=0;
 const server=createServer(c=>{socket=c;let buf=Buffer.alloc(0);c.on('data',b=>{buf=Buffer.concat([buf,b]);while(buf.length>=4&&buf.length>=4+buf.readUInt32LE()){const n=buf.readUInt32LE(),m=JSON.parse(buf.subarray(4,n+4).toString());buf=buf.subarray(n+4);messages.push(m);if(m.type==='request'){let result=m.method==='initialize'?{clientId:'relay'}:m.method==='thread-follower-start-turn'?{result:{turn:{id:'new-turn'}}}:{};c.write(frame({type:'response',requestId:m.requestId,method:m.method,resultType:'success',handledByClientId:'owner',result}));}if(m.method==='thread-stream-following-changed'&&m.params.following){if(ignoreFirstSnapshot&&snapshots++===0)continue;const f=frame({type:'broadcast',method:'thread-stream-state-changed',version,sourceClientId:'owner',params:{hostId:'local',conversationId:'task',change:{type:'snapshot',conversationState:{id:'task',sessionId:'session',hostId:'local',ephemeral:false,resumeState:'resumed',cwd:'/tmp',latestModel:'test',currentPermissions:{approvalPolicy:'on-request'},latestThreadSettings:{model:'test'},requests:[],threadRuntimeStatus:{type:'active',activeFlags:[]},turns:[{id:'turn',status:'inProgress'}]}}}});c.write(f.subarray(0,3));setImmediate(()=>c.write(f.subarray(3)));}}});});
 await new Promise<void>(r=>server.listen(path,r));chmodSync(path,0o600);const d=new Desktop(path,300);t.after(()=>{d.close();socket?.destroy();server.close();rmSync(dir,{recursive:true,force:true});});return {d,messages,send:(m:any)=>socket!.write(frame(m)),path};}
test('desktop fragmented frames discover live owner and route continuation to that owner',async t=>{const x=await fixture(t);await x.d.open();const s=await x.d.snapshot('task');assert.equal(s.id,'task');const id=await x.d.start('task','message-id','continue',()=>true);assert.equal(id,'new-turn');const sent=x.messages.find(m=>m.method==='thread-follower-start-turn');assert.equal(sent.targetClientId,'owner');assert.equal(sent.version,2);assert.deepEqual(Object.keys(sent.params.turnStart.request).sort(),['clientUserMessageId','input','threadId']);});
test('unknown desktop stream version fails closed',async t=>{const x=await fixture(t,999);await x.d.open();await assert.rejects(x.d.snapshot('task'),/version/);assert.ok(!x.messages.some(m=>m.method==='thread-follower-start-turn'));});
test('desktop cancellation guard prevents transmission',async t=>{const x=await fixture(t);await x.d.open();await x.d.snapshot('task');await assert.rejects(x.d.start('task','id','continue',()=>false),/changed/);assert.ok(!x.messages.some(m=>m.method==='thread-follower-start-turn'));});
test('desktop unsafe socket permissions are refused without modification',async t=>{const x=await fixture(t);chmodSync(x.path,0o666);await assert.rejects(x.d.open(),/permissions/);});

test('desktop snapshot timeout reconnects a fresh socket while pinning the original owner',async t=>{
 const x=await fixture(t,11,true);await x.d.open();const source=new DesktopSource(x.d);t.after(()=>source.close());
 await assert.rejects(source.snapshot('task'),ObservationUnavailable);assert.notEqual(source.desktop,x.d);assert.equal(source.desktop.owner,'owner');
 const view=await source.snapshot('task');assert.equal(view.id,'task');assert.equal(view.sessionId,'session');assert.equal(view.phase,'running');assert.ok(!x.messages.some(m=>m.method==='thread-follower-start-turn'));
});
