import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRegistry,TEMPLATE_DIR } from '../lib/projects.mjs';
import { callTool,toolList } from '../lib/tools.mjs';
import { deriveCues,sceneSubtitles,withSubtitles,withoutSubtitles,preserveSubtitles,pinSubtitles,validateCues } from '../lib/subtitles.mjs';
import { buildScene,buildWhole } from '../lib/assemble.mjs';
import { launch } from '../lib/chrome.mjs';
import { renderClip } from '../lib/render.mjs';
const words=[{word:'Hello,',start:.1,end:.4},{word:'verden!',start:.5,end:.85},{word:'Æble,',start:1,end:1.3},{word:'ø',start:1.3,end:1.5},{word:'og',start:1.5,end:1.7},{word:'å.',start:1.7,end:2}];
const cue=(more={})=>({text:'Hello, verden! Æble, ø og å.',start:.45,end:2.35,...more});
const authored=id=>`<template><style>#root{background:#264e68;font-family:Arial}#root h1{font-size:25px;padding:8%}</style><div id="root" data-composition-id="${id}" data-duration="4"><h1 data-sl-heading>Synthetic caption demo</h1></div></template>`;
async function fixture({symlink=false}={}) {
  const real=mkdtempSync(join(tmpdir(),'sl-subtitles-'));
  for(const p of ['one','other']) cpSync(TEMPLATE_DIR,join(real,p,'videos','demo'),{recursive:true});
  let root=real;
  if(symlink) {root=real+'-link';symlinkSync(real,root);}
  const registry=createRegistry(root,{reviewer:'Tester',emit(){}}),video=await registry.get('one','demo');
  const call=(name,args={})=>callTool(name,{project:'one',video:'demo',scene:'s01-intro',model:'Tester',...args},{registry,via:'page-js',origin:'http://localhost'});
  const inspect=()=>call('get_scene_subtitles');
  const save=async(cues,more={})=>{const i=await inspect();return call('set_scene_subtitles',{contextHash:i.contextHash,cues,...more});};
  const generate=async()=>{const i=await inspect();return call('generate_scene_subtitles',{contextHash:i.contextHash});};
  const seed=async()=>{await call('update_scene',{narration:words.map(w=>w.word).join(' ')});await call('set_narration_words',{words,adopt:false});};
  return{root,real,registry,video,call,inspect,save,generate,seed};
}

test('lead is applied once; bounded grouping respects words, sentence/gap/length and rejects overflow instead of clipping',()=>{
  const draft=deriveCues(words,.35,4);
  assert.deepEqual(draft,[{text:'Hello, verden!',start:.45,end:1.2},{text:'Æble, ø og å.',start:1.35,end:2.35}]);
  assert.equal(deriveCues(words,.8,4)[0].start,.9);
  assert.throws(()=>deriveCues(words,.35,2),/shortening/);
  assert.throws(()=>deriveCues([],0,4),/Timed narration words/);
  for(const bad of [[{word:'x',start:0,end:0}],[{word:'x',start:-1,end:1}],[{word:'x',start:NaN,end:1}], [{word:'x',start:0,end:1},{word:'y',start:.8,end:2}]]) assert.throws(()=>deriveCues(bad,.35,4),/timing/);
  const many=Array.from({length:60},(_,i)=>({word:'ord',start:i*.3,end:i*.3+.25}));
  const grouped=deriveCues(many,0,20);
  assert.ok(grouped.length>5 && grouped.every(c=>c.text.length<=72 && c.end-c.start<=5));
  assert.equal(deriveCues([{word:'one',start:0,end:.2},{word:'two',start:1,end:1.2}],0,2).length,2);
  for(const bad of [[cue({end:Infinity})],[cue({start:-1})],[cue({end:9})],[cue({text:'a'.repeat(85)})],[cue({text:'a\nb\nc'})],[cue({text:'\0'})],[cue(),cue()]]) assert.throws(()=>validateCues(bad,10));
});

test('escaped display text, scoped keyframes and exact pinned bytes survive later markup/style catalogue changes',()=>{
  const snapshot=pinSubtitles([cue({text:'</style><script>bad()</script> & ÆØÅ “yes”'})],4,'dark',{components:{},sourceHash:'test'});
  const base=authored('intro'), html=withSubtitles(base,'intro',snapshot);
  assert.deepEqual(sceneSubtitles(html),snapshot);
  assert.equal(withoutSubtitles(html),base);
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/sl-caption-intro-0/);
  const old=html.replace('background:#15202b!important','background:#010203!important');
  assert.equal(preserveSubtitles(base,old,'intro',4),old,'ordinary edits retain exact old implementation bytes');
  const pinned={...snapshot,style:{...snapshot.style,css:'old exact presentation'}};
  assert.deepEqual(pinSubtitles(snapshot.cues,4,'dark',snapshot.provenance,pinned).style,pinned.style);
});

test('tools keep narration, words, audio and other pins intact; history owns remove/restore; symlink roots work',async()=>{
  const f=await fixture({symlink:true}),{video,call,seed,generate,save,inspect}=f;
  await seed();
  const audio=join(video.dir,'fixture.wav');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2.3',audio]);
  await video.setNarrationAudio('s01-intro',{path:audio});
  await call('apply_style',{style:'paper'});
  await call('set_scene_text',{items:[{id:'text-lower',text:'Presenter',position:'lower',style:'light',start:0,end:3}]});
  await call('apply_motion',{motion:'rise',target:'text:text-lower',start:.2,duration:.5});
  const original=await video.sceneHtml('s01-intro');
  const files=['storyboard.json','assets/narration/s01-intro.words.json','assets/narration/s01-intro.wav','assets/narration/s01-intro.take.json'];
  const before=files.map(p=>readFileSync(join(video.dir,p)));
  const d=await generate();assert.equal(d.persisted,false);assert.equal((await inspect()).snapshot,null);
  d.draft.cues[0]={...d.draft.cues[0],text:'Hej, verden!',start:.5};
  const saved=await save(d.draft.cues,{style:'light',sourceHash:d.draft.provenance.sourceHash,regenerate:true});
  assert.equal(saved.snapshot.cues[0].text,'Hej, verden!');assert.equal(saved.snapshot.cues[0].start,.5);
  files.forEach((p,i)=>assert.deepEqual(readFileSync(join(video.dir,p)),before[i],p));
  await call('write_scene_html',{html:authored('s01-intro'),resolves:[]});
  const written=await video.sceneHtml('s01-intro');
  assert.deepEqual(written.subtitles,saved.snapshot);assert.deepEqual(written.texts,original.texts);assert.deepEqual(written.style,original.style);assert.deepEqual(written.motions,original.motions);
  const removed=await save([]);assert.equal(removed.snapshot,null);
  await call('restore_version',{version:saved.version});assert.deepEqual((await inspect()).snapshot,saved.snapshot);
  assert.equal((await call('get_scene_subtitles',{version:removed.version})).snapshot,null);
  assert.equal((await (await f.registry.get('other','demo')).sceneSubtitlesInfo('s01-intro')).snapshot,null);
  const reopened=createRegistry(f.root,{reviewer:'Tester',emit(){}});assert.deepEqual((await (await reopened.get('one','demo')).sceneSubtitlesInfo('s01-intro')).snapshot,saved.snapshot);
  for(const name of ['get_scene_subtitles','generate_scene_subtitles','set_scene_subtitles']) {
    assert.ok(toolList().find(t=>t.name===name));
    await assert.rejects(callTool(name,{scene:'s01-intro'},{registry:f.registry,via:'page-js'}),/both project and video/);
  }
});

test('source/script/lead/audio/take changes retain corrections and snapshot timing until explicit regenerate; stale context rejects',async()=>{
  const {video,call,seed,generate,save,inspect}=await fixture();await seed();
  const d=await generate();let saved=await save([cue({text:'My correction'})],{sourceHash:d.draft.provenance.sourceHash});
  const original=saved.snapshot;
  const stale=await inspect();
  await call('update_scene',{narration:'Changed script'});
  await assert.rejects(call('set_scene_subtitles',{contextHash:stale.contextHash,cues:[]}),/changed/);
  assert.ok((await inspect()).staleReasons.includes('script'));
  await save([cue({text:'Keep this correction'})]);
  assert.equal((await inspect()).snapshot.provenance.sourceHash,original.provenance.sourceHash);
  const wordFile=join(video.dir,'assets/narration/s01-intro.words.json');writeFileSync(wordFile,JSON.stringify(words.map(w=>({...w,start:w.start+.1,end:w.end+.1}))));
  assert.ok((await inspect()).staleReasons.includes('words'));
  const audio=join(video.dir,'short.wav');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','3',audio]);await video.setNarrationAudio('s01-intro',{path:audio});
  let i=await inspect();assert.ok(i.staleReasons.includes('audio'));assert.ok(i.staleReasons.includes('take'));
  await call('fit_scenes_to_narration',{lead:.6,tail:1});i=await inspect();assert.ok(i.staleReasons.includes('lead'));assert.equal(i.snapshot.cues[0].start,.45);
  const draft=await generate();assert.equal(draft.draft.cues[0].start,.8);
  await assert.rejects(save(draft.draft.cues,{sourceHash:'old',regenerate:true}),/source changed/);
  saved=await save(draft.draft.cues,{sourceHash:draft.draft.provenance.sourceHash,regenerate:true});assert.equal(saved.stale,false);
  await assert.rejects(call('set_scene_subtitles',{contextHash:i.contextHash,cues:[]}),/changed/);
});

test('duration shrink/fit and historical restore reject before mutation; missing timings explain prerequisite',async()=>{
  const {video,call,seed,save,generate,inspect}=await fixture();
  assert.equal((await inspect()).canGenerate,false);await assert.rejects(generate(),/Timed narration words/);
  await seed();const d=await generate();const saved=await save([cue()],{sourceHash:d.draft.provenance.sourceHash});
  const sb=readFileSync(join(video.dir,'storyboard.json'),'utf8');
  await assert.rejects(call('update_scene',{duration:2,narration:'must not change'}),/Edit or remove captions/);assert.equal(readFileSync(join(video.dir,'storyboard.json'),'utf8'),sb);
  const audio=join(video.dir,'short.wav');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','0.1',audio]);await video.setNarrationAudio('s01-intro',{path:audio});
  await assert.rejects(call('fit_scenes_to_narration',{lead:.1,tail:.1}),/Edit or remove captions/);assert.equal(readFileSync(join(video.dir,'storyboard.json'),'utf8'),sb);
  await save([]);await call('update_scene',{duration:2});await assert.rejects(call('restore_version',{version:saved.version}),/Edit or remove captions/);
});

test('single/whole/stills and cached cut/dissolve exports agree at decimal boundaries, exact end, backwards seek and portrait wrapping', {timeout:60000}, async()=>{
  const {video,call,seed,generate,save}=await fixture();await seed();
  const dims={width:320,height:180},fps=10;
  await video.setMeta({...dims,soundtrack:'assets/tone.wav'});
  const sbFile=join(video.dir,'storyboard.json'),sb=JSON.parse(readFileSync(sbFile));sb.fps=fps;writeFileSync(sbFile,JSON.stringify(sb));
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','5',join(video.dir,'assets/tone.wav')]);
  await call('update_scene',{duration:2});await call('write_scene_html',{html:authored('s01-intro'),resolves:[]});
  await video.createScene({id:'second',title:'Second',duration:2,html:authored('second'),transitionIn:{duration:.6}});
  await video.createScene({id:'third',title:'Third',duration:1,html:authored('third'),transitionIn:{type:'cut'}});
  // Known synthetic words, no transcription or paid voice. Shorten transcript fixture for the 2s scene.
  writeFileSync(join(video.dir,'assets/narration/s01-intro.words.json'),JSON.stringify(words.slice(0,2)));
  const d=await generate();await save([cue({start:.45,end:1,text:'Æble, ø og å.'}),cue({start:1.2,end:2,text:'Visible until exact end'})],{sourceHash:d.draft.provenance.sourceHash});
  const second=pinSubtitles([cue({start:0,end:2,text:'Second scene only'})],2,'light',d.draft.provenance);
  // Seed second source words via the ordinary tool and save through its public caption tools.
  await call('set_narration_words',{scene:'second',words:words.slice(0,2),adopt:false});
  const si=await call('get_scene_subtitles',{scene:'second'});
  await call('set_scene_subtitles',{scene:'second',contextHash:si.contextHash,cues:second.cues,style:'light',sourceHash:si.source.sourceHash});
  const map={};for(const s of video.storyboard().scenes)map[s.id]=(await video.sceneHtml(s.id)).html;
  const single=buildScene(video.dir,video.storyboard(),'s01-intro',map['s01-intro'],'caption-single');
  const whole=buildWhole(video.dir,video.storyboard(),map,'caption-whole');
  const browser=await launch(),page=await browser.newPage(dims);
  const raw=(file,n)=>execFileSync('ffmpeg',['-v','error','-i',file,...(n==null?[]:['-vf',`select=eq(n\\,${n})`,'-frames:v','1']),'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:2000000});
  const art=process.env.SL_SUBTITLE_ARTIFACT_DIR;
  if(art)mkdirSync(join(art,'video'),{recursive:true});
  try {
    await page.goto(pathToFileURL(join(single,'index.html')).href);await page.evaluate('window.__sl.ready');
    const visible=()=>page.evaluate('[...document.querySelectorAll("[data-sl-caption]")].filter(e=>getComputedStyle(e).opacity==="1" && getComputedStyle(e).visibility==="visible").map(e=>e.textContent.trim())');
    for(const [t,expected] of [[0,[]],[.449,[]],[.45,['Æble, ø og å.']],[.999,['Æble, ø og å.']],[1,[]],[1.2,['Visible until exact end']],[1.999,['Visible until exact end']],[2,[]],[.45,['Æble, ø og å.']],[0,[]]]){await page.evaluate(`window.__sl.seek(${t})`);assert.deepEqual(await visible(),expected);}
    const clip=join(video.dir,'single.mp4');await renderClip(single,clip,{...dims,start:0,duration:2,fps});
    const run=async()=>{const j=await video.render();for(let i=0;i<2000 && video.getRender(j.job).state==='running';i++)await new Promise(r=>setTimeout(r,10));const r=video.getRender(j.job);assert.equal(r.state,'done',r.error);return r;};
    const first=await run(),cached=await run();assert.equal(cached.clips.cached,3);assert.equal(cached.clips.rendered,0);
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',cached.path]));assert.equal(probe.streams.find(s=>s.codec_type==='video').nb_frames,'50');assert.ok(probe.streams.some(s=>s.codec_type==='audio'&&Number(s.duration)>=4.9));
    await page.goto(pathToFileURL(join(whole,'index.html')).href);await page.evaluate('window.__sl.ready');
    const evidence=[];
    for(const n of [0,4,5,9,10,12,19,20,21,23,25,26,39,40,41,49]) {
      await page.evaluate(`window.__sl.seek(${n/fps})`);
      const image=join(video.dir,`frame-${n}.png`);writeFileSync(image,await page.screenshot());
      const a=raw(image),b=raw(cached.path,n);const mean=a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length;
      assert.ok(mean<5,`frame ${n}: mean RGB difference ${mean}`);evidence.push({frame:n,seconds:n/fps,meanRgbDifference:mean});
      if(n<20){const c=raw(clip,n);const m=a.reduce((sum,v,i)=>sum+Math.abs(v-c[i]),0)/a.length;assert.ok(m<5,`single frame ${n}: ${m}`);}
    }
    assert.ok(readdirSync(join(video.dir,'.build')).every(n=>!n.startsWith('render-')));
    // The frozen exact-end picture is empty: outgoing captions must not bleed into the dissolve.
    await page.evaluate('window.__sl.seek(2.1)');assert.deepEqual(await visible(),['Second scene only']);
    await page.evaluate('window.__sl.seek(4)');assert.deepEqual(await visible(),[]);
    const long='Rødgrød med fløde — bilingual captions, punctuation & ÆØÅ. '+ 'X'.repeat(24);
    const tallSb={...video.storyboard(),width:360,height:640};
    const tallHtml=withSubtitles(authored('s01-intro'),'s01-intro',pinSubtitles([cue({start:0,end:2,text:long})],2,'dark',d.draft.provenance));
    const tall=buildScene(video.dir,tallSb,'s01-intro',tallHtml,'caption-portrait');
    const portrait=await browser.newPage({width:360,height:640});await portrait.goto(pathToFileURL(join(tall,'index.html')).href);await portrait.evaluate('window.__sl.ready');await portrait.evaluate('window.__sl.seek(1)');
    const rect=await portrait.evaluate('(()=>{const e=document.querySelector("[data-sl-caption] > div"),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,scroll:e.scrollWidth,width:e.clientWidth}})()');assert.ok(rect.left>=0&&rect.right<=360&&rect.top>=0&&rect.bottom<=640&&rect.scroll<=rect.width,JSON.stringify(rect));
    const portraitClip=join(video.dir,'portrait.mp4');await renderClip(tall,portraitClip,{width:360,height:640,start:0,duration:2,fps});
    const portraitStill=join(video.dir,'portrait-preview.png');writeFileSync(portraitStill,await portrait.screenshot());
    const pa=raw(portraitStill),pb=raw(portraitClip,10);const portraitMean=pa.reduce((sum,v,i)=>sum+Math.abs(v-pb[i]),0)/pa.length;assert.ok(portraitMean<5,`portrait RGB difference ${portraitMean}`);
    if(art){mkdirSync(join(art,'img'),{recursive:true});cpSync(portraitStill,join(art,'img/portrait-preview.png'));execFileSync('ffmpeg',['-v','error','-i',portraitClip,'-ss','1','-frames:v','1',join(art,'img/portrait-export.png'),'-y']);execFileSync('ffmpeg',['-v','error','-i',cached.path,'-ss','1.9','-frames:v','1',join(art,'img/landscape-export.png'),'-y']);cpSync(cached.path,join(art,'video/landscape.mp4'));cpSync(portraitClip,join(art,'video/portrait.mp4'));cpSync(clip,join(art,'video/single.mp4'));writeFileSync(join(art,'boundaries.json'),JSON.stringify({syntheticSource:true,frames:evidence,portrait:{...rect,meanRgbDifference:portraitMean},clips:cached.clips},null,2));}
    assert.deepEqual(page.errors,[]);assert.deepEqual(portrait.errors,[]);await portrait.close();
  }finally{await browser.close();}
});
