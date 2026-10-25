import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync,mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { launch } from '../lib/chrome.mjs';
import { TEMPLATE_DIR } from '../lib/projects.mjs';
test('real motion controls apply cues, reject stale forms, remove/restore, reset/undo boundaries, and work at 390px', {timeout:60000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-motion-ui-'));
  for(const name of ['one','two'])cpSync(TEMPLATE_DIR,join(root,'project','videos',name),{recursive:true});
  const listener=createServer().listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});
  let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  const browser=await launch();
  try{
    while(!logs.includes('MCP:')){if(server.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,30));}
    const page=await browser.newPage({width:1280,height:1000});
    const wait=async code=>{const end=Date.now()+15000;while(!await page.evaluate(code)){if(Date.now()>end)throw new Error(`Wait ${code}: ${await page.evaluate('document.querySelector("#motionStatus")?.textContent')}`);await new Promise(r=>setTimeout(r,30));}};
    const click=sel=>page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const input=(sel,value)=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'));})()`);
    const base=`http://127.0.0.1:${port}`,url=`${base}/?library=1&section=motion&project=project&video=one`;
    await page.goto(url);await wait('!!window.sceneLoop && document.querySelector("#motionPreview").ready');
    assert.equal(await page.evaluate('document.querySelectorAll(".motion-example").length'),6);
    await click('[data-motion=cut] button');assert.match(await page.evaluate('document.querySelector("#motionForm").textContent'),/first scene/);
    // Build a timed synthetic scene through the same page tools before applying directly.
    await page.evaluate(`(async()=>{await window.sceneLoop.update_scene({scene:'s01-intro',narration:'Choose one idea. Read it now.',model:'UI test'});await window.sceneLoop.set_narration_words({scene:'s01-intro',words:[{word:'Choose',start:.2,end:.4},{word:'one',start:.4,end:.5},{word:'idea.',start:.5,end:.7},{word:'Read',start:1,end:1.2},{word:'it',start:1.2,end:1.3},{word:'now.',start:1.3,end:1.5}],adopt:false,model:'UI test'});})()`);
    await click('#motionCurrent button');await wait('!document.querySelector("#motionStatus").textContent.includes("Inspecting")');
    await click('[data-motion=rise] button');
    await input('[aria-label="Motion timing"]','word');await input('[aria-label="Narration cue"]','word:read');
    await click('#motionForm button[type=submit]');await wait('document.querySelector("#motionCurrent").textContent.includes("word:read → 1.35 s") && !document.querySelector("#motionForm button[type=submit]").disabled');
    assert.equal((await page.evaluate('window.sceneLoop.get_scene_html({scene:"s01-intro"})')).motions[0].anchor,'word:read');
    assert.equal(await page.evaluate('document.querySelector("#motionPreview")._frame.contentWindow.__motion[0].t'),1.35);
    const pinned=await page.evaluate('window.sceneLoop.get_scene_html({scene:"s01-intro"})');
    await click('.motion-saved button');await wait('document.querySelector("#motionCurrent").textContent.includes("No managed motion") && !document.querySelector("#motionForm button[type=submit]").disabled');
    await input('[aria-label="Restore scene version"]',String(pinned.version));
    await click('#motionCurrent > button:last-of-type');await wait('document.querySelector("#motionCurrent").textContent.includes("word:read → 1.35 s") && !document.querySelector("#motionForm button[type=submit]").disabled');
    // A stale closure from another video must do nothing even if invoked later.
    await page.evaluate('window.oldMotionSubmit=document.querySelector("#motionForm").onsubmit');
    await input('#motionVideo','1');await wait('document.querySelector("#motionCurrent").textContent.includes("No managed motion")');
    await page.evaluate('window.oldMotionSubmit(new Event("submit",{cancelable:true}))');
    assert.equal((await page.evaluate('window.sceneLoop.get_scene_html({project:"project",video:"two",scene:"s01-intro"})')).motions.length,0);
    await input('#motionVideo','0');await wait('document.querySelector("#motionCurrent").textContent.includes("word:read")');
    // Server stale-context protection rejects changes after the controls inspected the scene.
    await page.evaluate(`window.sceneLoop.write_scene_html({scene:'s01-intro',html:${JSON.stringify(pinned.html.replace('</style>','#root{outline:1px solid transparent}</style>'))},resolves:[],model:'UI test'})`);
    await click('[data-motion=pop] button');await click('#motionForm button[type=submit]');await wait('document.querySelector("#motionStatus").textContent.includes("changed")');
    assert.equal((await page.evaluate('window.sceneLoop.get_scene_html({scene:"s01-intro"})')).motions.length,1);
    await page.evaluate(`window.sceneLoop.create_scene({id:'second',title:'Second idea',duration:2,model:'UI test'})`);
    await page.goto(url);await wait('document.querySelector("#motionScene option[value=second]") && document.querySelector("#motionPreview").ready');
    await input('#motionScene','second');await wait('document.querySelector("#motionCurrent").textContent.includes("Incoming:")');
    await click('[data-motion=cut] button');await click('#motionForm button[type=submit]');await wait('document.querySelector("#motionCurrent").textContent.includes("Incoming: cut") && !document.querySelector("#motionForm button[type=submit]").disabled');
    await page.evaluate('[...document.querySelectorAll("#motionCurrent button")].find(b=>b.textContent==="Reset to default").click()');await wait('document.querySelector("#motionCurrent").textContent.includes("Incoming: dissolve") && !document.querySelector("#motionForm button[type=submit]").disabled');
    await page.evaluate('[...document.querySelectorAll("#motionCurrent button")].find(b=>b.textContent==="Undo transition").click()');await wait('document.querySelector("#motionCurrent").textContent.includes("Incoming: cut") && !document.querySelector("#motionForm button[type=submit]").disabled');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth'),1280);
    for(const tab of ['libStylesTab','libPatternsTab','libMusicTab','libMotionTab'])await click('#'+tab);
    const mobile=await browser.newPage({width:390,height:844});await mobile.goto(url);
    const end=Date.now()+15000;while(!await mobile.evaluate('document.querySelector("#motionPreview").ready')){if(Date.now()>end)throw new Error('mobile timeout');await new Promise(r=>setTimeout(r,30));}
    await mobile.evaluate('document.querySelector("[data-motion=pop] button").click()');
    assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);
    assert.deepEqual(page.errors,[]);assert.deepEqual(mobile.errors,[]);
  }finally{await browser.close();server.kill();await new Promise(r=>server.once('exit',r));}
});
