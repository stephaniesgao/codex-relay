/** Linear-time decoding: do not recopy an entire large snapshot for every chunk. */
export class FrameDecoder {
 private header=Buffer.alloc(4);private headerBytes=0;
 private body?:Buffer;private bodyBytes=0;
 constructor(private receive:(message:any)=>void,private maxBytes=128*1024*1024){}
 push(data:Buffer){
  let offset=0;
  while(offset<data.length){
   if(!this.body){
    const count=Math.min(4-this.headerBytes,data.length-offset);data.copy(this.header,this.headerBytes,offset,offset+count);this.headerBytes+=count;offset+=count;
    if(this.headerBytes<4)return;
    const size=this.header.readUInt32LE();if(size<1||size>this.maxBytes)throw Error('Unsupported desktop frame size');
    this.headerBytes=0;this.body=Buffer.allocUnsafe(size);this.bodyBytes=0;
   }
   const count=Math.min(this.body.length-this.bodyBytes,data.length-offset);data.copy(this.body,this.bodyBytes,offset,offset+count);this.bodyBytes+=count;offset+=count;
   if(this.bodyBytes===this.body.length){const body=this.body;this.body=undefined;this.bodyBytes=0;this.receive(JSON.parse(body.toString()));}
  }
 }
}
