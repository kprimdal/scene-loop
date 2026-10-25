import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEMPLATE_DIR } from '../lib/projects.mjs';
import { createPeople } from '../lib/people.mjs';
import { MAX_REFERENCE_BYTES } from '../lib/references.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('owner-only reference HTTP: streaming uploads, no remote fetch, Range, private layouts, cleanup and forged/symlink denial',{timeout:120000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'sl-reference-http-'));
  for(const [p,v] of [['one','demo'],['two','demo']])cpSync(TEMPLATE_DIR,join(root,p,'videos',v),{recursive:true});
  cpSync(TEMPLATE_DIR,join(root,'legacy'),{recursive:true});
  const people=createPeople(join(root,'.people.json'));
  const guest=people.add({email:'reviewer@example.com',name:'Reviewer',role:'commenter',projects:['one','legacy']});
  const port=await new Promise(r=>{const s=createServer().listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>r(port));});});
  const base=`http://127.0.0.1:${port}`;
  const proc=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:{...process.env,SCENE_LOOP_PASSWORD:'scratch password only',SCENE_LOOP_SECRET:'scratch-reference-http'},stdio:['ignore','pipe','pipe']});
  let logs='';proc.stdout.on('data',d=>logs+=d);proc.stderr.on('data',d=>logs+=d);
  t.after(async()=>{proc.kill();if(proc.exitCode===null)await new Promise(r=>proc.once('exit',r));rmSync(root,{recursive:true,force:true});});
  for(let i=0;!logs.includes('Login on');i++){if(i>500||proc.exitCode!==null)throw new Error(logs);await delay(20);}
  const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({password:'scratch password only'})});
  assert.equal(login.status,302);
  const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const reviewerLogin=await fetch(base+'/invite/'+guest.invite,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({password:'reviewer password only',again:'reviewer password only'})});
  assert.equal(reviewerLogin.status,302);const reviewerCookie=reviewerLogin.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const get=(path,headers={})=>fetch(base+path,{headers:{Cookie:cookie,...headers},redirect:'manual'});
  const tool=async(name,args,auth=cookie)=>{const r=await fetch(base+'/api/tools/'+name,{method:'POST',headers:{Origin:base,Cookie:auth,'Content-Type':'application/json'},body:JSON.stringify({args})});return {status:r.status,data:await r.json()};};
  const meta={title:'Original scratch video',start:0,end:1,intent:'Observe the layout',tags:['scratch'],analysis:{observations:'User supplied note',provenance:'user'}};
  const source=join(root,'source.mp4');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p',source]);const bytes=readFileSync(source);
  const upload=async(project,metadata,data=bytes)=>fetch(base+'/api/references/upload?'+new URLSearchParams({project}),{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/x-scene-loop-reference'},body:Buffer.concat([Buffer.from(JSON.stringify({metadata,mime:'video/mp4'})+'\n'),data])});
  for(const project of ['one','legacy']){
    const before=(await tool('list_references',{project})).data;
    // More metadata than a URL safely carries, including Danish text.
    const uploadMeta={...meta,contextHash:before.contextHash,analysis:{observations:'Blå himmel. '.repeat(300),desiredQualities:'Layer separation. '.repeat(200),provenance:'user'}};
    const response=await upload(project,uploadMeta);assert.equal(response.status,200,await response.clone().text());
    const saved=await response.json(),item=saved.items[0],url=item.media.url;
    assert.deepEqual(Buffer.from(await (await get(url)).arrayBuffer()),bytes);
    assert.equal((await get(url,{Range:'bytes=0-19'})).headers.get('content-range'),`bytes 0-19/${bytes.length}`);
    const ranged=await get(url,{Range:'bytes=0-19'});assert.equal(ranged.status,206);assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),bytes.subarray(0,20));
    const suffix=await get(url,{Range:'bytes=-12'});assert.equal(suffix.status,206);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),bytes.subarray(-12));
    assert.equal((await get(url,{Range:'bytes=999999999-'})).status,416);assert.equal((await get(url,{Range:'bytes=20-10'})).status,416);assert.equal((await get(url,{Range:'bytes=0-1,3-4'})).status,416);
    assert.equal((await get(url)).headers.get('cache-control'),'private, no-store');
    assert.equal((await fetch(base+url,{method:'HEAD',headers:{Cookie:cookie}})).headers.get('content-length'),String(bytes.length));
    assert.equal((await fetch(base+url,{headers:{Cookie:reviewerCookie}})).status,404);
    assert.equal((await tool('list_references',{project},reviewerCookie)).status,403);
    assert.equal((await tool('inspect_reference',{project,reference:item.id},reviewerCookie)).status,403);
    assert.equal((await get(url.replace('/'+project+'/','/two/'))).status,404);
    const vd=project==='legacy'?join(root,project):join(root,project,'videos/demo');
    mkdirSync(join(vd,'assets'),{recursive:true});symlinkSync(join(root,project,'.references'),join(vd,'assets','private-alias'));
    const prefix=`/p/${project}/${project==='legacy'?'legacy':'demo'}/`;
    for(const path of ['.references/catalog.json','references.json','assets/private-alias/catalog.json','assets/private-alias/media/'+item.media.file])for(const auth of [cookie,reviewerCookie])assert.equal((await get(prefix+path,{Cookie:auth})).status,404);
    const previousFiles=readdirSync(join(root,project,'.references/media'));
    const invalid=await upload(project,{...meta,contextHash:saved.contextHash,end:9});assert.notEqual(invalid.status,200);assert.match(await invalid.text(),/duration/);
    const bad=await upload(project,{...meta,contextHash:saved.contextHash},Buffer.from('invalid'));assert.notEqual(bad.status,200);
    const stale=await upload(project,{...meta,contextHash:before.contextHash});assert.notEqual(stale.status,200);
    assert.deepEqual(readdirSync(join(root,project,'.references/media')),previousFiles);
    assert.equal((await fetch(base+'/api/references/upload?project='+project,{method:'POST',headers:{Origin:base,Cookie:reviewerCookie,'Content-Type':'video/mp4'},body:bytes})).status,403);
  }
  symlinkSync(join(root,'one'),join(root,'alias'));
  assert.equal((await tool('list_references',{project:'alias'})).status,200);
  const one=(await tool('list_references',{project:'one'})).data;
  const file=one.items[0].media.file;symlinkSync(source,join(root,'one','.references/media','00000000-0000-0000-0000-000000000000.mp4'));
  assert.equal((await get(`/api/references/alias/media/${file}`)).status,200);
  for(const project of ['..%2Fone','one%2F..%2Ftwo','unknown'])assert.equal((await get(`/api/references/${project}/media/${file}`)).status,404);
  assert.equal((await get('/api/references/one/media/00000000-0000-0000-0000-000000000000.mp4')).status,404);
  assert.equal((await get('/api/references/one/media/..%2Fcatalog.json')).status,404);
  // Source links are saved without touching a local HTTP origin.
  let hits=0;const remote=createServer((req,res)=>{hits++;res.end('not a video');}).listen(0,'127.0.0.1');await new Promise(r=>remote.once('listening',r));
  const link=await tool('save_reference',{...meta,project:'one',sourceUrl:`http://127.0.0.1:${remote.address().port}/source`,contextHash:one.contextHash});assert.equal(link.status,200);assert.equal(hits,0);await new Promise(r=>remote.close(r));
  // Declared oversized upload is rejected before a file is written.
  const oversized=await new Promise((ok,fail)=>{const req=request(base+'/api/references/upload?project=one',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'video/mp4','Content-Length':MAX_REFERENCE_BYTES+100000}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});req.on('error',fail);req.end();});assert.equal(oversized,413);
  // Chunked upload has the same byte bound. It may close the socket when the body exceeds it.
  const count=readdirSync(join(root,'one/.references/media')).length;
  const current=(await tool('list_references',{project:'one'})).data;
  await new Promise(resolve=>{const req=request(base+'/api/references/upload?project=one',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/x-scene-loop-reference'}},res=>{res.resume();res.on('end',resolve);});req.on('error',resolve);req.write(JSON.stringify({metadata:{...meta,contextHash:current.contextHash},mime:'video/mp4'})+'\n');let sent=0;const chunk=Buffer.alloc(1024*1024);const more=()=>{while(sent++<101){if(!req.write(chunk)){req.once('drain',more);return;}}req.end();};more();});
  await delay(100);assert.equal(readdirSync(join(root,'one/.references/media')).length,count);assert.equal((await tool('list_references',{project:'one'})).data.contextHash,current.contextHash);
});
