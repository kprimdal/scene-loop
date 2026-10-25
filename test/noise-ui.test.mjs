import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {TEMPLATE_DIR} from '../lib/projects.mjs';
import {launch} from '../lib/chrome.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('page cleanup: listen, exclusive playback, preview/reload/keep/revert, stale selection, Record and Library at 1280 and 390px',{timeout:90000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-noise-ui-'));cpSync(TEMPLATE_DIR,join(root,'scratch/videos/demo'),{recursive:true});
  const source=join(root,'source.wav');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i',"aevalsrc='0.02*(random(0)-0.5)+if(between(t,0.4,1.8),0.2*sin(2*PI*240*t),0)':s=48000:d=2.5",source]);
  const port=await new Promise(r=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  const browser=await launch({args:['--autoplay-policy=no-user-gesture-required']});
  try{
    while(!logs.includes('MCP:')){if(server.exitCode!==null)throw new Error(logs);await delay(30);}
    const page=await browser.newPage({width:1280,height:1000});
    const url=`http://127.0.0.1:${port}/?project=scratch&video=demo`;
    const wait=async(code)=>{const end=Date.now()+20000;while(!await page.evaluate(code)){if(Date.now()>end)throw new Error(`Wait ${code}: ${await page.evaluate('document.querySelector("#noiseCleanup")?.textContent')}`);await delay(30);}};
    const click=sel=>page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const named=text=>page.evaluate(`[...document.querySelectorAll('#noiseCleanup button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
    await page.goto(url);await wait('!!window.sceneLoop');
    await click('#noiseCleanup summary');await wait('document.querySelector("#noiseCleanup").textContent.includes("Choose a recorded take")');
    await page.evaluate(`(async()=>{await window.sceneLoop.add_take({scene:'s01-intro',path:${JSON.stringify(source)}});await window.sceneLoop.choose_take({scene:'s01-intro',take:1,keep:[[0,2.5]]});})()`);
    await named('Refresh recording');await wait('document.querySelector("#noiseCleanup").textContent.includes("In use: Gentle cleanup")');
    await named('Prepare preview');await wait('document.querySelector("#noiseCleanup").textContent.includes("Pending preview: Cleanup off")');
    assert.equal(await page.evaluate('document.querySelectorAll("#noiseCleanup audio").length'),4);
    await page.evaluate('document.querySelector("#noiseCleanup audio").play()');await delay(120);
    assert.ok(await page.evaluate('document.querySelector("#noiseCleanup audio").currentTime>0'));
    await page.evaluate('document.querySelectorAll("#noiseCleanup audio")[1].play()');
    assert.equal(await page.evaluate('document.querySelector("#noiseCleanup audio").paused'),true);
    await click('#playBtn');assert.equal(await page.evaluate('document.querySelectorAll("#noiseCleanup audio")[1].paused'),true);await click('#playBtn');
    await page.goto(url);await wait('!!window.sceneLoop');await click('#noiseCleanup summary');await wait('document.querySelector("#noiseCleanup").textContent.includes("Pending preview: Cleanup off")');
    await named('Keep cleanup off');await wait('document.querySelector("#noiseCleanup").textContent.includes("In use: Cleanup off (kept)") && ![...document.querySelectorAll("#noiseCleanup button")].some(b=>b.disabled)');
    await page.goto(url);await wait('!!window.sceneLoop');await click('#noiseCleanup summary');await wait('document.querySelector("#noiseCleanup").textContent.includes("Revert to prior gentle cleanup")');
    await named('Revert to prior gentle cleanup');await wait('document.querySelector("#noiseCleanup").textContent.includes("In use: Gentle cleanup (kept)") && ![...document.querySelectorAll("#noiseCleanup button")].some(b=>b.disabled)');
    // A context change after inspection is rejected by the API.
    await page.evaluate('window.sceneLoop.update_scene({scene:"s01-intro",title:"Changed while open",model:"UI test"})');
    // Explicit old API context from a stale inspected view cannot overwrite the change.
    await page.evaluate('(async()=>{window.staleNoise=await window.sceneLoop.inspect_noise_cleanup({scene:"s01-intro"});})()');
    await page.evaluate('window.sceneLoop.update_scene({scene:"s01-intro",title:"New title",model:"UI test"})');
    const result=await page.evaluate('(async()=>{try{await window.sceneLoop.preview_noise_cleanup({scene:"s01-intro",mode:"off",contextHash:window.staleNoise.contextHash});return "wrong";}catch(e){return e.message;}})()');assert.match(result,/changed/);
    await page.evaluate('window.sceneLoop.create_scene({id:"empty",title:"Empty scene",duration:2,model:"UI test"})');
    await wait('document.querySelector(".card[data-id=empty]")');
    await page.evaluate('window.oldNoiseButton=[...document.querySelectorAll("#noiseCleanup button")].find(b=>b.textContent==="Prepare preview")');
    await page.evaluate('window.sceneLoop.show_scene({scene:"empty"})');await wait('document.querySelector("#noiseCleanup").textContent.includes("Choose a recorded take")');
    await page.evaluate('window.oldNoiseButton.click()');assert.equal((await page.evaluate('window.sceneLoop.inspect_noise_cleanup({scene:"empty"})')).supported,false);
    await page.evaluate('window.sceneLoop.show_scene({scene:"s01-intro"})');await wait('document.querySelector("#noiseCleanup").textContent.includes("In use:")');
    await click('#recordBtn');await wait('document.querySelector("#recTakes")?.textContent.includes("Cleanup")');
    await page.evaluate('[...document.querySelectorAll("#recTakes button")].find(b=>b.textContent==="Cleanup").click()');await wait('document.querySelector(".noise-dialog")?.textContent.includes("Take 1")');
    await page.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"e",bubbles:true}))');assert.equal(await page.evaluate('!!document.querySelector("#recText textarea")'),false);
    await click('.noise-dialog > button');await page.evaluate('document.querySelector(".rec-bar button[title^=Close]").click()');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth'),1280);
    const mobile=await browser.newPage({width:390,height:844});await mobile.goto(url);
    const end=Date.now()+20000;while(!await mobile.evaluate('!!window.sceneLoop')){if(Date.now()>end)throw new Error('mobile');await delay(30);}
    await mobile.evaluate('document.querySelector("#noiseCleanup summary").click()');
    while(!await mobile.evaluate('document.querySelector("#noiseCleanup").textContent.includes("In use:")'))await delay(30);
    assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);
    await mobile.evaluate('document.querySelector("#recordBtn").click()');
    while(!await mobile.evaluate('document.querySelector("#recTakes")?.textContent.includes("Cleanup")'))await delay(30);
    await mobile.evaluate('[...document.querySelectorAll("#recTakes button")].find(b=>b.textContent==="Cleanup").click()');
    while(!await mobile.evaluate('document.querySelector(".noise-dialog")?.textContent.includes("Take 1")'))await delay(30);
    assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);
    await mobile.evaluate('document.querySelector(".noise-dialog > button").click();document.querySelector(".rec-bar button[title^=Close]").click()');
    await page.goto(`http://127.0.0.1:${port}/?library=1&project=scratch&video=demo`);await wait('!!document.querySelector("#libMusicTab")');await click('#libMusicTab');
    assert.deepEqual(page.errors,[]);assert.deepEqual(mobile.errors,[]);
  }finally{await browser.close();server.kill();if(server.exitCode===null)await new Promise(r=>server.once('exit',r));rmSync(root,{recursive:true,force:true});}
});

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
