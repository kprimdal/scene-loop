import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {TEMPLATE_DIR} from '../lib/projects.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('cleanup tools are owner-only through HTTP and cannot select a candidate in another project',{timeout:30000},async t=>{
  const {createPeople}=await import('../lib/people.mjs');
  const root=mkdtempSync(join(tmpdir(),'sl-noise-auth-'));for(const p of ['one','two'])cpSync(TEMPLATE_DIR,join(root,p,'videos/demo'),{recursive:true});
  const people=createPeople(join(root,'.people.json'));const guest=people.add({email:'reviewer@example.com',name:'Reviewer',role:'commenter',projects:['one']});
  const port=await new Promise(r=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});const base=`http://127.0.0.1:${port}`;
  const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:{...process.env,SCENE_LOOP_PASSWORD:'scratch password only',SCENE_LOOP_SECRET:'scratch-noise-http'},stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  t.after(async()=>{server.kill();if(server.exitCode===null)await new Promise(r=>server.once('exit',r));rmSync(root,{recursive:true,force:true});});
  while(!logs.includes('Login on')){if(server.exitCode!==null)throw new Error(logs);await delay(20);}
  const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({password:'scratch password only'})});assert.equal(login.status,302);const owner=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const guestLogin=await fetch(base+'/invite/'+guest.invite,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({password:'reviewer password only',again:'reviewer password only'})});assert.equal(guestLogin.status,302);const commenter=guestLogin.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const tool=(name,cookie,args={})=>fetch(base+'/api/tools/'+name+'?project=one&video=demo',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({args:{scene:'s01-intro',...args}})});
  for(const name of ['inspect_noise_cleanup','preview_noise_cleanup','keep_noise_cleanup','revert_noise_cleanup'])assert.equal((await tool(name,commenter)).status,403,name);
  const response=await tool('inspect_noise_cleanup',owner);assert.equal(response.status,200);assert.equal((await response.json()).supported,false);
  const source=join(root,'tone.wav');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','sine=frequency=220:duration=1',source]);
  for(const p of ['one','two']){
    assert.equal((await tool('add_take',owner,{project:p,video:'demo',path:source})).status,200);
    assert.equal((await tool('choose_take',owner,{project:p,video:'demo',take:1,keep:[[0,1]]})).status,200);
  }
  const inspected=await (await tool('inspect_noise_cleanup',owner)).json();const preview=await (await tool('preview_noise_cleanup',owner,{mode:'off',contextHash:inspected.contextHash})).json();assert.ok(preview.preview);
  const other=await tool('keep_noise_cleanup',owner,{project:'two',video:'demo',contextHash:preview.contextHash,token:preview.preview.token});assert.notEqual(other.status,200);assert.match((await other.json()).error,/changed|expired/);
});
