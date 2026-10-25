import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync,readFileSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {openVideo} from '../lib/video.mjs';
import {TEMPLATE_DIR} from '../lib/projects.mjs';
import {mediaHash,noisePath,noiseWrite,recoverNoise} from '../lib/noise.mjs';
const ff=(...a)=>execFileSync('ffmpeg',['-nostdin','-y','-v','error',...a],{maxBuffer:32*1024*1024});
const decode=file=>{const b=ff('-i',file,'-vn','-ac','1','-ar','48000','-f','f32le','-');return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length));};
const rms=(x,a,b)=>Math.sqrt(x.slice(Math.round(a*48000),Math.round(b*48000)).reduce((n,v)=>n+v*v,0)/Math.round((b-a)*48000));
const id='s01-intro';
async function setup(t,camera=false){
 const root=mkdtempSync(join(tmpdir(),'sl-ranges-')),dir=join(root,'video');cpSync(TEMPLATE_DIR,dir,{recursive:true});t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,camera?'source.mp4':'source.wav');
 const audio="aevalsrc='if(lt(t,1),0.25*sin(2*PI*300*t),if(lt(t,2),0.25*sin(2*PI*600*t),0.25*sin(2*PI*900*t)))':s=48000:d=3";
 if(camera)ff('-f','lavfi','-i','color=red:s=160x90:r=30:d=1','-f','lavfi','-i','color=green:s=160x90:r=30:d=1','-f','lavfi','-i','color=blue:s=160x90:r=30:d=1','-f','lavfi','-i',audio,'-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]','-map','[v]','-map','3:a','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source);
 else ff('-f','lavfi','-i',audio,source);
 const opts={project:'scratch',video:'ranges',reviewer:'test',emit:()=>{}};let v=await openVideo(dir,opts);
 await v.setMeta({width:160,height:90});await v.updateScene(id,{duration:4,narration:'One Two Three'});
 await v.addTake(id,{path:source});await v.chooseTake(id,1,{keep:[[0,3]]});
 await v.setNarrationWords(id,{words:[{word:'One',start:.2,end:.6},{word:'Two',start:1.2,end:1.6},{word:'Three',start:2.2,end:2.6}],adopt:false,cut:false});
 await v.buildSoundtrack({lead:.2,loudness:'off'});
 const n=v.inspectNoise(id),p=await v.previewNoise(id,{contextHash:n.contextHash,mode:'off'});await v.keepNoise(id,{contextHash:p.contextHash,token:p.preview.token});
 return {root,dir,v,opts,source};
}
async function apply(v,action,from,to){const d=await v.inspectRanges(id);const p=await v.previewRange(id,{contextHash:d.contextHash,action,from,to});assert.ok(p.pending,JSON.stringify(p));const r=await v.applyRange(id,{contextHash:p.contextHash,token:p.pending.token});assert.equal(r.selected,true);return r;}
test('remove, mute, keep and restart undo preserve original, selected cleanup and scene tail',{timeout:90000},async t=>{
 const {dir,v,opts}=await setup(t,true);
 const audio=join(dir,`assets/narration/${id}.wav`),original=join(dir,`assets/takes/${id}/1.mp4`),hash=mediaHash(original),before=mediaHash(audio),camBefore=mediaHash(join(dir,`assets/cam/${id}.mp4`));
 const r=await apply(v,'remove',1,2);assert.equal(r.seconds,2);assert.equal(r.duration,3);assert.equal(r.lead,.2);assert.ok(Math.abs(r.impact.tail-.8)<1e-9);assert.equal(r.canUndo,true);assert.equal(r.mode,'off');
 assert.deepEqual(JSON.parse(readFileSync(join(dir,`assets/narration/${id}.words.json`))).map(w=>[w.word,w.start]),[['One',.2],['Three',1.2]]);
 assert.equal(v.storyboard().scenes[0].narration,'One Two Three');assert.equal(mediaHash(original),hash);
 const html=await v.sceneHtml(id);assert.match(html.html,/data-duration="3"/);
 assert.match(await v.history.fileAt(id,html.version),/data-duration="3"/);
 const prior=await openVideo(dir,opts);await prior.updateScene(id,{title:'Unrelated title after cut'});
 const undo=await prior.undoRange(id,{contextHash:(await prior.inspectRanges(id)).contextHash});assert.equal(undo.undone,true);assert.equal(mediaHash(audio),before);assert.equal(mediaHash(join(dir,`assets/cam/${id}.mp4`)),camBefore);assert.equal(prior.storyboard().scenes[0].title,'Unrelated title after cut');assert.equal(prior.storyboard().scenes[0].duration,4);
 const mute=await apply(prior,'mute',.8,1.2);assert.equal(mute.duration,4);assert.equal(mute.seconds,3);assert.equal(mediaHash(join(dir,`assets/cam/${id}.mp4`)),camBefore);
 const x=decode(audio);assert.equal(x.length,144000);assert.ok(rms(x,.85,1.15)<1e-7);assert.ok(rms(x,.2,.5)>.15);
 const inspect=prior.inspectNoise(id),noise=await prior.previewNoise(id,{contextHash:inspect.contextHash,mode:'gentle'});await prior.keepNoise(id,{contextHash:noise.contextHash,token:noise.preview.token});assert.ok(rms(decode(audio),.85,1.15)<1e-7);
 await prior.revertNoise(id,{contextHash:prior.inspectNoise(id).contextHash});assert.ok(rms(decode(audio),.85,1.15)<1e-7);
 await prior.chooseTake(id,1);assert.ok(rms(decode(audio),.85,1.15)<1e-7);
 const keep=await apply(prior,'keep',.5,2.5);assert.equal(keep.duration,3);assert.deepEqual(keep.mutes,[{from:.3,to:.7}]);assert.ok(rms(decode(audio),.35,.65)<1e-7);assert.equal(mediaHash(original),hash);
});
test('dry-run exact captions/text conflicts and stale apply leave all selected bytes intact',{timeout:60000},async t=>{
 const {dir,v}=await setup(t);const s=await v.sceneSubtitlesInfo(id),g=await v.generateSubtitles(id,{contextHash:s.contextHash});await v.setSubtitles(id,{contextHash:s.contextHash,cues:[{start:2.5,end:3.5,text:'Corrected caption'}],style:'dark',sourceHash:g.draft.provenance.sourceHash,regenerate:true});
 const files=['storyboard.json',`assets/narration/${id}.wav`,`assets/takes/${id}/takes.json`,`scenes/${id}/scene.html`],before=files.map(p=>mediaHash(join(dir,p)));
 const d=await v.inspectRanges(id),p=await v.previewRange(id,{contextHash:d.contextHash,action:'keep',from:0,to:1});assert.equal(p.impact.canApply,false);assert.match(p.impact.errors.join(' '),/Caption 1.*Corrected caption.*3.5/);assert.deepEqual(files.map(p=>mediaHash(join(dir,p))),before);
 await assert.rejects(v.applyRange(id,{contextHash:d.contextHash,token:'missing'}),/expired/);
 const sub=await v.sceneSubtitlesInfo(id);await v.setSubtitles(id,{contextHash:sub.contextHash,cues:[],style:'dark'});
 const next=await v.inspectRanges(id),preview=await v.previewRange(id,{contextHash:next.contextHash,action:'remove',from:1,to:2});await v.updateScene(id,{title:'Changed target'});
 await assert.rejects(v.applyRange(id,{contextHash:preview.contextHash,token:preview.pending.token}),/changed/);
 await apply(v,'remove',1,2);await v.chooseTake(id,1);const conflict=await v.inspectRanges(id);assert.equal(conflict.canUndo,false);await assert.rejects(v.undoRange(id,{contextHash:conflict.contextHash}),/conflicts/);
});
test('recovery rolls back nullable selection and rejects managed symlink escapes while supporting root aliases',async t=>{
 const root=mkdtempSync(join(tmpdir(),'sl-range-storage-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'video'));symlinkSync(join(root,'video'),join(root,'alias'));
 assert.equal(noisePath(join(root,'alias'),'assets/test'),join(root,'video/assets/test'));
 writeFileSync(join(root,'outside'),'private');symlinkSync(join(root,'outside'),join(root,'video','escape'));assert.throws(()=>noisePath(join(root,'alias'),'escape'),/symlink/);
 writeFileSync(join(root,'video','good'),'new');mkdirSync(join(root,'video','.state/noise'),{recursive:true});writeFileSync(join(root,'video','backup'),'old');noiseWrite(join(root,'video','.state/noise/transaction.json'),{entries:[{target:'good',backup:'backup'},{target:'created',backup:null}]});writeFileSync(join(root,'video','created'),'partial');recoverNoise(join(root,'alias'));assert.equal(readFileSync(join(root,'video','good'),'utf8'),'old');assert.equal(mediaHash(join(root,'video','created')),null);
});
test('history completion gates mutations after selection, survives reopen, and does not duplicate scene versions',{timeout:60000},async t=>{
 const {dir,v,opts}=await setup(t);
 const beforeVersion=(await v.history.versions(id)).at(-1).v;
 const real=v.history.commitProject;v.history.commitProject=async()=>{throw new Error('injected project history failure');};
 const d=await v.inspectRanges(id),p=await v.previewRange(id,{contextHash:d.contextHash,action:'remove',from:1,to:2});
 const result=await v.applyRange(id,{contextHash:p.contextHash,token:p.pending.token});assert.equal(result.historyPending,true);assert.match(result.historyWarning,/selected.*pending/);
 const selected=mediaHash(join(dir,`assets/narration/${id}.wav`));
 await assert.rejects(v.updateScene(id,{title:'Must be gated'}),/injected/);await assert.rejects(v.sceneHtml(id),/injected/);
 assert.equal(mediaHash(join(dir,`assets/narration/${id}.wav`)),selected);
 assert.equal((await v.history.versions(id)).at(-1).v,beforeVersion+1,'scene commit succeeded before project failure');
 const reopened=await openVideo(dir,opts);assert.equal((await reopened.history.versions(id)).at(-1).v,beforeVersion+1);
 const html=await reopened.sceneHtml(id);assert.match(await reopened.history.fileAt(id,html.version),/data-duration="3"/);
 assert.equal((await reopened.inspectRanges(id)).canUndo,true);
 await reopened.undoRange(id,{contextHash:(await reopened.inspectRanges(id)).contextHash});
 assert.match((await reopened.sceneHtml(id)).html,/data-duration="4"/);
 // Ordinary HTML restore keeps current selected binary edit; binary undo remains separate.
 const binary=mediaHash(join(dir,`assets/narration/${id}.wav`));await reopened.restore(id,beforeVersion);assert.equal(mediaHash(join(dir,`assets/narration/${id}.wav`)),binary);
 v.history.commitProject=real;
});
test('prepared corruption, source replacement and concurrent apply reject without partial selection',{timeout:60000},async t=>{
 const {dir,v}=await setup(t);const audio=join(dir,`assets/narration/${id}.wav`),before=mediaHash(audio);
 const prepare=async()=>{const d=await v.inspectRanges(id);return v.previewRange(id,{contextHash:d.contextHash,action:'remove',from:.8,to:1.2});};
 const p=await prepare(),state=JSON.parse(readFileSync(join(dir,`.state/ranges/${id}.json`)));
 writeFileSync(join(dir,state.pending.base,'audio.wav'),'corrupt');await assert.rejects(v.applyRange(id,{contextHash:p.contextHash,token:p.pending.token}),/media changed/);assert.equal(mediaHash(audio),before);
 const q=await prepare();const results=await Promise.allSettled([v.applyRange(id,{contextHash:q.contextHash,token:q.pending.token}),v.applyRange(id,{contextHash:q.contextHash,token:q.pending.token})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const r=await prepare(),selected=mediaHash(audio);writeFileSync(join(dir,`assets/takes/${id}/1.wav`),'replaced source');await assert.rejects(v.applyRange(id,{contextHash:r.contextHash,token:r.pending.token}),/changed/);assert.equal(mediaHash(audio),selected);
});
test('camera marker sync, decoded selection and actual cut/dissolve exports agree; unaffected clips reused',{timeout:120000},async t=>{
 const {dir,v}=await setup(t,true);
 const {buildScene,buildWhole}=await import('../lib/assemble.mjs'),{renderClip}=await import('../lib/render.mjs'),{launch}=await import('../lib/chrome.mjs'),{pathToFileURL}=await import('node:url');
 const dims={width:160,height:90},evidence={};const art=process.env.SL_RANGE_ARTIFACT_DIR;
 if(art)mkdirSync(join(art,'video'),{recursive:true});
 await v.writeSceneHtml(id,{html:`<template><style>#root{position:absolute;inset:0}video{width:160px;height:90px}</style><div id="root" data-composition-id="${id}" data-duration="4"><video src="assets/cam/${id}.mp4" muted playsinline></video></div></template>`,model:'test'},'api');
 await v.createScene({id:'second',title:'Unchanged green',duration:1,transitionIn:{type:'cut'},html:'<template><style>#root{background:green}</style><div id="root" data-composition-id="second" data-duration="1"></div></template>'});
 await v.createScene({id:'third',title:'Unchanged white',duration:1,transitionIn:{duration:.6},html:'<template><style>#root{background:white}</style><div id="root" data-composition-id="third" data-duration="1"></div></template>'});
 // Distinct music and an SFX ensure mute affects the recording only.
 ff('-f','lavfi','-i','sine=frequency=1800:sample_rate=48000:duration=6',join(dir,'assets/music.wav'));await v.setMeta({music:'assets/music.wav'});
 mkdirSync(join(dir,'assets/sfx'),{recursive:true});ff('-f','lavfi','-i','sine=frequency=2400:sample_rate=48000:duration=0.1',join(dir,'assets/sfx/range-tone.wav'));
 const cueHtml=(await v.sceneHtml(id)).html.replace('<video src=', '<i data-sfx="range-tone@1.8"></i><video src=');await v.writeSceneHtml(id,{html:cueHtml,model:'test'},'api');
 const secondTone=join(dir,'other-voice.wav');ff('-f','lavfi','-i','sine=frequency=600:sample_rate=48000:duration=0.5',secondTone);await v.setNarrationAudio('second',{path:secondTone});
 await v.buildSoundtrack({lead:.2,loudness:'off'});
 const run=async name=>{const j=await v.render();const until=Date.now()+60000;while(v.getRender(j.job).state==='running'){if(Date.now()>until)throw new Error('render timeout');await new Promise(r=>setTimeout(r,25));}const r=v.getRender(j.job);assert.equal(r.state,'done',r.error);if(art)await import('node:fs').then(fs=>fs.copyFileSync(r.path,join(art,'video',name+'.mp4')));return r;};
 const raw=(file,t)=>ff('-ss',String(t),'-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-');
 const color=b=>{const sum=[0,0,0];for(let i=0;i<b.length;i++)sum[i%3]+=b[i];return sum.map(n=>n/(b.length/3));};
 const strongest=(x,a,b)=>[300,600,900,1800,2400].map(hz=>{let re=0,im=0;for(let i=Math.round(a*48000);i<Math.round(b*48000);i++){re+=x[i]*Math.cos(2*Math.PI*hz*i/48000);im+=x[i]*Math.sin(2*Math.PI*hz*i/48000);}return {hz,amplitude:2*Math.hypot(re,im)/Math.round((b-a)*48000)};}).toSorted((a,b)=>b.amplitude-a.amplitude);
 const baseline=await run('original');const baselineAudio=decode(baseline.path);evidence.recovery={originalTakeHash:mediaHash(join(dir,`assets/takes/${id}/1.mp4`)),selectedWaveformHash:mediaHash(join(dir,`assets/narration/${id}.wav`)),undo:[]};
 const browser=await launch(),page=await browser.newPage(dims);t.after(()=>browser.close());
 for(const [action,from,to] of [['remove',1,2],['mute',1,2],['keep',1,2]]){
   const state=await apply(v,action,from,to),r=await run(action),mix=decode(r.path),camera=join(dir,`assets/cam/${id}.mp4`);
   assert.equal(r.clips.cached,action==='mute'?3:2);assert.equal(r.clips.rendered,action==='mute'?0:1);
   const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',r.path]));assert.equal(Number(probe.streams.find(s=>s.codec_type==='video').nb_frames),Math.round(v.storyboard().duration*30));
   const expectation=action==='remove'?[[.5,300,'red'],[1.5,900,'blue']]:action==='keep'?[[.5,600,'green']]:[[.5,300,'red'],[1.5,1800,'green'],[2.5,900,'blue']];
   const measured=[];
   const build=buildScene(dir,v.storyboard(),id,(await v.sceneHtml(id)).html,`range-${action}`),single=join(dir,action+'-single.mp4');await renderClip(build,single,{...dims,fps:30,start:0,duration:state.duration});
   if(art)await import('node:fs').then(fs=>fs.copyFileSync(single,join(art,'video',action+'-single.mp4')));
   await page.goto(pathToFileURL(join(build,'index.html')).href);await page.evaluate('window.__sl.ready');
   for(const [time,hz,label] of expectation){
     const freq=strongest(mix,time-.05,time+.05);assert.equal(freq[0].hz,hz,`${action} at scene ${time}: ${JSON.stringify(freq)}`);
     const c=color(raw(camera,time)),exported=color(raw(r.path,time)),clip=color(raw(single,time));const channel={red:0,green:1,blue:2}[label];assert.equal(c.indexOf(Math.max(...c)),channel);assert.equal(exported.indexOf(Math.max(...exported)),channel);assert.equal(clip.indexOf(Math.max(...clip)),channel);
     await page.evaluate(`window.__sl.seek(${time})`);assert.ok(await page.evaluate('Math.abs(document.querySelector("video").currentTime-'+time+')<.04'));
     measured.push({sceneSeconds:time,recordingSeconds:time-.2,dominantHz:freq[0].hz,amplitude:freq[0].amplitude,cameraRgb:c,exportRgb:exported});
   }
   if(action==='mute'){assert.ok(rms(mix,1.4,1.7)>.005,'music remains audible in muted voice range');const spectrum=strongest(mix,1.4,1.7);assert.ok(spectrum.find(s=>s.hz===600).amplitude<.001);assert.ok(strongest(mix,1.82,1.88).find(s=>s.hz===2400).amplitude>.002,'SFX remains audible in voice mute');}
   const otherVoice=strongest(mix,state.duration+.3,state.duration+.4);assert.equal(otherVoice[0].hz,600,'other scene narration preserved');
   evidence[action]={impact:state.impact,frames:Number(probe.streams.find(s=>s.codec_type==='video').nb_frames),clips:r.clips,measured};
   await v.undoRange(id,{contextHash:(await v.inspectRanges(id)).contextHash});const restored=await run(action+'-undo');const decoded=decode(restored.path);evidence.recovery.undo.push({action,originalTakeHash:mediaHash(join(dir,`assets/takes/${id}/1.mp4`)),restoredWaveformHash:mediaHash(join(dir,`assets/narration/${id}.wav`))});assert.equal(decoded.length,baselineAudio.length);assert.ok(Math.abs(rms(decoded,.3,.8)-rms(baselineAudio,.3,.8))<.001);
 }
 // The preexisting mixed-chain defect is tested in both orders without hold snapshots.
 evidence.boundaries=[];
 for(const order of ['cut-dissolve','dissolve-cut']){
   await v.updateScene('second',{transitionIn:order==='cut-dissolve'?{type:'cut'}:{duration:.6}});
   await v.updateScene('third',{transitionIn:order==='cut-dissolve'?{duration:.6}:{type:'cut'}});
   const r=await run(order),sb=v.storyboard(),map={};for(const sc of sb.scenes)map[sc.id]=(await v.sceneHtml(sc.id)).html;
   const whole=buildWhole(dir,sb,map,order);await page.goto(pathToFileURL(join(whole,'index.html')).href);await page.evaluate('window.__sl.ready');
   for(const n of [119,120,121,126,137,149,150,151,156,167,179]){
     await page.evaluate(`window.__sl.seek(${n/30})`);const shot=join(dir,'boundary.png');writeFileSync(shot,await page.screenshot());const a=ff('-i',shot,'-f','rawvideo','-pix_fmt','rgb24','-'),b=raw(r.path,n/30);const mean=a.reduce((sum,x,i)=>sum+Math.abs(x-b[i]),0)/a.length;
     assert.ok(mean<5,`${order}, frame ${n}, mean RGB error ${mean}`);evidence.boundaries.push({order,frame:n,meanRgbError:mean});
   }
 }
 assert.deepEqual(page.errors,[]);
 if(art)writeFileSync(join(art,'measurements.json'),JSON.stringify(evidence,null,2));
});
test('history completion repairs an interrupted scene tag exactly once',{timeout:60000},async t=>{
 const {dir,v,opts}=await setup(t);const real=v.history.commitScene;let once=true;
 v.history.commitScene=async(...args)=>{const n=await real(...args);if(once&&n){once=false;execFileSync('git',['--git-dir',join(dir,'.history'),'tag','-d',`${id}/v${n}`]);throw new Error('interrupted before scene tag');}return n;};
 const d=await v.inspectRanges(id),p=await v.previewRange(id,{contextHash:d.contextHash,action:'remove',from:1,to:2});const r=await v.applyRange(id,{contextHash:p.contextHash,token:p.pending.token});assert.equal(r.historyPending,true);
 const old=(await v.history.versions(id)).at(-1).v,reopened=await openVideo(dir,opts);assert.equal((await reopened.history.versions(id)).at(-1).v,old+1);assert.match(await reopened.history.fileAt(id,old+1),/data-duration="3"/);
 await reopened.sceneHtml(id);assert.equal((await reopened.history.versions(id)).at(-1).v,old+1);
});
test('word/anchor impact, preserved corrected captions and precise saved text/motion conflicts',{timeout:60000},async t=>{
 const {dir,v}=await setup(t);const {withTexts}=await import('../lib/text.mjs'),{withMotion,pinMotion,inspectMotion}=await import('../lib/motion.mjs');
 const path=join(dir,`scenes/${id}/scene.html`);const base=`<template><style>#root{background:black}h1{animation-delay:1.2s}</style><div id="root" data-composition-id="${id}" data-duration="4"><h1 data-at="word:Two" data-sfx="tick@word:Two">Keep this heading</h1></div></template>`;
 await v.writeSceneHtml(id,{html:base,model:'test'},'api');
 const s=await v.sceneSubtitlesInfo(id),g=await v.generateSubtitles(id,{contextHash:s.contextHash});await v.setSubtitles(id,{contextHash:s.contextHash,cues:[{start:.2,end:.8,text:'Corrected wording'}],style:'light',sourceHash:g.draft.provenance.sourceHash,regenerate:true});
 const before=await v.sceneSubtitlesInfo(id),result=await apply(v,'remove',1.3,2);
 assert.equal(result.impact.affectedWords.length,1);assert.equal(result.impact.affectedWords[0].word,'Two');assert.equal(result.impact.captions.preserved,true);
 const after=await v.sceneSubtitlesInfo(id);assert.deepEqual(after.snapshot,before.snapshot);assert.equal(after.stale,true);
 await v.undoRange(id,{contextHash:(await v.inspectRanges(id)).contextHash});
 const p=await v.previewRange(id,{contextHash:(await v.inspectRanges(id)).contextHash,action:'remove',from:1,to:2});assert.equal(p.impact.anchors[0].resolved,false);assert.match(p.impact.anchors[0].warnings.join(' '),/not found/);assert.ok(p.impact.sfx[0].warning);
 let html=readFileSync(path,'utf8');html=withTexts(html,id,[{id:'text-late',text:'Late text',style:'dark',position:'lower',start:2,end:3.8}]);html=withMotion(html,id,[{id:'motion-late',target:'scene',start:3,duration:.5,effect:pinMotion(inspectMotion('fade-in'))}]);writeFileSync(path,html);
 const hash=mediaHash(path),r=await v.previewRange(id,{contextHash:(await v.inspectRanges(id)).contextHash,action:'keep',from:.5,to:1.5});assert.equal(r.impact.canApply,false);assert.match(r.impact.errors.join(' '),/text-late.*3.8/);assert.match(r.impact.errors.join(' '),/motion-late.*3.5/);assert.equal(mediaHash(path),hash);
});
test('shortening a scene that already truncates its recording requires explicit timing review',{timeout:60000},async t=>{
 const {v}=await setup(t);await v.updateScene(id,{duration:2});const d=await v.inspectRanges(id),p=await v.previewRange(id,{contextHash:d.contextHash,action:'remove',from:1,to:2});assert.equal(p.impact.canApply,false);assert.match(p.impact.errors.join(' '),/currently truncates narration/);assert.equal(v.storyboard().scenes[0].duration,2);
});
test('full range apply and undo support a symlink project ancestor',{timeout:60000},async t=>{
 const {root,dir,opts}=await setup(t);const alias=join(root,'project-alias');symlinkSync(dir,alias);const v=await openVideo(alias,opts),before=mediaHash(join(dir,`assets/narration/${id}.wav`));
 const r=await apply(v,'remove',.7,1.2);assert.ok(r.canUndo);await v.undoRange(id,{contextHash:(await v.inspectRanges(id)).contextHash});assert.equal(mediaHash(join(dir,`assets/narration/${id}.wav`)),before);
});
