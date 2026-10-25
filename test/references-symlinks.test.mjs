// Registry-resolved roots are trusted aliases; symlinks inside private reference storage are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,cpSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,realpathSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn,execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRegistry,TEMPLATE_DIR } from '../lib/projects.mjs';
import { callTool } from '../lib/tools.mjs';

function fixture(topology) {
  const base=mkdtempSync(join(tmpdir(),'sl-reference-alias-'));
  let root,pr,vd,project='project',video='demo';
  if(topology==='project alias outside registry') {
    root=join(base,'registry');pr=join(base,'targets','project');vd=join(pr,'videos',video);
    cpSync(TEMPLATE_DIR,vd,{recursive:true});mkdirSync(root);symlinkSync(pr,join(root,project));
  } else if(topology==='root through symlinked ancestor') {
    const parent=join(base,'real-parent');pr=join(parent,'projects',project);vd=join(pr,'videos',video);
    cpSync(TEMPLATE_DIR,vd,{recursive:true});symlinkSync(parent,join(base,'alias-parent'));root=join(base,'alias-parent','projects');
  } else if(topology==='single video through symlinked ancestor') {
    project=video='single';pr=vd=join(base,'real-parent',video);
    cpSync(TEMPLATE_DIR,vd,{recursive:true});symlinkSync(join(base,'real-parent'),join(base,'alias-parent'));root=join(base,'alias-parent',video);
  } else {
    root=join(base,'registry');pr=join(root,project);vd=join(base,'targets','video');
    cpSync(TEMPLATE_DIR,vd,{recursive:true});mkdirSync(join(pr,'videos'),{recursive:true});symlinkSync(vd,join(pr,'videos',video));
  }
  writeFileSync(join(pr,'project.md'),'# Trusted scratch project\nKeep the project rules visible.');
  const registry=createRegistry(root,{reviewer:'Test',emit(){}});
  const ctx={registry,origin:'http://localhost',via:'mcp'};
  const call=(tool,args={})=>callTool(tool,{project,video,model:'Alias test',...args},ctx);
  return {base,root,pr,vd,project,video,registry,call};
}
const topologies=['project alias outside registry','root through symlinked ancestor','single video through symlinked ancestor','video alias outside project'];
const metadata={title:'Scratch source',intent:'Study the composition',start:.2,end:1,tags:['scratch'],analysis:{observations:'Generated blue frame',provenance:'user'}};

for(const topology of topologies)test(`trusted ${topology}: rules with/without attachments, import/media/history and unavailable diagnostics`,async t=>{
  const f=fixture(topology);t.after(()=>rmSync(f.base,{recursive:true,force:true}));
  const {call,pr,vd,project,video,registry}=f;
  const before=await call('get_rules');assert.match(before.instructions,/Keep the project rules/);assert.ok(before.agents);assert.equal(before.referenceStatus.available,true);assert.deepEqual(before.references,[]);
  mkdirSync(join(pr,'.references/inbox'),{recursive:true});
  const source=join(pr,'.references/inbox/source.mp4');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p',source]);
  const catalog=await call('list_references');
  const lexicalProject=(await registry.list()).find(p=>p.name===project).dir;
  const saved=await call('save_reference',{...metadata,path:join(lexicalProject,'.references/inbox/source.mp4'),contextHash:catalog.contextHash});const item=saved.items[0];
  const media=registry.references.mediaFile(project,item.media.file);assert.equal(media,realpathSync(media));assert.deepEqual(readFileSync(media),readFileSync(source));
  const state=await call('get_video_references');
  const attached=await call('attach_reference',{reference:item.id,contentHash:item.contentHash,contextHash:state.contextHash});
  const rules=await call('get_rules');assert.equal(rules.referenceStatus.available,true);assert.deepEqual(rules.references,attached.items);assert.equal(rules.instructions,before.instructions);assert.equal(rules.agents,before.agents);
  const reopened=createRegistry(f.root,{reviewer:'Test',emit(){}});
  const again=await callTool('get_rules',{project,video},{registry:reopened,via:'mcp',origin:'http://localhost'});assert.deepEqual(again.references,rules.references);
  const v=await registry.get(project,video);assert.ok((await v.history.versions('project')).some(x=>/reference attachment/.test(x.subject)));
  const history=execFileSync('git',['--git-dir',join(pr,'.history'),'log','--format=%s'],{encoding:'utf8'});assert.match(history,/create reference/);
  const attachmentFile=join(vd,'references.json'),original=readFileSync(attachmentFile);
  // A broken optional attachment read must not replace valid project rules with a tool error.
  writeFileSync(attachmentFile,'{');
  const broken=await call('get_rules');assert.equal(broken.instructions,before.instructions);assert.equal(broken.agents,before.agents);assert.equal(broken.references,null);assert.equal(broken.referenceStatus.available,false);assert.match(broken.referenceStatus.diagnostic,/Reference attachments unavailable/);
  await assert.rejects(call('get_video_references'),SyntaxError);writeFileSync(attachmentFile,original);
  // The trusted root alias must not authorize a symlink in the private attachment file.
  const outside=join(f.base,'outside-attachments.json');writeFileSync(outside,original);rmSync(attachmentFile);symlinkSync(outside,attachmentFile);
  const unsafe=await call('get_rules');assert.equal(unsafe.instructions,before.instructions);assert.equal(unsafe.references,null);assert.match(unsafe.referenceStatus.diagnostic,/symlink/);
  await assert.rejects(call('get_video_references'),/symlink/);
  await assert.rejects(call('detach_reference',{reference:item.id,contextHash:attached.contextHash}),/symlink/);
  rmSync(attachmentFile);writeFileSync(attachmentFile,original);
  // Both library directories and individual metadata/import/media links remain forbidden.
  const storage=join(pr,'.references'),moved=join(f.base,'moved-storage');renameSync(storage,moved);symlinkSync(moved,storage);
  assert.throws(()=>registry.references.list(project),/symlink/);assert.throws(()=>registry.references.mediaFile(project,item.media.file),/symlink/);
  rmSync(storage);renameSync(moved,storage);
  const catalogFile=join(storage,'catalog.json'),catalogBytes=readFileSync(catalogFile);writeFileSync(join(f.base,'outside-catalog.json'),catalogBytes);rmSync(catalogFile);symlinkSync(join(f.base,'outside-catalog.json'),catalogFile);
  await assert.rejects(call('list_references'),/symlink/);rmSync(catalogFile);writeFileSync(catalogFile,catalogBytes);
  const linkedImport=join(storage,'inbox/alias.mp4');symlinkSync(source,linkedImport);
  await assert.rejects(call('save_reference',{...metadata,path:'alias.mp4',contextHash:saved.contextHash}),/symlink/);
  const originalMedia=readFileSync(media);rmSync(media);symlinkSync(source,media);assert.throws(()=>registry.references.mediaFile(project,item.media.file),/symlink/);rmSync(media);writeFileSync(media,originalMedia);
  await call('save_reference',{...metadata,title:'Canonical import',path:realpathSync(source),contextHash:saved.contextHash});
  for(const forged of ['../project','project/../other','unlisted'])await assert.rejects(call('list_references',{project:forged}));
});

for(const topology of topologies)test(`HTTP on trusted ${topology}: assets/builds, reference Range and private alias denial`,{timeout:30000},async t=>{
  const f=fixture(topology);const {project,video,pr,vd}=f;
  const port=await new Promise(resolve=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const base=`http://127.0.0.1:${port}`;
  const server=spawn(process.execPath,['server.mjs',f.root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});
  let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  t.after(async()=>{server.kill();if(server.exitCode===null)await new Promise(r=>server.once('exit',r));rmSync(f.base,{recursive:true,force:true});});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;!logs.includes('MCP:');i++){if(i>400||server.exitCode!==null)throw new Error(logs);await wait(20);}
  const call=async(name,args={})=>{
    const response=await fetch(base+'/api/tools/'+name,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({args:{project,video,model:'Alias HTTP',...args}})});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  assert.deepEqual((await call('get_rules')).references,[]);
  const context=await call('list_references');
  const source=join(f.base,'source.mp4');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p',source]);
  const bytes=readFileSync(source);
  const response=await fetch(base+'/api/references/upload?'+new URLSearchParams({project}),{method:'POST',headers:{Origin:base,'Content-Type':'application/x-scene-loop-reference'},body:Buffer.concat([Buffer.from(JSON.stringify({metadata:{...metadata,contextHash:context.contextHash},mime:'video/mp4'})+'\n'),bytes])});
  assert.equal(response.status,200,await response.clone().text());const item=(await response.json()).items[0];
  const attached=await call('attach_reference',{reference:item.id,contentHash:item.contentHash,contextHash:(await call('get_video_references')).contextHash});
  assert.deepEqual((await call('get_rules')).references,attached.items);
  const media=await fetch(base+item.media.url,{headers:{Range:'bytes=0-19'}});assert.equal(media.status,206);assert.deepEqual(Buffer.from(await media.arrayBuffer()),bytes.subarray(0,20));
  const fileBase=base+`/p/${project}/${video}/`;
  mkdirSync(join(vd,'assets'),{recursive:true});writeFileSync(join(vd,'assets/ordinary.txt'),'ordinary asset');
  assert.equal(await (await fetch(fileBase+'assets/ordinary.txt')).text(),'ordinary asset');
  const build=await call('get_scene_html',{scene:'s01-intro'});assert.match(build.html,/<template/);
  const built=await fetch(base+'/api/build/whole?'+new URLSearchParams({project,video}));assert.equal(built.status,200);const buildUrl=(await built.json()).url;
  const page=await fetch(base+buildUrl);assert.equal(page.status,200);assert.match(await page.text(),/<!doctype html>/i);
  // A normal build's symlink back to assets must also survive the resolved-path guard.
  const assetUrl=new URL('assets/ordinary.txt',new URL(buildUrl,base));assert.equal(await (await fetch(assetUrl)).text(),'ordinary asset');
  symlinkSync(join(pr,'.references'),join(vd,'assets/private-reference-alias'));
  symlinkSync(join(vd,'references.json'),join(vd,'assets/private-snapshot.json'));
  for(const path of ['assets/private-reference-alias/catalog.json','assets/private-reference-alias/media/'+item.media.file,'assets/private-snapshot.json','references.json'])assert.equal((await fetch(fileBase+path)).status,404);
  const malicious=join(pr,'.references/media/00000000-0000-0000-0000-000000000000.mp4');symlinkSync(source,malicious);
  assert.equal((await fetch(base+`/api/references/${project}/media/00000000-0000-0000-0000-000000000000.mp4`)).status,404);
});
