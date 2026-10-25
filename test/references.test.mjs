import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRegistry, TEMPLATE_DIR } from '../lib/projects.mjs';
import { callTool, toolList } from '../lib/tools.mjs';
import { referenceMetadata, createReferenceAttachmentStore, MAX_REFERENCE_BYTES } from '../lib/references.mjs';
const meta={title:'Layered reveal',sourceUrl:'https://example.com/study',start:0,end:1,intent:'Study depth, not reconstruction',tags:['depth','reveal'],credit:'Original scratch footage',analysis:{observations:'A blue background',desiredQualities:'Calm reveal',gaps:'No camera solve',provenance:'agent'}};
function fixture(layout='project') {
  const root=mkdtempSync(join(tmpdir(),'sl-references-'));
  let dir=root,project='one',video='demo';
  if(layout==='project')for(const [p,v] of [['one','demo'],['one','other'],['two','demo']])cpSync(TEMPLATE_DIR,join(root,p,'videos',v),{recursive:true});
  else if(layout==='legacy'){video=project;cpSync(TEMPLATE_DIR,join(root,project),{recursive:true});}
  else{project=video=basename(root);cpSync(TEMPLATE_DIR,root,{recursive:true});}
  const pr=layout==='single'?root:join(root,project);writeFileSync(join(pr,'project.md'),'# Scratch rules\nProject rules always win.');
  const registry=createRegistry(dir,{reviewer:'Tester',emit(){}}),ctx={registry,via:'mcp',origin:'http://localhost',defaults:{project,video}};
  const call=(name,args={})=>callTool(name,{project,video,model:'Tester',...args},ctx);
  const list=()=>call('list_references');
  const change=async(name,args={})=>call(name,{contextHash:(await list()).contextHash,...args});
  const attach=async(name,reference,args={})=>call(name,{reference,contextHash:(await call('get_video_references')).contextHash,...args});
  return {root,pr,project,video,registry,ctx,call,list,change,attach};
}
for(const layout of ['project','legacy','single'])test(`references persist privately in ${layout} layout; snapshots, edits, update, recovery, media and history`,async t=>{
  const f=fixture(layout);t.after(()=>rmSync(f.root,{recursive:true,force:true}));
  const {call,change,attach,list,registry,pr,project,video}=f;
  if(layout==='project') {
    const style=(await call('list_styles')).items[0];await call('apply_style',{style:style.id,scene:'s01-intro'});
    await call('set_scene_text',{scene:'s01-intro',items:[{id:'text-study',text:'Keep this pin',position:'lower',style:'plain',start:0,end:2}]});
    await call('apply_motion',{scene:'s01-intro',motion:'pop',target:'scene',start:0,duration:.5});
    await call('attach_guide',{guide:'explain-concept'});
    await call('instantiate_pattern',{pattern:'process',id:'pinned-pattern',title:'Keep pattern',duration:4});
  }
  const otherRules=await call('get_rules');
  const vdir=registry.dirOfVideo(project,video),before=Object.fromEntries(['storyboard.json','AGENTS.md','theme.css','scenes/s01-intro/scene.html','scenes/pinned-pattern/scene.html'].filter(path=>existsSync(join(vdir,path))).map(path=>[path,readFileSync(join(vdir,path),'utf8')]));
  const inbox=join(pr,'.references/inbox');mkdirSync(inbox,{recursive:true});
  const source=join(inbox,'source.mp4');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p',source]);
  const original=readFileSync(source);
  const saved=await change('save_reference',{...meta,path:'source.mp4'}),r=saved.items[0];
  assert.equal(r.media.duration,2);assert.equal(r.range.timebase,'local-media');assert.equal(r.analysis.verified,false);
  const media=registry.references.mediaFile(project,r.media.file);assert.deepEqual(readFileSync(media),original);assert.deepEqual(readFileSync(source),original);
  await assert.rejects(change('edit_reference',{...meta,reference:r.id,end:3}),/duration/);
  const initial=await call('get_video_references');
  const a=await attach('attach_reference',r.id,{contentHash:r.contentHash});assert.equal(a.items.length,1);
  assert.equal((await attach('attach_reference',r.id,{contentHash:r.contentHash})).unchanged,true);
  await assert.rejects(attach('attach_reference',r.id,{contentHash:'wrong'}),/changed/);
  await assert.rejects(call('detach_reference',{reference:r.id,contextHash:initial.contextHash}),/changed/);
  if(layout==='project'){
    assert.equal((await call('get_video_references',{video:'other'})).items.length,0);
    await assert.rejects(call('attach_reference',{project:'two',video:'demo',reference:r.id,contextHash:initial.contextHash,contentHash:r.contentHash}),/Unknown/);
    await call('attach_reference',{video:'other',reference:r.id,contextHash:initial.contextHash,contentHash:r.contentHash});
  }
  const edited=(await change('edit_reference',{...meta,reference:r.id,start:.5,end:1.5,intent:'Changed intent'})).items[0];
  const pinned=await call('get_video_references');assert.deepEqual(pinned.items,a.items);assert.notEqual(edited.contentHash,r.contentHash);
  await assert.rejects(attach('attach_reference',r.id,{contentHash:edited.contentHash}),/explicitly/);
  const updated=await attach('update_reference_attachment',r.id,{contentHash:edited.contentHash});assert.equal(updated.items[0].intent,'Changed intent');
  const rules=await call('get_rules');assert.match(rules.instructions,/Project rules/);assert.match(rules.referenceContract,/take priority/);assert.deepEqual(rules.references,updated.items);for(const key of ['styles','motions','patterns','guides','agents','design','theme'])assert.deepEqual(rules[key],otherRules[key]);assert.ok(rules.references[0].media.url.startsWith('http://localhost/api/references/'));
  await change('remove_reference',{reference:r.id});assert.equal((await list()).items[0].removed,true);
  assert.deepEqual(readFileSync(media),original);assert.deepEqual((await call('get_video_references')).items,updated.items);
  await assert.rejects(attach('update_reference_attachment',r.id,{contentHash:edited.contentHash}),/Restore/);
  await attach('detach_reference',r.id);assert.equal((await call('get_video_references')).items.length,0);
  await attach('undo_reference_attachments');assert.deepEqual((await call('get_video_references')).items,updated.items);
  await attach('undo_reference_attachments');assert.deepEqual((await call('get_video_references')).items,a.items);
  await change('restore_reference',{reference:r.id});assert.equal((await list()).items[0].removed,false);
  const restoredHash=(await list()).contextHash;await change('undo_reference_library');assert.equal((await list()).items[0].removed,true);
  await assert.rejects(call('restore_reference',{reference:r.id,contextHash:restoredHash}),/changed/);
  const fresh=createRegistry(f.root,{reviewer:'Tester',emit(){}});assert.equal(fresh.references.list(project).items[0].removed,true);assert.deepEqual(fresh.references.attachmentInfo(project,video).items,(await registry.references.attachmentInfo(project,video)).items);
  for(const [path,text] of Object.entries(before))assert.equal(readFileSync(join(vdir,path),'utf8'),text);
  if(layout==='project')assert.equal((await call('get_video_references',{video:'other'})).items[0].intent,meta.intent);
  const v=await registry.get(project,video);assert.ok((await v.history.versions('project')).some(v=>/reference attachment/.test(v.subject)));
  const gitDir=join(pr,'.history');const tracked=execFileSync('git',['--git-dir',gitDir,'ls-files'],{encoding:'utf8'});assert.ok(!tracked.includes(r.media.file));assert.ok(!tracked.includes('source.mp4'));
  const b=readFileSync(join(vdir,'references.json'));
  const failing=createReferenceAttachmentStore(vdir,{commitProject:async()=>{throw new Error('history failed');}});
  await assert.rejects(failing.change('detach',{reference:r.id,contextHash:failing.info().contextHash}),/history failed/);assert.deepEqual(readFileSync(join(vdir,'references.json')),b);
});
test('bounded plain metadata, finite ranges, URLs, mandatory stale guards and explicit targets on every tool channel',async t=>{
  const f=fixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}));
  for(const invalid of [{start:NaN},{start:Infinity},{end:Infinity},{start:-1},{start:1},{end:0},{sourceUrl:'file:///etc/passwd'},{sourceUrl:'javascript:alert(1)'},{sourceUrl:'https://user:pass@example.com'},{title:'x'.repeat(161)},{tags:['x'.repeat(61)]},{analysis:{observations:'x'.repeat(4001)}},{analysis:{provenance:'machine'}}])assert.throws(()=>referenceMetadata({...meta,...invalid}));
  for(const channel of ['page','mcp'])for(const name of ['save_reference','edit_reference','remove_reference','restore_reference','undo_reference_library','attach_reference','update_reference_attachment','detach_reference','undo_reference_attachments']){
    const tool=toolList(channel).find(t=>t.name===name);assert.ok(tool.inputSchema.required.includes('project'));assert.ok(tool.inputSchema.required.includes('contextHash'));
    if(/attach|detach/.test(name))assert.ok(tool.inputSchema.required.includes('video'));
    await assert.rejects(callTool(name,{...meta},f.ctx));
  }
  const s=await f.list();await assert.rejects(f.call('save_reference',meta),/contextHash/);
  const results=await Promise.allSettled([1,2].map(i=>f.call('save_reference',{...meta,title:'Link '+i,contextHash:s.contextHash})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const item=(await f.list()).items[0];assert.equal(item.range.timebase,'source-unverified');assert.equal(item.range.verified,false);
  for(let i=0;i<12;i++)await f.change('edit_reference',{...meta,reference:item.id,title:'Revision '+i});assert.equal((await f.list()).undoCount,10);
});
test('import and access reject traversal, forged project names and symlink escapes without leaving private copies',async t=>{
  const f=fixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}));
  const inbox=join(f.pr,'.references/inbox');mkdirSync(inbox,{recursive:true});
  const outside=join(f.root,'outside.mp4');writeFileSync(outside,'not video');symlinkSync(outside,join(inbox,'escape.mp4'));
  for(const path of ['/etc/passwd','../../../outside.mp4','escape.mp4'])await assert.rejects(f.change('save_reference',{...meta,path}),/escape|symlink|ENOENT/);
  symlinkSync(f.pr,join(f.root,'alias'));
  for(const project of ['../one','alias','unknown','one/../two'])assert.throws(()=>f.registry.references.list(project));
  symlinkSync(join(f.pr,'videos','demo'),join(f.pr,'videos','alias'));assert.throws(()=>f.registry.references.attachmentInfo('one','alias'),/symlink/);
  // Failed video probe and out-of-duration selection remove partial/invalid media.
  writeFileSync(join(inbox,'bad.mp4'),'not video');await assert.rejects(f.change('save_reference',{...meta,path:'bad.mp4'}),/probeable/);
  assert.deepEqual(readdirSync(join(f.pr,'.references/media')),[]);
  writeFileSync(join(inbox,'huge.mp4'),'');execFileSync('truncate',['-s',String(MAX_REFERENCE_BYTES+1),join(inbox,'huge.mp4')]);await assert.rejects(f.change('save_reference',{...meta,path:'huge.mp4'}),/100 MiB/);
  assert.equal(existsSync(join(f.pr,'.references/catalog.json')),false);
});
