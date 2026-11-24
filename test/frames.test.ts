import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrameDecoder} from '../src/frames.js';
function frame(value:any){const b=Buffer.from(JSON.stringify(value)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);}
test('fragmented snapshots larger than the old 32 MiB limit decode without repeated whole-frame copies',()=>{
 const data=frame({payload:'x'.repeat(33*1024*1024)});let received=0;
 const decoder=new FrameDecoder(value=>{received++;assert.equal(value.payload.length,33*1024*1024);});
 for(let offset=0;offset<data.length;offset+=16384)decoder.push(data.subarray(offset,offset+16384));assert.equal(received,1);
});
test('split headers and multiple messages retain ordering',()=>{
 const values:any[]=[],decoder=new FrameDecoder(value=>values.push(value)),data=Buffer.concat([frame({id:1}),frame({id:2})]);
 for(const byte of data)decoder.push(Buffer.from([byte]));assert.deepEqual(values,[{id:1},{id:2}]);
});
test('invalid and oversized announced frames are rejected before allocation',()=>{
 for(const size of [0,129*1024*1024]){const header=Buffer.alloc(4);header.writeUInt32LE(size);assert.throws(()=>new FrameDecoder(()=>{}).push(header),/frame size/);}
});
