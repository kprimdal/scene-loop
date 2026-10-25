import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRegistry, TEMPLATE_DIR } from '../lib/projects.mjs';
import { callTool, toolList } from '../lib/tools.mjs';
import { listGuides, inspectGuide } from '../lib/guides.mjs';
async function fixture() {
  const root=mkdtempSync(join(tmpdir(),'sl-guides-'));
  for(const [p,v] of [['one','demo'],['one','other'],['two','demo']]) cpSync(TEMPLATE_DIR,join(root,p,'videos',v),{recursive:true});
  writeFileSync(join(root,'one','project.md'),'# Public scratch project\nKeep the language plain. <img src=x onerror=alert(1)>\n');
  const registry=createRegistry(root,{reviewer:'Tester',emit(){}}), video=await registry.get('one','demo');
  const ctx={registry,via:'webmcp',origin:'http://localhost',defaults:{project:'one',video:'demo'}};
  const call=(name,args={})=>callTool(name,{project:'one',video:'demo',model:'Tester',...args},ctx);
  return {root,registry,video,ctx,call};
}
test('four useful full snapshots and one-time handoff without writes; all channels expose explicit targets', async()=>{
  const {video,ctx,call}=await fixture();
  assert.deepEqual(listGuides().map(p=>p.id),['explain-concept','show-workflow','improve-pacing','review-video']);
  for(const channel of ['page','mcp']) {
    const tools=toolList(channel);
    for(const name of ['list_guides','inspect_guide','use_guide_once','get_video_guides','attach_guide','remove_guide','undo_guides'])assert.ok(tools.some(t=>t.name===name));
    for(const name of ['attach_guide','remove_guide','undo_guides','use_guide_once'])assert.ok(tools.find(t=>t.name===name).inputSchema.required.includes('video'));
  }
  const before=await call('get_video_guides');
  for(const p of listGuides()){
    assert.ok(p.workflow.length>=4);assert.ok(p.example.tools.includes('get_stills'));assert.equal(p.checklist.length,4);assert.equal(p.contentHash.length,64);
    const inspected=await call('inspect_guide',{guide:p.id});assert.deepEqual(inspected,p);
    const once=await call('use_guide_once',{guide:p.id});assert.equal(once.persisted,false);assert.deepEqual(once.snapshot,p);
    assert.ok(once.prompt.includes(JSON.stringify(p,null,2)));assert.match(once.prompt,/project instructions and my rules take priority/);
  }
  assert.deepEqual(await call('get_video_guides'),before);assert.equal(existsSync(join(video.dir,'guides.json')),false);
  await assert.rejects(call('inspect_guide',{guide:'explain-concept',version:'99'}),/changed/);
  for(const name of ['use_guide_once','attach_guide','remove_guide','undo_guides'])await assert.rejects(callTool(name,{guide:'explain-concept',model:'Tester'},ctx),/explicitly/);
});
test('saved copies, isolated project-file history, bounded duplicates, stale contexts, removal/undo/reopen and unchanged unrelated files',async()=>{
  const {root,registry,video,call}=await fixture();
  const before=Object.fromEntries(['storyboard.json','AGENTS.md','theme.css','scenes/s01-intro/scene.html'].filter(f=>existsSync(join(video.dir,f))).map(f=>[f,readFileSync(join(video.dir,f),'utf8')]));
  const instructions=readFileSync(join(root,'one/project.md'),'utf8');
  const p=inspectGuide('explain-concept'), initial=await call('get_video_guides');
  await assert.rejects(call('attach_guide',{guide:p.id,contentHash:'old'}),/catalogue/);
  const saved=await call('attach_guide',{guide:p.id,version:p.version,contentHash:p.contentHash,contextHash:initial.contextHash});
  assert.equal(saved.items.length,1);assert.equal(saved.undoCount,1);
  assert.equal((await call('attach_guide',{guide:p.id,contextHash:saved.contextHash})).unchanged,true);
  await assert.rejects(call('remove_guide',{guide:p.id,contextHash:initial.contextHash}),/changed/);
  const rules=await call('get_rules');assert.equal(rules.instructions,instructions);assert.deepEqual(rules.guides,[p]);
  assert.ok(Object.keys(rules).indexOf('instructions')<Object.keys(rules).indexOf('guides'));assert.match(rules.guideContract,/take priority/);
  for(const args of [{project:'one',video:'other'},{project:'two',video:'demo'}])assert.equal((await call('get_video_guides',args)).items.length,0);
  for(const [file,text] of Object.entries(before))assert.equal(readFileSync(join(video.dir,file),'utf8'),text);
  assert.equal(readFileSync(join(root,'one/project.md'),'utf8'),instructions);
  const hist=await video.history.versions('project');assert.match(hist.at(-1).subject,/attach guide/);
  // A concurrent stale edit rejects inside the guide lock, including after an ABA undo.
  const outcomes=await Promise.allSettled(['show-workflow','review-video'].map(guide=>call('attach_guide',{guide,contextHash:saved.contextHash})));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
  await call('undo_guides');await assert.rejects(call('remove_guide',{guide:p.id,contextHash:saved.contextHash}),/changed/);
  // Later scene edits survive guide undo, and scene restore does not touch guides.
  const original=await video.sceneHtml('s01-intro');
  await call('write_scene_html',{scene:'s01-intro',html:original.html.replace('</template>','<!-- scratch edit --></template>'),resolves:[]});
  const edited=(await video.sceneHtml('s01-intro')).html;
  await call('remove_guide',{guide:p.id});assert.equal((await call('get_video_guides')).items.length,0);
  const reopened=await createRegistry(root,{reviewer:'Tester',emit(){}}).get('one','demo');
  assert.equal(reopened.guides().items.length,0);await reopened.changeGuides('undo',{model:'Tester',contextHash:reopened.guides().contextHash});
  assert.deepEqual(reopened.guides().items,[p]);assert.equal((await reopened.sceneHtml('s01-intro')).html,edited);
  await reopened.restore('s01-intro',original.version);assert.deepEqual(reopened.guides().items,[p]);
  for(const p of listGuides())await call('attach_guide',{guide:p.id});assert.equal(video.guides().items.length,4);
  for(let i=0;i<12;i++){await call('remove_guide',{guide:p.id});await call('attach_guide',{guide:p.id});}assert.equal(video.guides().undoCount,10);
  await assert.rejects(call('attach_guide',{guide:'unknown'}),/Unknown guide/);
});
test('catalogue edits do not rewrite saved guidance or recovery snapshots; failed history commit restores disk',async()=>{
  const {root,video,call}=await fixture();
  const saved=await call('attach_guide',{guide:'improve-pacing'});
  const copy=join(root,'copy');mkdirSync(join(copy,'lib'),{recursive:true});mkdirSync(join(copy,'catalog/guides'),{recursive:true});
  cpSync(new URL('../lib/guides.mjs',import.meta.url),join(copy,'lib/guides.mjs'));
  const data=listGuides().map(({contentHash,...p})=>p);data[2].version='2';data[2].guidance='Changed guidance';
  writeFileSync(join(copy,'catalog/guides/index.json'),JSON.stringify(data));
  const updated=await import(pathToFileURL(join(copy,'lib/guides.mjs')));
  assert.equal(updated.inspectGuide('improve-pacing').version,'2');
  const store=updated.createGuideStore(video.dir,video.history);
  assert.deepEqual(store.info().items,saved.items);
  await assert.rejects(store.change('attach',{guide:'improve-pacing'}),/older copy/);
  await store.change('remove',{guide:'improve-pacing'});await store.change('undo',{});assert.deepEqual(store.info().items,saved.items);
  const before=readFileSync(join(video.dir,'guides.json'),'utf8');
  const failing=updated.createGuideStore(video.dir,{commitProject:async()=>{throw new Error('history failed');}});
  await assert.rejects(failing.change('remove',{guide:'improve-pacing'}),/history failed/);assert.equal(readFileSync(join(video.dir,'guides.json'),'utf8'),before);
});
