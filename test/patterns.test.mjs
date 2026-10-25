import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { listPatterns, inspectPattern, validatePattern, patternHtml, patternExample, pinnedPattern, patternMedia } from '../lib/patterns.mjs';
import { createRegistry, TEMPLATE_DIR } from '../lib/projects.mjs';
import { callTool, toolList } from '../lib/tools.mjs';
import { buildScene, buildWhole, examplePage } from '../lib/assemble.mjs';
async function fixture() {
  const root=mkdtempSync(join(tmpdir(),'sl-patterns-'));
  for (const p of ['one','other']) cpSync(TEMPLATE_DIR,join(root,p,'videos','demo'),{recursive:true});
  const registry=createRegistry(root,{reviewer:'Tester',emit(){}}), video=await registry.get('one','demo');
  const call=(name,args={})=>callTool(name,{project:'one',video:'demo',model:'Tester',...args},{registry,via:'webmcp',origin:'http://localhost'});
  return {root,video,registry,call};
}
test('each pattern validates exact plain-text fields, counts and limits; escapes content and scopes motion',()=>{
  assert.equal(listPatterns().length,3);
  for (const p of listPatterns()) {
    assert.deepEqual(validatePattern(p),p.defaults);
    assert.throws(()=>validatePattern(p,{...p.defaults,extra:'x'}),/Unknown/);
    for (const f of p.fields) {
      assert.throws(()=>validatePattern(p,{...p.defaults,[f.key]:f.minItems?['x'.repeat(f.max+1),...Array(f.minItems-1).fill('x')]:'x'.repeat(f.max+1)}),/characters/);
      if (!f.optional) assert.throws(()=>validatePattern(p,{...p.defaults,[f.key]:f.minItems?[]:''}),/lines|characters/);
      if (f.minItems) assert.throws(()=>validatePattern(p,{...p.defaults,[f.key]:Array(f.maxItems+1).fill('x')}),/lines/);
    }
    const inputs={...p.defaults,heading:'New <script>& "Æble" 🎉'};
    for (const id of ['first','second']) {
      const html=patternHtml(p,{id,inputs,duration:6,width:540,height:960});
      assert.match(html,/New &lt;script&gt;&amp; &quot;Æble&quot;/);
      assert.doesNotMatch(html,/<script>/);
      assert.match(html,new RegExp(`@keyframes ${id}-rise`));
      assert.equal(pinnedPattern(html).inputs.heading,inputs.heading);
      assert.match(html,/data-width="540" data-height="960" data-duration="6"/);
    }
    assert.match(examplePage(patternExample(p)),/window\.__sl/);
    assert.throws(()=>patternHtml(p,{id:'bad id',inputs}),/Invalid/);
    assert.throws(()=>patternHtml(p,{id:'valid',inputs,duration:2}),/3–60/);
  }
  assert.doesNotMatch(patternExample(inspectPattern('presenter')),/<video|<img/,'stand-in makes no missing requests');
});
test('creation adapts each pattern, preserves existing scene/text/style/music; edit/restore retain provenance and use ordinary history',async()=>{
  const {video,registry,call}=await fixture();
  await call('apply_style',{style:'paper',scene:'s01-intro'});
  await call('set_scene_text',{scene:'s01-intro',items:[{id:'text-note',text:'Keep this',position:'lower',style:'dark',start:0,end:3}]});
  await video.updateScene('s01-intro',{narration:'Keep this narration',model:'Tester'});
  await video.setMeta({music:'assets/music/example.mp3',musicLibrary:'example',model:'Tester'});
  const before=await video.sceneHtml('s01-intro'), meta=video.storyboard();
  const listed=await call('list_patterns');
  assert.equal(listed.items.length,3);
  for (const p of listed.items) {
    const inspection=await call('inspect_pattern',{pattern:p.id});
    assert.equal(inspection.contentHash,p.contentHash);
    const inputs={...p.defaults,heading:`A different ${p.id} idea`};
    const r=await call('instantiate_pattern',{pattern:p.id,version:p.version,contentHash:p.contentHash,inputs,duration:5,narration:'A different narrated idea.'});
    const created=await video.sceneHtml(r.id);
    assert.equal(created.version,1);
    assert.deepEqual(created.pattern.inputs,inputs);
    assert.equal(created.pattern.version,p.version);
    assert.match(created.html,/A different/);
    assert.ok(!created.html.includes(p.defaults.heading));
    assert.equal((await call('list_scenes')).scenes.find(s=>s.id===r.id).pattern.contentHash,p.contentHash);
    assert.deepEqual((await call('get_rules')).patterns.find(s=>s.scene===r.id).pattern,created.pattern);
    await call('apply_style',{style:'grove',scene:r.id});
    await call('set_scene_text',{scene:r.id,items:[{id:'text-tag',text:'Retain text',position:'lower',style:'dark',start:0,end:2}]});
    const edited=await call('write_scene_html',{scene:r.id,html:`<template><style></style><div id="root" data-composition-id="${r.id}">Authored freely</div></template>`,resolves:[]});
    const current=await video.sceneHtml(r.id);
    assert.match(current.html,/Authored freely/);
    assert.deepEqual(current.pattern,created.pattern);
    assert.equal(current.style.id,'grove'); assert.equal(current.texts[0].text,'Retain text');
    await call('restore_version',{scene:r.id,version:1});
    assert.equal((await video.sceneHtml(r.id)).html,created.html);
    await call('restore_version',{scene:r.id,version:edited.version});
    assert.equal((await video.sceneHtml(r.id)).html,current.html);
    await assert.rejects(call('instantiate_pattern',{pattern:p.id,id:r.id}),/already exists/);
    await assert.rejects(call('instantiate_pattern',{pattern:p.id,contentHash:'changed'}),/changed/);
    await assert.rejects(call('instantiate_pattern',{pattern:p.id,version:'2.0.0'}),/changed/);
  }
  assert.deepEqual(await video.sceneHtml('s01-intro'),before);
  assert.equal(video.storyboard().music,meta.music); assert.equal(video.storyboard().musicLibrary,meta.musicLibrary);
  assert.deepEqual(video.storyboard().scenes[0],meta.scenes[0]);
  assert.equal((await (await registry.get('other','demo')).listScenes()).length,1);
  assert.ok(toolList().some(t=>t.name==='instantiate_pattern'&&t.inputSchema.properties.video));
});
test('snapshot survives catalog edits and reopen; preview/export read only authored HTML',async()=>{
  const {root,video,registry,call}=await fixture();
  const r=await call('instantiate_pattern',{pattern:'comparison',inputs:{...inspectPattern('comparison').defaults,heading:'A preserved snapshot'}});
  const original=await video.sceneHtml(r.id);
  mkdirSync(join(root,'lib'));cpSync(new URL('../lib/patterns.mjs',import.meta.url),join(root,'lib','patterns.mjs'));
  cpSync(new URL('../catalog',import.meta.url),join(root,'catalog'),{recursive:true});
  const copy=await import(pathToFileURL(join(root,'lib','patterns.mjs')));
  const file=join(root,'catalog','patterns','index.json'), next=JSON.parse(readFileSync(file));
  next[1].version='2.0.0';next[1].guidance='Different';next[1].defaults.heading='Catalog changed';writeFileSync(file,JSON.stringify(next));
  assert.equal(copy.inspectPattern('comparison').version,'2.0.0');
  const reopened=await createRegistry(registry.root,{reviewer:'Tester',emit(){}}).get('one','demo');
  assert.deepEqual((await reopened.sceneHtml(r.id)).pattern,original.pattern);
  const sb={...video.storyboard(),scenes:video.storyboard().scenes.filter(s=>s.id===r.id)};
  for (const build of [buildScene(video.dir,sb,r.id,original.html,'snapshot-scene'),buildWhole(video.dir,sb,{[r.id]:original.html},'snapshot-whole')]) {
    const html=readFileSync(join(build,'index.html'),'utf8');assert.match(html,/A preserved snapshot/);assert.doesNotMatch(html,/Catalog changed/);
  }
});
test('presenter media paths reject traversal, URLs, missing, corrupt, unsupported, and symlink escapes before any mutation',async()=>{
  const {root,video,call}=await fixture();
  mkdirSync(join(video.dir,'assets'),{recursive:true});
  writeFileSync(join(video.dir,'assets','bad.mp4'),'bad');writeFileSync(join(video.dir,'assets','bad.svg'),'<svg/>');
  writeFileSync(join(root,'outside.png'),'outside');symlinkSync(join(root,'outside.png'),join(video.dir,'assets','escape.png'));
  const before=video.storyboard().scenes.length;
  for (const media of ['../outside.png','assets/../outside.png','https://example.com/x.png','assets/missing.png','assets/bad.mp4','assets/bad.svg','assets/escape.png','/tmp/x.mp4']) {
    await assert.rejects(call('instantiate_pattern',{pattern:'presenter',inputs:{...inspectPattern('presenter').defaults,media}}),/media|assets|exist|decoded/);
    assert.equal(video.storyboard().scenes.length,before);
  }
  assert.throws(()=>patternMedia(video.dir,'assets/escape.png'),/inside/);
});
