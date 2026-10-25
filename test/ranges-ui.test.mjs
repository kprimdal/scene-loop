import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';
import {TEMPLATE_DIR} from '../lib/projects.mjs';
import {launch} from '../lib/chrome.mjs';
test('range controls preview all actions, survive reload, undo, and reject stale/detached targets at 1280/390',{timeout:90000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'sl-ranges-ui-'));cpSync(TEMPLATE_DIR,join(root,'scratch/videos/demo'),{recursive:true});
 const source=join(root,'source.wav');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','sine=frequency=300:sample_rate=48000:duration=3',source]);
 const port=await new Promise(r=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
 const browser=await launch({args:['--autoplay-policy=no-user-gesture-required']});
 try{
  while(!logs.includes('MCP:')){if(server.exitCode!==null)throw new Error(logs);await delay(30);}
  const page=await browser.newPage({width:1280,height:1000}),url=`http://127.0.0.1:${port}/?project=scratch&video=demo`;
  const wait=async code=>{const until=Date.now()+20000;while(!await page.evaluate(code)){if(Date.now()>until)throw new Error(code+': '+await page.evaluate('document.querySelector("#recordingRanges")?.textContent'));await delay(30);}};
  const click=sel=>page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`),named=text=>page.evaluate(`[...document.querySelectorAll('#recordingRanges button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  await page.goto(url);await wait('!!window.sceneLoop');await click('#recordingRanges summary');await wait('document.querySelector("#recordingRanges").textContent.includes("Choose a recorded take")');
  await page.evaluate(`(async()=>{await window.sceneLoop.update_scene({scene:'s01-intro',duration:4,model:'test'});await window.sceneLoop.add_take({scene:'s01-intro',path:${JSON.stringify(source)}});await window.sceneLoop.choose_take({scene:'s01-intro',take:1,keep:[[0,3]]});})()`);
  await named('Refresh recording');await wait('document.querySelector("#recordingRanges").textContent.includes("Current edited recording seconds")');
  const setRange=()=>page.evaluate(`(()=>{const [a,b]=document.querySelectorAll('#recordingRanges input');a.value=.7;b.value=1.2;a.dispatchEvent(new Event('input'));b.dispatchEvent(new Event('input'));})()`);
  await setRange();await named('Preview selected range');await wait('document.querySelector("#recordingRanges audio").currentTime>=.7');
  for(const action of ['Remove range','Mute range · voice only','Keep only range']){
    await wait('![...document.querySelectorAll("#recordingRanges button")].some(b=>b.disabled)');await setRange();await named(action);await wait('!!document.querySelector(".range-apply") && !document.querySelector(".range-apply").disabled');
    assert.ok(await page.evaluate('document.querySelector(".range-impact").textContent.includes("preserved tail")'));
    await named('Apply reviewed range');await wait('document.querySelector("#recordingRanges").textContent.includes("Undo previous recording edit") && ![...document.querySelectorAll("#recordingRanges button")].some(b=>b.disabled)');
    await page.goto(url);await wait('!!window.sceneLoop');await click('#recordingRanges summary');await wait('document.querySelector("#recordingRanges").textContent.includes("Undo previous recording edit")');
    await named('Undo previous recording edit');await wait('document.querySelector(".range-status").textContent.includes("restored") && ![...document.querySelectorAll("#recordingRanges button")].some(b=>b.disabled)');
  }
  // A detached apply control cannot select an earlier range after the numeric selection changes.
  await setRange();await named('Remove range');await wait('!!document.querySelector(".range-apply") && !document.querySelector(".range-apply").disabled');
  await page.evaluate('window.oldRangeApply=document.querySelector(".range-apply");document.querySelector("#recordingRanges input").value=.8;document.querySelector("#recordingRanges input").dispatchEvent(new Event("input"));window.oldRangeApply.click()');
  assert.equal((await page.evaluate('window.sceneLoop.inspect_recording_ranges({project:"scratch",video:"demo",scene:"s01-intro"})')).seconds,3);
  // Existing server token remains stale-safe after source-only/other-browser mutations.
  await page.evaluate('(async()=>{window.rangeContext=await window.sceneLoop.inspect_recording_ranges({project:"scratch",video:"demo",scene:"s01-intro"});await window.sceneLoop.update_scene({scene:"s01-intro",title:"New title",model:"test"});})()');
  const stale=await page.evaluate('(async()=>{try{await window.sceneLoop.preview_recording_range({project:"scratch",video:"demo",scene:"s01-intro",contextHash:window.rangeContext.contextHash,action:"remove",from:.7,to:1.2});return "wrong";}catch(e){return e.message;}})()');assert.match(stale,/changed/);
  await page.evaluate('window.sceneLoop.create_scene({id:"empty",title:"No recording",duration:2,model:"test"})');await wait('!!document.querySelector(".card[data-id=empty]")');
  await page.evaluate('window.oldRangeRefresh=[...document.querySelectorAll("#recordingRanges button")].find(b=>b.textContent==="Refresh recording");window.sceneLoop.show_scene({scene:"empty"})');await wait('document.querySelector("#recordingRanges").textContent.includes("Choose a recorded take")');await page.evaluate('window.oldRangeRefresh.click()');
  assert.equal(await page.evaluate('document.documentElement.scrollWidth'),1280);
  const mobile=await browser.newPage({width:390,height:844});await mobile.goto(url);while(!await mobile.evaluate('!!window.sceneLoop'))await delay(30);await mobile.evaluate('document.querySelector("#recordingRanges summary").click()');while(!await mobile.evaluate('document.querySelector("#recordingRanges").textContent.includes("Current edited recording seconds")'))await delay(30);
  assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);assert.deepEqual(page.errors,[]);assert.deepEqual(mobile.errors,[]);
 }finally{await browser.close();server.kill();if(server.exitCode===null)await new Promise(r=>server.once('exit',r));rmSync(root,{recursive:true,force:true});}
});

test('range tools are owner-only through HTTP and cannot select a candidate in another project',{timeout:30000},async t=>{
  const {createPeople}=await import('../lib/people.mjs');
  const root=mkdtempSync(join(tmpdir(),'sl-ranges-auth-'));for(const p of ['one','two'])cpSync(TEMPLATE_DIR,join(root,p,'videos/demo'),{recursive:true});
  const people=createPeople(join(root,'.people.json'));const guest=people.add({email:'reviewer@example.com',name:'Reviewer',role:'commenter',projects:['one']});
  const port=await new Promise(r=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});const base=`http://127.0.0.1:${port}`;
  const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:{...process.env,SCENE_LOOP_PASSWORD:'scratch password only',SCENE_LOOP_SECRET:'scratch-noise-http'},stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  t.after(async()=>{server.kill();if(server.exitCode===null)await new Promise(r=>server.once('exit',r));rmSync(root,{recursive:true,force:true});});
  while(!logs.includes('Login on')){if(server.exitCode!==null)throw new Error(logs);await delay(20);}
  const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({password:'scratch password only'})});assert.equal(login.status,302);const owner=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const guestLogin=await fetch(base+'/invite/'+guest.invite,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({password:'reviewer password only',again:'reviewer password only'})});assert.equal(guestLogin.status,302);const commenter=guestLogin.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const tool=(name,cookie,args={})=>fetch(base+'/api/tools/'+name+'?project=one&video=demo',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({args:{project:'one',video:'demo',scene:'s01-intro',...args}})});
  for(const name of ['inspect_recording_ranges','preview_recording_range','apply_recording_range','undo_recording_range'])assert.equal((await tool(name,commenter)).status,403,name);
  const response=await tool('inspect_recording_ranges',owner);assert.equal(response.status,200);assert.equal((await response.json()).supported,false);
  const source=join(root,'tone.wav');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','sine=frequency=220:duration=1',source]);
  for(const p of ['one','two']){
    assert.equal((await tool('add_take',owner,{project:p,video:'demo',path:source})).status,200);
    assert.equal((await tool('choose_take',owner,{project:p,video:'demo',take:1,keep:[[0,1]]})).status,200);
  }
  const inspected=await (await tool('inspect_recording_ranges',owner)).json();const preview=await (await tool('preview_recording_range',owner,{action:'mute',from:.2,to:.4,contextHash:inspected.contextHash})).json();assert.ok(preview.pending);
  const other=await tool('apply_recording_range',owner,{project:'two',video:'demo',contextHash:preview.contextHash,token:preview.pending.token});assert.notEqual(other.status,200);assert.match((await other.json()).error,/changed|expired/);
});
