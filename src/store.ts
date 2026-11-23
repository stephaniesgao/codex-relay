import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, unlinkSync, appendFileSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
export class Store {
  constructor(public dir: string) { mkdirSync(dir,{recursive:true,mode:0o700}); chmodSync(dir,0o700); }
  load(): any { const p=join(this.dir,'state.json'); return existsSync(p) ? JSON.parse(readFileSync(p,'utf8')) : null; }
  save(state: unknown) { const p=join(this.dir,'state.json'), tmp=p+'.tmp'; const fd=openSync(tmp,'w',0o600); try { writeFileSync(fd,JSON.stringify(state,null,2)); fsyncSync(fd); } finally { closeSync(fd); } renameSync(tmp,p); const d=openSync(this.dir,'r'); try {fsyncSync(d);} finally {closeSync(d);} }
  log(event: string, details: unknown = {}) { const p=join(this.dir,'relay.jsonl'); appendFileSync(p,JSON.stringify({time:new Date().toISOString(),event,details})+'\n',{mode:0o600}); }
  lock(name: string): () => void {
    if (!/^[\w-]+$/.test(name)) throw Error('Invalid lock identity');
    const p=join(this.dir,name+'.lock');
    for(let n=0;n<2;n++) {
      try { const fd=openSync(p,'wx',0o600); writeFileSync(fd,String(process.pid)); closeSync(fd); return () => {unlinkSync(p);}; }
      catch(e:any) { if(e.code!=='EEXIST') throw e; const pid=Number(readFileSync(p,'utf8')); if(!Number.isSafeInteger(pid)||pid<=0) throw Error('Uncertain lock owner'); try {process.kill(pid,0);} catch(err:any) {if(err.code==='ESRCH') {
       const reap=p+'.reap';const guard=openSync(reap,'wx',0o600);closeSync(guard);
       try {if(existsSync(p)){const current=Number(readFileSync(p,'utf8'));if(!Number.isSafeInteger(current)||current<=0)throw Error('Uncertain lock owner');try{process.kill(current,0);throw Error('Relay/session already locked');}catch(check:any){if(check.code!=='ESRCH')throw check;unlinkSync(p);}}}finally{unlinkSync(reap);}
       continue;
      } throw err;} throw Error('Relay/session already locked'); }
    }
    throw Error('Cannot acquire lock');
  }
}

// macOS Unix socket paths are limited to roughly 104 bytes. Custom state roots
// and per-thread directories can exceed that limit; use a private short socket.
export function controlSocket(dir:string,create=false):string {
 const normal=join(dir,'control.sock');if(Buffer.byteLength(normal)<100)return normal;
 const parent=join(process.platform==='darwin'?'/private/tmp':'/tmp','codex-relay-'+process.getuid?.());
 if(create&&!existsSync(parent))mkdirSync(parent,{mode:0o700});
 if(existsSync(parent)){const s=lstatSync(parent);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw Error('Unsafe short control socket directory');}
 return join(parent,createHash('sha256').update(dir).digest('hex').slice(0,32)+'.sock');
}
