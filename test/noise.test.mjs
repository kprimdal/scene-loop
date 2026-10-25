import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,existsSync,copyFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {openVideo} from '../lib/video.mjs';
import {TEMPLATE_DIR} from '../lib/projects.mjs';
import {mediaHash,selectNoiseFiles,recoverNoise,noiseWrite,noisePath} from '../lib/noise.mjs';
import {cutNarration,toTake,fromTake} from '../lib/takes.mjs';

const ff=(...args)=>execFileSync('ffmpeg',['-nostdin','-y','-v','error',...args],{maxBuffer:32*1024*1024});
const decoded=file=>{const b=ff('-i',file,'-vn','-ac','1','-ar','48000','-f','f32le','-');return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length));};
const rms=(a,from,to)=>{const x=a.slice(Math.round(from*48000),Math.round(to*48000));return Math.sqrt(x.reduce((sum,v)=>sum+v*v,0)/x.length);};
const lag=(a,b,from,to)=>{let best=[-Infinity,0];for(let d=-120;d<=120;d++){let c=0;for(let i=Math.round(from*48000);i<Math.round(to*48000);i++)c+=a[i]*b[i+d];if(c>best[0])best=[c,d];}return best[1];};
const make=dir=>openVideo(dir,{project:'scratch',video:'demo',reviewer:'test',emit:()=>{}});
const id='s01-intro';

test('cleanup preserves original, exact multi-cut timing, words, pins, camera, music/SFX and cached exports; restart and revert',{timeout:120000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-cleanup-')),dir=join(root,'video');cpSync(TEMPLATE_DIR,dir,{recursive:true});
  const source=join(root,'source.mp4');
  // Synthetic voiced tones and seeded ffmpeg noise, plus a distinct broadband timing marker.
  ff('-f','lavfi','-i','color=c=blue:s=320x180:r=30:d=4','-f','lavfi','-i',"aevalsrc='0.015*(random(0)-0.5)+0.025*sin(2*PI*40*t)+if(between(t,0.5,1.05)+between(t,2.3,3.1),0.2*sin(2*PI*241*t)+0.09*sin(2*PI*482*t),0)+if(between(t,0.75,0.7504),0.4,0)':s=48000:d=4",'-c:v','libx264','-pix_fmt','yuv420p','-c:a','pcm_s16le','-f','matroska',source);
  let v=await make(dir);
  try {
    await v.setMeta({width:320,height:180});
    await v.updateScene(id,{narration:'Listen here.'});
    await v.addTake(id,{path:source});
    await v.chooseTake(id,1,{keep:[[0,1.3],[2,3.5]]});
    await v.setNarrationWords(id,{adopt:false,cut:false,words:[{word:'Listen',start:.5,end:1.05},{word:'here.',start:1.6,end:2.4}]});
    const html=readFileSync(join(dir,'scenes',id,'scene.html'),'utf8').replace('</template>',`<video src="assets/cam/${id}.mp4" muted style="position:absolute;width:100px;height:60px;left:10px;top:10px"></video></template>`).replace('data-composition-id', 'data-sfx="tick@0.2" data-at="word:Listen" data-composition-id');
    await v.writeSceneHtml(id,{html,model:'test'},'api');
    const music=join(dir,'assets/music.wav');ff('-f','lavfi','-i','sine=frequency=1000:duration=1',music);await v.setMeta({music:'assets/music.wav'});
    await v.createScene({id:'other-narration',title:'Other narration',duration:1,model:'test'});
    const otherAudio=join(root,'other.wav');ff('-f','lavfi','-i','sine=frequency=600:sample_rate=48000:duration=0.5',otherAudio);
    await v.setNarrationAudio('other-narration',{path:otherAudio});
    const otherHash=mediaHash(join(dir,'assets/narration/other-narration.wav'));
    const pinsFile=join(dir,'.state/scenes',id+'.json'),pinState=JSON.parse(readFileSync(pinsFile,'utf8'));
    pinState.comments.push({id:'cleanup-review',version:1,t:.2,by:'Scratch reviewer',text:'Keep the voice natural.',status:'pending'});writeFileSync(pinsFile,JSON.stringify(pinState));const pinsHash=mediaHash(pinsFile);
    await v.buildSoundtrack({loudness:'off',lead:.21});
    const original=join(dir,'assets/takes',id,'1.mp4'),audio=join(dir,'assets/narration',id+'.wav'),words=join(dir,'assets/narration',id+'.words.json'),cam=join(dir,'assets/cam',id+'.mp4');
    const hashes={original:mediaHash(original),audio:mediaHash(audio),words:mediaHash(words),cam:mediaHash(cam),music:mediaHash(music),html:mediaHash(join(dir,'scenes',id,'scene.html')),sb:mediaHash(join(dir,'storyboard.json'))};
    const versions=await v.history.versions(id),stamp=(await v.view()).stamp;
    const cache=()=>readdirSync(join(dir,'.build/clips')).map(n=>[n,mediaHash(join(dir,'.build/clips',n))]);
    const render=async name=>{const job=await v.render();let r;const until=Date.now()+60000;do{r=v.getRender(job.job??job.id);if(Date.now()>until)throw new Error(JSON.stringify(r));await new Promise(r=>setTimeout(r,30));}while(r.state==='running');assert.equal(r.state,'done',JSON.stringify(r));const file=join(root,name+'.mp4');copyFileSync(r.path??r.file,file);return {file,job:r};};
    const before=await render('before'),clips=cache();
    let state=v.inspectNoise(id);assert.equal(state.mode,'gentle');assert.equal(state.defaultTreatment,true);
    let preview=await v.previewNoise(id,{mode:'off',contextHash:state.contextHash});
    assert.equal(preview.preview.samples,134400);
    for(const k of ['original','audio','words','cam','music','html','sb'])assert.equal(mediaHash(({original,audio,words,cam,music,html:join(dir,'scenes',id,'scene.html'),sb:join(dir,'storyboard.json')})[k]),hashes[k],k+' changed during preview');
    const candidate=join(dir,preview.preview.url.split('/scratch/demo/')[1]),off=decoded(candidate),gentle=decoded(audio);
    assert.equal(off.length,gentle.length);assert.ok(rms(gentle,.1,.4)<rms(off,.1,.4)*.6,'known non-speech noise drops');
    assert.ok(Math.abs(lag(off,gentle,.73,.79))<=48,'compensated marker stays within 1 ms: '+lag(off,gentle,.73,.79));
    assert.equal(toTake(1.6,state.segments),2.3);assert.equal(fromTake(2.3,state.segments),1.6);
    const kept=await v.keepNoise(id,{token:preview.preview.token,contextHash:preview.contextHash});assert.equal(kept.mode,'off');assert.equal(kept.canRevert,true);assert.equal(mediaHash(audio),mediaHash(candidate));assert.notEqual((await v.view()).stamp,stamp);
    const after=await render('kept');assert.equal(after.job.clips.rendered,0);assert.deepEqual(cache(),clips);
    v=await make(dir);state=v.inspectNoise(id);assert.equal(state.mode,'off');assert.equal(state.canRevert,true);
    await v.revertNoise(id,{contextHash:state.contextHash});assert.equal(mediaHash(audio),hashes.audio);
    const reverted=await render('reverted');assert.equal(reverted.job.clips.rendered,0);assert.deepEqual(decoded(before.file),decoded(reverted.file));assert.notDeepEqual(decoded(before.file),decoded(after.file));
    for(const [key,file] of Object.entries({original,words,cam,music,html:join(dir,'scenes',id,'scene.html')}))assert.equal(mediaHash(file),hashes[key],key);
    assert.equal(mediaHash(pinsFile),pinsHash);assert.equal(mediaHash(join(dir,'assets/narration/other-narration.wav')),otherHash);
    assert.deepEqual(await v.history.versions(id),versions);assert.equal(v.storyboard().scenes[0].narrationLead,.21);assert.equal(v.storyboard().scenes[0].duration,4);
    // Repeated preparation starts at the original and has identical samples, not cumulative filters.
    state=v.inspectNoise(id);preview=await v.previewNoise(id,{contextHash:state.contextHash,mode:'gentle'});const pHash=mediaHash(join(dir,preview.preview.url.split('/scratch/demo/')[1]));
    const again=await v.previewNoise(id,{contextHash:state.contextHash,mode:'gentle'});assert.equal(mediaHash(join(dir,again.preview.url.split('/scratch/demo/')[1])),pHash);
    await assert.rejects(v.keepNoise(id,{contextHash:preview.contextHash,token:preview.preview.token}),/expired/);
    // A take switch and a same-take edit invalidate old previews and never select them.
    await v.addTake(id,{path:source});await v.chooseTake(id,2,{keep:[[0,1.3],[2,3.5]]});
    await assert.rejects(v.keepNoise(id,{contextHash:again.contextHash,token:again.preview.token}),/changed/);
    await v.chooseTake(id,1,{keep:[[0,1.3],[2,3.5]]});state=v.inspectNoise(id);
    preview=await v.previewNoise(id,{contextHash:state.contextHash,mode:'off'});await v.chooseTake(id,1,{keep:[[0,1.2],[2,3.5]]});
    await assert.rejects(v.keepNoise(id,{contextHash:preview.contextHash,token:preview.preview.token}),/changed/);
    // Mode survives a reselect, a later cut, adoption, and ordinary soundtrack rebuild.
    state=v.inspectNoise(id);preview=await v.previewNoise(id,{contextHash:state.contextHash,mode:'off'});await v.keepNoise(id,{contextHash:preview.contextHash,token:preview.preview.token});
    await v.chooseTake(id,1);assert.equal(v.inspectNoise(id).mode,'off');assert.equal(v.inspectNoise(id).segments.length,2);
    await v.setNarrationWords(id,{words:[{word:'Listen',start:.5,end:.8},{word:'here.',start:1.5,end:2.3}],cut:false});
    await v.buildSoundtrack();assert.equal(v.inspectNoise(id).mode,'off');
    // A concurrent mix/scene change during preparation rejects the candidate without selecting it.
    state=v.inspectNoise(id);const raceAudio=mediaHash(audio);
    const preparation=v.previewNoise(id,{contextHash:state.contextHash,mode:'off'});
    const outcome=preparation.then(()=>null,e=>e);
    await new Promise(r=>setTimeout(r,5));await v.setMeta({title:'Changed during preparation'});
    assert.match((await outcome)?.message??'',/changed/);assert.equal(mediaHash(audio),raceAudio);
    // Failure at preview and mix preparation leaves last good selected files and pending state.
    state=v.inspectNoise(id);const good=mediaHash(audio),mix=mediaHash(join(dir,'assets/narration.m4a'));
    const oldPath=process.env.PATH;process.env.PATH='/nonexistent';
    try{await assert.rejects(v.previewNoise(id,{contextHash:state.contextHash,mode:'off'}),/ffmpeg/);}finally{process.env.PATH=oldPath;}
    assert.equal(mediaHash(audio),good);assert.equal(mediaHash(join(dir,'assets/narration.m4a')),mix);
    preview=await v.previewNoise(id,{contextHash:state.contextHash,mode:'gentle'});process.env.PATH='/nonexistent';
    try{await assert.rejects(v.keepNoise(id,{contextHash:preview.contextHash,token:preview.preview.token}),/ffprobe|ffmpeg/);}finally{process.env.PATH=oldPath;}
    assert.equal(mediaHash(audio),good);assert.equal(mediaHash(join(dir,'assets/narration.m4a')),mix);assert.equal(v.inspectNoise(id).preview.token,preview.preview.token);
    if(process.env.NOISE_EVIDENCE_DIR){mkdirSync(process.env.NOISE_EVIDENCE_DIR,{recursive:true});for(const name of ['before','kept','reverted'])copyFileSync(join(root,name+'.mp4'),join(process.env.NOISE_EVIDENCE_DIR,name+'.mp4'));writeFileSync(join(process.env.NOISE_EVIDENCE_DIR,'measurements.json'),JSON.stringify({samples:off.length,markerLagSamples:lag(off,gentle,.73,.79),noiseOff:rms(off,.1,.4),noiseGentle:rms(gentle,.1,.4),voiceOff:rms(off,.55,.7),voiceGentle:rms(gentle,.55,.7),cachedClips:clips.length,hashes},null,2));}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('cleanup supports trusted symlink ancestors; isolates videos; rejects internal symlinks and rolls back interrupted selection',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-cleanup-alias-'));cpSync(TEMPLATE_DIR,join(root,'real/video'),{recursive:true});symlinkSync(join(root,'real'),join(root,'alias'));
  const dir=join(root,'alias/video');const source=join(root,'take.wav');ff('-f','lavfi','-i','sine=frequency=250:duration=2',source);
  try {
    let v=await make(dir);assert.equal(v.inspectNoise(id).supported,false);
    await v.addTake(id,{path:source});await v.chooseTake(id,1,{keep:[[0,2]]});
    let state=v.inspectNoise(id),p=await v.previewNoise(id,{contextHash:state.contextHash,mode:'off'});
    assert.match(p.preview.url,/^\/p\/scratch\/demo\/assets\/noise\//);
    cpSync(TEMPLATE_DIR,join(root,'other'),{recursive:true});const other=await make(join(root,'other'));await other.addTake(id,{path:source});await other.chooseTake(id,1,{keep:[[0,2]]});
    await assert.rejects(other.keepNoise(id,{contextHash:p.contextHash,token:p.preview.token}),/changed|expired/);
    await v.keepNoise(id,{contextHash:p.contextHash,token:p.preview.token});assert.equal(v.inspectNoise(id).mode,'off');
    const target='assets/narration/'+id+'.wav',originalHash=mediaHash(join(dir,target));
    await assert.rejects(async()=>selectNoiseFiles(dir,[[target,'assets/takes/'+id+'/1.wav'],['storyboard.json','assets/missing-file']]));assert.equal(mediaHash(join(dir,target)),originalHash);
    const backup='.state/noise/old.wav';copyFileSync(join(dir,target),join(dir,backup));noiseWrite(join(dir,'.state/noise/transaction.json'),{entries:[{target,backup}]});writeFileSync(join(dir,target),'interrupted');
    v=await make(dir);assert.equal(mediaHash(join(dir,target)),originalHash);assert.equal(existsSync(join(dir,'.state/noise/transaction.json')),false);
    symlinkSync(root,join(dir,'assets','escape'));assert.throws(()=>noisePath(dir,'assets/escape/test'),/symlinks/);
    await v.setNarrationAudio(id,{path:source});assert.equal(v.inspectNoise(id).supported,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
