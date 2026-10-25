import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,cpSync,mkdirSync,readFileSync,writeFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRegistry,TEMPLATE_DIR } from '../lib/projects.mjs';
import { callTool,toolList } from '../lib/tools.mjs';
import { inspectMotion,listMotions,pinMotion,sceneMotion,withMotion,withoutMotion,validateMotion,resolveMotionTime,motionExample } from '../lib/motion.mjs';
import { buildScene,buildWhole,examplePage } from '../lib/assemble.mjs';
import { launch } from '../lib/chrome.mjs';
import { renderClip } from '../lib/render.mjs';
const html=(id,color='#2c5879')=>`<template><style>#root{background:${color};font-family:Arial;display:grid;place-items:center}#root .card{display:block;width:170px;height:80px;background:#e6c659;color:#18342c;font-size:24px;transform:rotate(8deg) translateX(8px);filter:brightness(.9)}#root h1{font-size:22px}</style><div id="root" data-composition-id="${id}" data-duration="2"><div class="card" data-motion-target="card" data-motion-label="Idea card">Read one idea</div><h1 data-sl-heading>A clear heading</h1></div></template>`;
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'sl-motion-'));
  for(const p of ['one','other'])cpSync(TEMPLATE_DIR,join(root,p,'videos','demo'),{recursive:true});
  const registry=createRegistry(root,{reviewer:'Tester',emit(){}}),video=await registry.get('one','demo');
  const call=(name,args={})=>callTool(name,{project:'one',video:'demo',scene:'s01-intro',model:'Tester',...args},{registry,via:'webmcp',origin:'http://localhost'});
  await call('write_scene_html',{html:html('s01-intro'),resolves:[]});
  return{root,registry,video,call};
}
const item=(effect='rise',more={})=>({id:'motion-test',target:'named:card',start:.4,duration:.5,effect:pinMotion(inspectMotion(effect)),...more});
test('bounded implemented catalog, serialized snapshots, safe timing/anchors/ids',()=>{
  assert.deepEqual(listMotions().map(p=>p.id),['fade-in','fade-out','rise','pop','cut','dissolve']);
  for(const p of listMotions())assert.match(examplePage(motionExample(p),p.kind==='transition'?{type:p.id,duration:p.duration}:null),/window\.__sl/);
  for(const extra of [{target:'#anything'},{target:'named:x"]'},{id:'x</script>'},{start:NaN},{start:-1},{duration:Infinity},{duration:0},{start:2},{anchor:'word:x"</script>'},{anchor:'sentence:0'},{anchor:'word:hello#0'}])assert.throws(()=>validateMotion([item('rise',extra)],2));
  for(const anchor of ['word:hello','word:Æble#2+0.25','sentence:2-0.2','word:soft-bristled|sentence:2'])assert.doesNotThrow(()=>validateMotion([item('rise',{anchor})],2));
  const saved=withMotion(html('first'),'first',[item()]);
  assert.deepEqual(sceneMotion(saved),[item()]);assert.equal(withoutMotion(saved),html('first'));
  const choice=item('fade-in',{anchor:'word:missing'});
  const fallback=resolveMotionTime(choice,2,()=>({t:.4,warnings:['missing, kept fallback']}));assert.equal(fallback.t,.4);assert.equal(fallback.warnings.length,1);
  assert.equal(resolveMotionTime(choice,2,()=>({t:1,warnings:[]})).t,1);
  assert.match(resolveMotionTime(choice,2,()=>({t:4,warnings:[]})).warnings[0],/outside/);
});
test('tools preserve authored/pattern/style/text state; stale contexts and incompatible target changes fail before writes; removal and restore',async()=>{
  const{video,registry,call}=await fixture();
  const other=await registry.get('other','demo'), untouched=(await other.sceneHtml('s01-intro')).html;
  for(const channel of ['page','mcp'])for(const name of ['list_motions','inspect_motion','get_scene_motion','apply_motion','remove_motion','apply_transition','reset_transition','undo_transition'])assert.ok(toolList(channel).some(t=>t.name===name));
  const p=await call('instantiate_pattern',{pattern:'process',inputs:{heading:'A new process',steps:['Choose','Make','Check']}});
  await call('apply_style',{scene:p.id,style:'paper'});
  await call('set_scene_text',{scene:p.id,items:[{id:'text-name',text:'Keep this title',position:'lower',style:'dark',start:.1,end:3}]});
  const original=await video.sceneHtml(p.id), info=await call('get_scene_motion',{scene:p.id});
  assert.ok(info.targets.some(t=>t.id==='heading'));assert.ok(info.targets.some(t=>t.id==='text:text-name'));
  const choice=await call('apply_motion',{scene:p.id,motion:'pop',target:'heading',start:1,contextHash:info.contextHash});
  const after=await video.sceneHtml(p.id);assert.deepEqual(after.pattern,original.pattern);assert.deepEqual(after.style,original.style);assert.deepEqual(after.texts,original.texts);assert.equal(after.motions.length,1);
  await assert.rejects(call('apply_motion',{scene:p.id,motion:'rise',contextHash:info.contextHash}),/changed/);
  await assert.rejects(call('apply_motion',{scene:p.id,motion:'rise',version:'99'}),/catalog/);
  await call('write_scene_html',{scene:p.id,html:withoutMotion(after.html).replace('A new process','An authored edit'),resolves:[]});
  assert.deepEqual((await video.sceneHtml(p.id)).motions,after.motions);
  const current=await video.sceneHtml(p.id);
  await assert.rejects(call('write_scene_html',{scene:p.id,html:current.html.replace('data-sl-heading','data-no-heading'),resolves:[]}),/Motion conflict/);
  assert.equal((await video.sceneHtml(p.id)).html,current.html);
  await call('apply_motion',{scene:p.id,motion:'fade-out',target:'text:text-name',start:2,duration:.4});
  await assert.rejects(call('set_scene_text',{scene:p.id,items:[]}),/Motion conflict/);
  await call('remove_motion',{scene:p.id,id:'all'});assert.equal((await video.sceneHtml(p.id)).motions.length,0);
  await video.restore(p.id,choice.version);assert.deepEqual((await video.sceneHtml(p.id)).motions,after.motions);
  assert.equal((await other.sceneHtml('s01-intro')).html,untouched);
  // Ordinary authored targets are label-driven; no selector injection, duplicate target or inline box.
  await assert.rejects(call('apply_motion',{motion:'rise',target:'named:nope'}),/Target missing/);
  await assert.rejects(call('apply_motion',{motion:'rise',target:'#root'}),/target/);
  const ordinary=await video.sceneHtml('s01-intro');
  for(const change of [s=>s.replace('class="card"','class="card" style="display:contents"'),s=>s.replace('</div><h1','<div style="position:fixed">fixed</div></div><h1'),s=>s.replace('filter:brightness(.9)','filter:opacity(1)!important'),s=>s.replace('transform:rotate','translate:3px!important;transform:rotate'),s=>s.replace('transform:rotate(8deg) translateX(8px);','').replace('filter:brightness(.9)','filter:none').replace('</div><h1','<div style="position:absolute">anchored outside</div></div><h1')]){
    await call('write_scene_html',{html:change(ordinary.html),resolves:[]});
    await assert.rejects(call('apply_motion',{motion:'rise',target:'named:card'}),/Motion conflict/);
    assert.equal((await video.sceneHtml('s01-intro')).motions.length,0);
  }
});
test('narration cues re-time with new words, missing/out-of-scene cues report fallback; pins outlive catalog edits',async()=>{
  const{root,video,registry,call}=await fixture();
  await call('update_scene',{narration:'Choose a word. Read it now.'});
  await call('set_narration_words',{words:[{word:'Choose',start:.2,end:.4},{word:'a',start:.4,end:.5},{word:'word.',start:.5,end:.7},{word:'Read',start:.8,end:1},{word:'it',start:1,end:1.1},{word:'now.',start:1.1,end:1.3}],adopt:false});
  await call('apply_motion',{motion:'rise',target:'named:card',start:.3,duration:.5,anchor:'word:Read'});
  const original=await video.sceneHtml('s01-intro');
  const a=await call('get_scene_motion');assert.equal(a.timing[0].t,1.15);
  const words=a.words.map(w=>({...w,start:w.start+.5,end:w.end+.5}));
  await call('set_narration_words',{words,adopt:false});
  const b=await call('get_scene_motion');assert.equal(b.timing[0].t,1.65);assert.equal((await video.sceneHtml('s01-intro')).html,original.html);
  await assert.rejects(call('apply_motion',{motion:'pop',contextHash:a.contextHash}),/changed/);
  await call('remove_narration_words');
  const missing=await call('get_scene_motion');assert.equal(missing.timing[0].t,.3);assert.match(missing.timing[0].warnings.join(' '),/not found/);
  assert.ok((await call('list_scenes')).scenes[0].motionWarnings.length);
  const copyRoot=join(root,'copy');mkdirSync(join(copyRoot,'lib'),{recursive:true});
  for(const file of ['motion.mjs','motion-runtime.mjs','chrome.mjs'])cpSync(new URL('../lib/'+file,import.meta.url),join(copyRoot,'lib',file));
  cpSync(new URL('../catalog',import.meta.url),join(copyRoot,'catalog'),{recursive:true});
  const file=join(copyRoot,'catalog/motion/index.json'),data=JSON.parse(readFileSync(file));data[2].version='2';data[2].keyframes[0].translate='0 900px';writeFileSync(file,JSON.stringify(data));
  const copy=await import(pathToFileURL(join(copyRoot,'lib/motion.mjs')));assert.equal(copy.inspectMotion('rise').version,'2');
  const reopened=await createRegistry(registry.root,{reviewer:'Tester',emit(){}}).get('one','demo');assert.deepEqual((await reopened.sceneHtml('s01-intro')).motions,original.motions);
  await assert.rejects(call('update_scene',{duration:.4}),/Edit or remove motion/);
});
test('transition direct choices use existing storyboard semantics, targeted undo/reset survive reopen and scene restore; first boundary and stale changes rejected',async()=>{
  const{video,registry,call}=await fixture();
  await assert.rejects(call('apply_transition',{transition:'cut'}),/first scene/);
  await video.createScene({id:'second',title:'Second',duration:2,html:html('second')});
  const info=await call('get_scene_motion',{scene:'second'}),beforeHtml=await video.sceneHtml('second');
  await call('apply_transition',{scene:'second',transition:'cut',contextHash:info.contextHash});
  assert.deepEqual(video.storyboard().scenes[1].transitionIn,{type:'cut'});
  assert.equal((await video.sceneHtml('second')).version,beforeHtml.version);
  await assert.rejects(call('apply_transition',{scene:'second',transition:'dissolve',contextHash:info.contextHash}),/changed/);
  await call('apply_transition',{scene:'second',transition:'dissolve',duration:.4});
  await call('undo_transition',{scene:'second'});assert.deepEqual(video.storyboard().scenes[1].transitionIn,{type:'cut'});
  await video.restore('second',1);assert.deepEqual(video.storyboard().scenes[1].transitionIn,{type:'cut'});
  await call('reset_transition',{scene:'second'});assert.equal(video.storyboard().scenes[1].transitionIn,null);
  const reopened=await createRegistry(registry.root,{reviewer:'Tester',emit(){}}).get('one','demo');
  await reopened.changeTransition('second',{},'undo');assert.deepEqual(reopened.storyboard().scenes[1].transitionIn,{type:'cut'});
  await call('update_scene',{scene:'second',transitionIn:{type:'dissolve',duration:.3}});await call('undo_transition',{scene:'second'});assert.deepEqual(video.storyboard().scenes[1].transitionIn,{type:'cut'});
  for(const duration of [NaN,-1,9])await assert.rejects(call('apply_transition',{scene:'second',transition:'dissolve',duration}),/duration/);
});
test('a scene named transition cannot deadlock boundary operations or later scene locks', {timeout:15000},async()=>{
  const{video,call}=await fixture();
  await video.createScene({id:'transition',title:'A legal scene name',duration:2,html:html('transition')});
  await video.createScene({id:'following',title:'Following scene',duration:2,html:html('following')});
  const boundary=id=>video.storyboard().scenes.find(s=>s.id===id).transitionIn;
  const cut=await call('apply_transition',{scene:'transition',transition:'cut'});
  assert.deepEqual(boundary('transition'),{type:'cut'});assert.equal(cut.undoCount,1);
  const undo=await call('undo_transition',{scene:'transition'});
  assert.equal(boundary('transition'),null);assert.equal(undo.undoCount,0);
  await call('apply_transition',{scene:'transition',transition:'dissolve',duration:.35});
  assert.deepEqual(boundary('transition'),{type:'dissolve',duration:.35});
  await call('reset_transition',{scene:'transition'});
  assert.equal(boundary('transition'),null);
  await call('undo_transition',{scene:'transition'});
  assert.deepEqual(boundary('transition'),{type:'dissolve',duration:.35});
  // Neither the shared boundary lock nor this scene's lock may remain blocked.
  await call('apply_transition',{scene:'following',transition:'cut'});
  assert.deepEqual(boundary('following'),{type:'cut'});
  const edited=await call('write_scene_html',{scene:'transition',html:html('transition').replace('Read one idea','Updated after transition'),resolves:[]});
  const inspected=await call('get_scene_motion',{scene:'transition'});
  assert.equal(inspected.scene,'transition');assert.equal(inspected.version,edited.version);
  assert.deepEqual(inspected.transition.effective,{type:'dissolve',duration:.35});
  assert.match((await video.sceneHtml('transition')).html,/Updated after transition/);
});
const raw=(file,frame)=>execFileSync('ffmpeg',['-v','error','-i',file,...(frame==null?[]:['-vf',`select=eq(n\\,${frame})`,'-frames:v','1']),'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:3000000});
const difference=(a,b)=>a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length;
test('all four effects seek/replay identically; additive motion retains authored transform/animation and text boundaries; actual clip frames match',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-motion-frames-')),browser=await launch(),dims={width:320,height:180};
  try{
    const page=await browser.newPage(dims);
    for(const effect of ['fade-in','fade-out','rise','pop']){
      let source=html('intro').replace('transform:rotate(8deg) translateX(8px);','transform:rotate(8deg) translateX(8px);animation:intro-authored 1.5s linear both;').replace('</style>','@keyframes intro-authored{from{transform:rotate(8deg) translateX(8px)}to{transform:rotate(18deg) translateX(18px)}}</style>');
      source=withMotion(source,'intro',[item(effect)]);
      const sb={...dims,fps:10,duration:2,scenes:[{id:'intro',start:0,duration:2}]},build=buildScene(root,sb,'intro',source,`effect-${effect}`);
      await page.goto(pathToFileURL(join(build,'index.html')).href);await page.evaluate('window.__sl.ready');
      assert.deepEqual(await page.evaluate('window.__motionErrors'),[]);
      const states=[];
      for(const t of [0,.4,.6,.9,2,.6,0]){
        await page.evaluate(`window.__sl.seek(${t})`);
        states.push(await page.evaluate('(()=>{const c=getComputedStyle(document.querySelector(".card"));return {filter:c.filter,translate:c.translate,scale:c.scale,transform:c.transform}})()'));
      }
      assert.deepEqual(states[2],states[5],'backward seek reproduces the exact mid-effect state');assert.deepEqual(states[0],states[6],'replay returns to start');
      assert.match(states[2].filter,/brightness\(0.9\) opacity\(/,'authored filter remains');assert.notEqual(states[0].transform,states[4].transform,'authored animation still plays');
      if(effect==='fade-out'){assert.match(states[0].filter,/opacity\(1\)/);assert.match(states[4].filter,/opacity\(0\)/);}else{assert.match(states[0].filter,/opacity\(0\)/);assert.match(states[4].filter,/opacity\(1\)/);}
      if(effect==='rise')assert.notEqual(states[2].translate,'0px');if(effect==='pop')assert.notEqual(states[2].scale,'1');
      const out=join(root,`${effect}.mp4`);await renderClip(build,out,{...dims,fps:10,duration:2});
      for(const n of [0,3,4,6,9,19]){
        await page.evaluate(`window.__sl.seek(${n/10})`);const shot=join(root,'still.png');writeFileSync(shot,await page.screenshot());const mean=difference(raw(shot),raw(out,n));assert.ok(mean<5,`${effect}, frame ${n}, mean ${mean}`);
      }
    }
    // Managed text's outer opacity keeps start/end authoritative; pop changes its inner box only.
    const {withTexts}=await import('../lib/text.mjs');
    const text=withTexts(html('intro'),'intro',[{id:'text-label',text:'A timed label',position:'lower',style:'dark',start:.5,end:1.5}]);
    const source=withMotion(text,'intro',[item('pop',{target:'text:text-label',start:.5})]);
    const build=buildScene(root,{...dims,duration:2,scenes:[{id:'intro',start:0,duration:2}]},'intro',source,'text');
    await page.goto(pathToFileURL(join(build,'index.html')).href);await page.evaluate('window.__sl.ready');
    for(const[t,opacity]of [[.4,'0'],[.6,'1'],[1.5,'0'],[.7,'1']]){await page.evaluate(`window.__sl.seek(${t})`);assert.equal(await page.evaluate('getComputedStyle(document.querySelector("[data-sl-text-item]")).opacity'),opacity);}
    assert.deepEqual(page.errors,[]);
  }finally{await browser.close();}
});
test('whole preview/export agree for scoped whole-scene backdrop, exact-end fades, two dissolves/cut, cache and synchronized audio', {timeout:60000},async()=>{
  const{video,call}=await fixture(),dims={width:320,height:180},fps=10;
  await video.setMeta({...dims,background:'#d44c29',soundtrack:'assets/pulse.wav'});
  const sbFile=join(video.dir,'storyboard.json'),sb0=JSON.parse(readFileSync(sbFile));sb0.fps=fps;writeFileSync(sbFile,JSON.stringify(sb0));
  mkdirSync(join(video.dir,'assets'),{recursive:true});
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-af',"volume=enable='lt(t,2)+gte(t,2.2)':volume=0",join(video.dir,'assets/pulse.wav')]);
  await call('update_scene',{duration:2});
  await video.createScene({id:'second',duration:2,html:html('second','#316f3d')});await video.createScene({id:'third',duration:2,html:html('third','#543b74')});
  await call('apply_motion',{motion:'fade-out',target:'scene',start:1.5,duration:.5});
  await call('apply_motion',{scene:'second',motion:'rise',target:'scene',start:0,duration:.6});
  await call('apply_motion',{scene:'third',motion:'pop',target:'named:card',start:0,duration:.5});
  const run=async()=>{const job=await video.render();for(let i=0;i<3000&&video.getRender(job.job).state==='running';i++)await new Promise(r=>setTimeout(r,10));const r=video.getRender(job.job);assert.equal(r.state,'done',r.error);return r;};
  await run();const cached=await run();assert.equal(cached.clips.cached,3);assert.equal(cached.clips.rendered,0);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',cached.path]));assert.equal(probe.streams.find(s=>s.codec_type==='video').nb_frames,'60');assert.ok(Math.abs(Number(probe.streams.find(s=>s.codec_type==='audio').duration)-6)<.05);
  const audio=execFileSync('ffmpeg',['-v','error','-i',cached.path,'-map','0:a','-f','f32le','-ac','1','-ar','48000','pipe:1'],{maxBuffer:2000000});
  const rms=(start,end)=>{let sum=0,n=0;for(let i=Math.floor(start*48000);i<end*48000;i++){sum+=audio.readFloatLE(i*4)**2;n++;}return Math.sqrt(sum/n);};assert.ok(rms(1.7,1.9)<.001);assert.ok(rms(2.04,2.12)>.02);assert.ok(rms(2.4,2.6)<.001,'pulse stays at original soundtrack position');
  const browser=await launch(),page=await browser.newPage(dims);
  const compare=async(render,frames)=>{
    const sb=video.storyboard(),map={};for(const s of sb.scenes)map[s.id]=(await video.sceneHtml(s.id)).html;
    const build=buildWhole(video.dir,sb,map,'whole-check');
    await page.goto(pathToFileURL(join(build,'index.html')).href);await page.evaluate('window.__sl.ready');
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector("[data-slot=third]")).backgroundColor'),'rgba(0, 0, 0, 0)','named-only scene keeps existing transparent slot');
    for(const n of frames){await page.evaluate(`window.__sl.seek(${n/fps})`);const shot=join(video.dir,'preview.png');writeFileSync(shot,await page.screenshot());const mean=difference(raw(shot),raw(render.path,n));assert.ok(mean<5,`whole frame ${n}, mean ${mean}`);}
    await page.evaluate('window.__sl.seek(2.2)');const a=await page.screenshot();await page.evaluate('window.__sl.seek(4.5)');await page.evaluate('window.__sl.seek(2.2)');assert.deepEqual(await page.screenshot(),a,'whole backward seek exact');
    assert.deepEqual(page.errors,[]);
  };
  try{
    await compare(cached,[0,14,15,18,19,20,21,23,25,26,39,40,41,43,46,59]);
    assert.ok(readdirSync(join(video.dir,'.build')).every(n=>!n.startsWith('render-')));
    await call('apply_transition',{scene:'third',transition:'cut'});const cut=await run();assert.equal(cut.clips.cached,3,'boundary-only change reuses scene clips');await compare(cut,[19,20,21,39,40,41,45,59]);
    await call('remove_motion',{scene:'second',id:'all'});
    const sb=video.storyboard(),map={};for(const s of sb.scenes)map[s.id]=(await video.sceneHtml(s.id)).html;
    const build=buildWhole(video.dir,sb,map,'without-backdrop');await page.goto(pathToFileURL(join(build,'index.html')).href);await page.evaluate('window.__sl.ready');
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector("[data-slot=second]")).backgroundColor'),'rgba(0, 0, 0, 0)','removing last whole-scene effect removes scoped backdrop');
  }finally{await browser.close();}
});
