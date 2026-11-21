import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {joinClips} from '../lib/render.mjs';

const ff=(...a)=>execFileSync('ffmpeg',['-nostdin','-y','-v','error',...a]);
const frames=f=>Number(JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v','-show_entries','stream=nb_frames','-of','json',f])).streams[0].nb_frames);

// A join that writes fewer frames than the clips add up to must fail. A hosted server's join
// ended after the second of 16 scenes, exited 0, and the render played the second scene's
// last picture under the rest of the soundtrack.
test('a cut join writes every frame, and a short one fails instead of finishing',{timeout:60000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'sl-join-short-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const files=['red','green','blue'].map((color,i)=>{const p=join(root,i+'.mp4');ff('-f','lavfi','-i',`color=${color}:s=64x36:r=30:d=1`,'-c:v','libx264','-pix_fmt','yuv420p',p);return p;});
  const soundtrack=join(root,'sound.wav');ff('-f','lavfi','-i','sine=frequency=700:sample_rate=48000:duration=4',soundtrack);
  const out=join(root,'out.mp4');
  await joinClips(files.map(file=>({file,frames:30,fade:0})),out,{fps:30,width:64,height:36,soundtrack});
  assert.equal(frames(out),90);
  rmSync(out);
  // The second clip says 60 frames but holds 30: the video comes out 30 frames short.
  await assert.rejects(joinClips(files.map((file,i)=>({file,frames:i===1?60:30,fade:0})),out,{fps:30,width:64,height:36,soundtrack}),/90 of 120 frames/);
  assert.ok(!existsSync(out),'no render is left behind');
  assert.deepEqual(readdirSync(root).filter(f=>f.includes('.part.')),[]);
});

// Two dissolves in a row. In ffmpeg 5.1 (the Docker image) the picture held under the second
// fade was cloned from the wrong time when it was added after the first xfade, and the join
// dropped everything from the second dissolve on: a 16-scene render stopped after scene 2.
test('a chain of dissolves writes every frame',{timeout:60000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'sl-join-xfade-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const files=['red','green','blue','white'].map((color,i)=>{const p=join(root,i+'.mp4');ff('-f','lavfi','-i',`color=${color}:s=64x36:r=30:d=2`,'-c:v','libx264','-pix_fmt','yuv420p',p);return p;});
  const out=join(root,'out.mp4');
  await joinClips(files.map((file,i)=>({file,frames:60,fade:i?0.6:0})),out,{fps:30,width:64,height:36});
  assert.equal(frames(out),240);
  // The third clip starts at 4 s: blue, not the green held from the second.
  const px=execFileSync('ffmpeg',['-v','error','-ss','4.5','-i',out,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-']);
  assert.ok(px[2]>200&&px[1]<60,`blue at 4.5 s, got ${[...px]}`);
});
