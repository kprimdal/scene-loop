// Real page controls and page tools; public-safe template copies and original generated footage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn,execFileSync } from 'node:child_process';
import { launch } from '../lib/chrome.mjs';
import { TEMPLATE_DIR } from '../lib/projects.mjs';

test('references page: file/link, range playback, search/tags, saved snapshots, update/detach/undo, async target switches, mobile and tabs',{timeout:120000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-reference-ui-'));
  for(const [p,v] of [['one','first'],['one','second'],['two','first']])cpSync(TEMPLATE_DIR,join(root,p,'videos',v),{recursive:true});
  for(const p of ['one','two'])writeFileSync(join(root,p,'project.md'),'# Scratch rules\nProject instructions win. <img src=x onerror="window.injected=true">');
  const source=join(root,'original.mp4');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p',source]);
  const listener=createServer().listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  const browser=await launch();
  try{
    const page=await browser.newPage({width:1280,height:1000});
    const wait=async code=>{const end=Date.now()+20000;while(!await page.evaluate(code)){if(Date.now()>end)throw new Error(`Wait: ${code}; ${logs}; ${JSON.stringify(await page.evaluate('(Array.from(document.querySelectorAll("#referenceDetail video")).map(v=>({t:v.currentTime,paused:v.paused,error:v.error?.message,duration:v.duration,ready:v.readyState,text:v.parentElement.textContent})))'))}`);await new Promise(r=>setTimeout(r,30));}};
    const click=sel=>page.send('Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(sel)}).click()`,userGesture:true,awaitPromise:true});
    const fill=(sel,value)=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input'));})()`);
    const choose=(sel,value)=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'));})()`);
    while(!logs.includes('MCP:')){if(server.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,30));}
    const url=`http://127.0.0.1:${port}/?library=1&section=references&project=one&video=first`;
    await page.goto(url);await wait('!document.querySelector("#referenceNew").disabled && !document.querySelector("#referenceLibrary").hidden && document.querySelector("#referenceScope").textContent.includes("one / first") && !!window.sceneLoop');
    await click('#referenceNew');
    const {root:dom}=await page.send('DOM.getDocument');const {nodeId}=await page.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'#referenceFile'});await page.send('DOM.setFileInputFiles',{nodeId,files:[source]});
    await wait('document.querySelector("#referenceDetail video")?.duration===2');
    await fill('#ref-title','Original blue study <img src=x onerror="window.injected=true">');await fill('#ref-intent','Carry forward calm pacing.');await fill('#ref-tags','calm, colour');
    await fill('#ref-observations','Blue background; supplied by the test.');await fill('#ref-desiredQualities','Calm pacing.');await fill('#ref-gaps','No camera solve.');
    await fill('#ref-start','0.2');await fill('#ref-end','0.6');
    await page.evaluate(`window.uploadFetch=window.fetch;window.fetch=async(...a)=>{if(String(a[0]).includes('/api/references/upload'))await new Promise(r=>window.releaseUpload=r);return window.uploadFetch(...a);}`);
    await click('#referenceForm button[type=submit]');await wait('!!window.releaseUpload');
    assert.equal(await page.evaluate('document.querySelector("#referenceProject").disabled && document.querySelector("#referenceVideo").disabled'),true);
    await page.evaluate('window.releaseUpload();window.fetch=window.uploadFetch');
    await wait('!document.querySelector("#referenceForm") && !!document.querySelector("[data-reference]")');
    const id=await page.evaluate('document.querySelector("[data-reference]").dataset.reference');
    assert.equal(await page.evaluate('!!window.injected || !!document.querySelector("#referenceDetail img")'),false);
    await page.evaluate('document.querySelector("#referenceRules summary").click()');assert.equal(await page.evaluate('!!document.querySelector("#referenceRules img")'),false);
    await click('#referenceDetail .reference-actions button'); // selected range playback
    await wait('document.querySelector("#referenceDetail video").paused && document.querySelector("#referenceDetail video").currentTime>=.6');
    assert.ok(Math.abs(await page.evaluate('document.querySelector("#referenceDetail video").currentTime')-.6)<.01);
    await page.evaluate('document.querySelector("#referenceDetail input[type=checkbox]").checked=true');await click('#referenceDetail .reference-actions button');await wait('!document.querySelector("#referenceDetail video").paused');
    await click('#referenceDetail .reference-actions button:nth-child(2)');assert.equal(await page.evaluate('document.querySelector("#referenceDetail video").paused'),true);
    await click('#referenceDetail [data-attach]');await wait('!!document.querySelector("[data-attached-reference]")');
    const firstRules=await page.evaluate('window.sceneLoop.get_rules({project:"one",video:"first"})');assert.equal(firstRules.references[0].range.start,.2);assert.equal(firstRules.references[0].range.end,.6);assert.equal(firstRules.references[0].analysis.gaps,'No camera solve.');assert.match(firstRules.instructions,/Project instructions/);
    await page.goto(url);await wait('!!document.querySelector("[data-attached-reference]") && !document.querySelector("#referenceNew").disabled');
    await fill('#referenceSearch','no match');assert.equal(await page.evaluate('document.querySelectorAll("[data-reference]").length'),0);await fill('#referenceSearch','calm');assert.equal(await page.evaluate('document.querySelectorAll("[data-reference]").length'),1);
    await choose('#referenceTag','colour');assert.equal(await page.evaluate('document.querySelectorAll("[data-reference]").length'),1);
    await click('[data-reference] button');await click('#referenceDetail [data-write]');await fill('#ref-intent','Explicitly revised intent');await fill('#ref-end','1.2');await click('#referenceForm button[type=submit]');await wait('!document.querySelector("#referenceForm")');
    assert.deepEqual((await page.evaluate('window.sceneLoop.get_rules({project:"one",video:"first"})')).references,firstRules.references);
    assert.match(await page.evaluate('document.querySelector("#referenceDetail [data-attach]").textContent'),/Update attachment explicitly/);
    await click('#referenceDetail [data-attach]');await wait('document.querySelector("#referenceStatus").textContent.includes("Exact reference snapshot")');
    const updated=await page.evaluate('window.sceneLoop.get_rules({project:"one",video:"first"})');assert.equal(updated.references[0].intent,'Explicitly revised intent');
    await click('[data-attached-reference] button');await wait('!document.querySelector("[data-attached-reference]")');await click('#referenceUndoAttachments');await wait('!!document.querySelector("[data-attached-reference]")');
    await click('[data-reference] button');await click('#referenceDetail [data-write]:nth-child(2)');await wait('!document.querySelector("[data-reference]")');
    assert.equal((await page.evaluate('window.sceneLoop.get_rules({project:"one",video:"first"})')).references.length,1);
    await page.evaluate('document.querySelector("#referenceRemoved").click()');await click('[data-reference] button');await click('#referenceDetail .reference-actions:last-of-type [data-write]:nth-child(2)');await wait('document.querySelector("#referenceStatus").textContent.includes("restored")');
    // Link-only reference has no remote player and has a manual, explicitly unverified range.
    await fill('#referenceSearch','');await choose('#referenceTag','');await click('#referenceNew');await fill('#ref-title','Link study');await fill('#ref-sourceUrl','https://example.com/video');await fill('#ref-intent','Study timing');await fill('#ref-start','3');await fill('#ref-end','10');await click('#referenceForm button[type=submit]');await wait('!document.querySelector("#referenceForm")');
    assert.equal(await page.evaluate('!!document.querySelector("#referenceDetail video")'),false);assert.match(await page.evaluate('document.querySelector("#referenceDetail").textContent'),/unverified/);
    // A retained callback from an old selection cannot save into the next video/project.
    await page.evaluate('window.oldAttach=document.querySelector("#referenceDetail [data-attach]")');await choose('#referenceVideo','second');await wait('document.querySelector("#referenceScope").textContent.includes("one / second") && !document.querySelector("#referenceNew").disabled');
    await page.evaluate('window.oldAttach.click()');assert.equal((await page.evaluate('window.sceneLoop.get_video_references({project:"one",video:"second"})')).items.length,0);
    await choose('#referenceProject','two');await wait('document.querySelector("#referenceScope").textContent.includes("two / first") && !document.querySelector("#referenceNew").disabled');assert.equal(await page.evaluate('document.querySelectorAll("[data-reference]").length'),0);
    // Delayed inspection cannot populate the next project.
    await page.evaluate(`window.realFetch=window.fetch;window.fetch=async(...a)=>{const b=JSON.parse(a[1]?.body||'{}');if(String(a[0]).includes('/list_references')&&b.args.project==='one')await new Promise(r=>window.releaseTarget=r);return window.realFetch(...a);}`);
    await choose('#referenceProject','one');await wait('!!window.releaseTarget');await choose('#referenceProject','two');await wait('!document.querySelector("#referenceNew").disabled');await page.evaluate('window.releaseTarget()');await new Promise(r=>setTimeout(r,150));assert.equal(await page.evaluate('document.querySelectorAll("[data-reference]").length'),0);await page.evaluate('window.fetch=window.realFetch');
    // A real page-tool stale write rejects; failed requests do not rewrite attached snapshots.
    const stale=await page.evaluate('window.sceneLoop.list_references({project:"one"})');
    await page.evaluate(`window.sceneLoop.edit_reference({project:'one',reference:${JSON.stringify(id)},contextHash:${JSON.stringify(stale.contextHash)},title:'Edited externally',sourceUrl:'https://example.com',start:0,end:1,intent:'External edit',tags:[],model:'Test'})`);
    const failed=await page.evaluate(`window.sceneLoop.remove_reference({project:'one',reference:${JSON.stringify(id)},contextHash:${JSON.stringify(stale.contextHash)}}).then(()=>false,e=>e.message)`);assert.match(failed,/changed/);
    for(const [tab,panel] of [['libStylesTab','styleLibrary'],['libPatternsTab','patternLibrary'],['libMotionTab','motionLibrary'],['libGuidesTab','guideLibrary'],['libMusicTab','musicLibrary'],['libReferencesTab','referenceLibrary']]){await click('#'+tab);assert.equal(await page.evaluate(`document.querySelector('#${panel}').hidden`),false);}
    const mobile=await browser.newPage({width:390,height:844});await mobile.goto(url);const until=Date.now()+20000;while(!await mobile.evaluate('!document.querySelector("#referenceNew").disabled && !document.querySelector("#referenceLibrary").hidden')){if(Date.now()>until)throw new Error('Mobile timeout');await new Promise(r=>setTimeout(r,30));}
    await mobile.evaluate('document.querySelector("[data-reference] button").click()');assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);await mobile.evaluate('document.querySelector("#referenceNew").click()');assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);assert.equal(await page.evaluate('document.documentElement.scrollWidth'),1280);
    assert.deepEqual(page.errors,[]);assert.deepEqual(mobile.errors,[]);await mobile.close();await page.close();
  }finally{await browser.close();server.kill();if(server.exitCode===null)await new Promise(r=>server.once('exit',r));rmSync(root,{recursive:true,force:true});}
});
