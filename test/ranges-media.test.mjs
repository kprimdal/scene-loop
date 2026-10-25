import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {rangePlan,localMutes} from '../lib/ranges.mjs';
import {cutNarration,cutCam} from '../lib/takes.mjs';
const ff=(...a)=>execFileSync('ffmpeg',['-nostdin','-y','-v','error',...a],{maxBuffer:32*1024*1024});
const decode=file=>{const b=ff('-i',file,'-ac','1','-ar','48000','-f','f32le','-');return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length));};
test('all actions at beginning/interior/end and decimal minimum fragments preserve exact decoded sample lengths',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'sl-range-media-'));try{
 const source=join(root,'tone.wav');ff('-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3',source);
 const segments=[{from:0,to:3}];
 for(const action of ['remove','mute','keep'])for(const [from,to] of [[0,.5],[.537,1.581],[2.5,3]]){
  const p=rangePlan(segments,[],{action,from,to}),out=join(root,`${action}-${from}.wav`);await cutNarration(source,{segments:p.segments,mutes:p.mutes,exactRanges:true,mode:'off'},out);const x=decode(out);assert.equal(x.length,Math.round(p.seconds*48000));
  if(action==='mute')for(const m of localMutes(p.segments,p.mutes))assert.ok(x.slice(Math.round(m.from*48000),Math.round(m.to*48000)).every(v=>v===0));
 }
 for(const [from,to] of [[.05,2.95],[.0499,2.9499],[.967,2.013]]){const p=rangePlan(segments,[],{action:'remove',from,to}),out=join(root,'short.wav');await cutNarration(source,{segments:p.segments,exactRanges:true,mode:'off'},out);assert.equal(decode(out).length,Math.round(p.seconds*48000));}
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('decimal cut camera frame boundary stays within one frame of matching audio clock',{timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'sl-range-frame-'));try{
 const source=join(root,'marker.mp4');ff('-f','lavfi','-i','color=red:s=64x36:r=30:d=2','-f','lavfi','-i','color=blue:s=64x36:r=30:d=1','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libx264','-pix_fmt','yuv420p',source);
 const p=rangePlan([{from:0,to:3}],[],{action:'remove',from:.967,to:2.013}),duration=Math.ceil((.2+p.seconds+.8)*30-1e-3)/30,out=join(root,'camera.mp4');
 await cutCam(source,{t0:-.2,segments:p.segments,duration,fps:30,width:64,height:36},out);
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',out]));assert.equal(Number(probe.streams[0].nb_frames),Math.round(duration*30));
 const b=ff('-i',out,'-f','rawvideo','-pix_fmt','rgb24','-');const bytes=64*36*3;let firstBlue=null;
 for(let n=0;n<b.length/bytes;n++){const at=n*bytes;if(b[at+2]>b[at]){firstBlue=n/30;break;}}
 assert.ok(Math.abs(firstBlue-(.2+.967))<=1/30+1e-6,`first blue ${firstBlue}, mapped cut ${.2+.967}`);
 }finally{rmSync(root,{recursive:true,force:true});}
});
