// Real controls and page tools against public-safe template copies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { launch } from '../lib/chrome.mjs';
import { TEMPLATE_DIR } from '../lib/projects.mjs';

test('guides page: examples, exact one-time handoff/copy fallback, saved contents, undo, isolation, stale requests, mobile and all Library tabs', {timeout:120000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-guide-ui-'));
  for(const n of ['one','two'])cpSync(TEMPLATE_DIR,join(root,'project','videos',n),{recursive:true});
  writeFileSync(join(root,'project/project.md'),'# Original scratch project\nUse plain language. <img src=x onerror="window.injected=true">\n');
  const listener=createServer().listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});
  let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  const browser=await launch();
  try{
    const page=await browser.newPage({width:1280,height:1000});
    const wait=async code=>{const end=Date.now()+20000;while(!await page.evaluate(code)){if(Date.now()>end)throw new Error(`Wait: ${code}; ${logs}`);await new Promise(r=>setTimeout(r,30));}};
    const click=sel=>page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const choose=value=>page.evaluate(`(()=>{const e=document.querySelector('#guideVideo');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'));})()`);
    while(!logs.includes('MCP:')){if(server.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,30));}
    const url=`http://127.0.0.1:${port}/?library=1&section=guides&project=project&video=one`;
    await page.goto(url);await wait('!!document.querySelector("#guideUndo") && !document.querySelector("#guideLibrary").hidden && !!window.sceneLoop');
    for(const id of ['explain-concept','show-workflow','improve-pacing','review-video']){
      await click(`[data-guide=${id}] button`);assert.match(await page.evaluate('document.querySelector("#guideDetail").textContent'),/Worked example/);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth'),1280);
    }
    await click('[data-guide=explain-concept] button');
    await click('#guideInstructions summary');assert.equal(await page.evaluate('!!document.querySelector("#guideInstructions img")'),false);assert.equal(await page.evaluate('!!window.injected'),false);
    await click('#guideOnce');await wait('!!document.querySelector("#guidePrompt")');
    const prompt=await page.evaluate('document.querySelector("#guidePrompt").value');assert.match(prompt,/Use this guide ONCE/);assert.match(prompt,/"workflow"/);assert.match(prompt,/"contentHash"/);
    assert.equal((await page.evaluate('window.sceneLoop.get_video_guides({project:"project",video:"one"})')).items.length,0);
    // An actual project event refreshes Library without discarding the prepared handoff.
    await page.evaluate('window.sceneLoop.update_scene({project:"project",video:"one",scene:"s01-intro",title:"Original scratch title",model:"Test"})');
    await new Promise(r=>setTimeout(r,650));
    assert.equal(await page.evaluate('document.querySelector("#guidePrompt").value'),prompt);
    await page.evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.copied=text;}}})');
    await click('#guideCopy');await wait('!!window.copied');assert.equal(await page.evaluate('window.copied'),prompt);
    await page.evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:undefined})');
    await click('#guideCopy');await wait('document.querySelector("#guideHandoff").textContent.includes("Clipboard unavailable")');
    assert.equal(await page.evaluate('document.querySelector("#guidePrompt").selectionEnd'),prompt.length);
    // A saved callback from the old target cannot mutate the next video.
    await page.evaluate('window.oldAttach=document.querySelector("#guideAttach")');
    await choose('1');await wait('!!document.querySelector("#guideUndo") && !document.querySelector("#guideOnce").disabled');
    await page.evaluate('window.oldAttach.click()');
    assert.equal((await page.evaluate('window.sceneLoop.get_video_guides({project:"project",video:"two"})')).items.length,0);
    await click('#guideAttach');await wait('!!document.querySelector("[data-attached-guide=explain-concept]")');
    assert.deepEqual(await page.evaluate('[...document.querySelector("#guideAttached").childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent)'),[]);
    const rules=await page.evaluate('window.sceneLoop.get_rules({project:"project",video:"two"})');assert.equal(rules.guides.length,1);assert.match(rules.instructions,/Use plain language/);
    assert.equal((await page.evaluate('window.sceneLoop.get_video_guides({project:"project",video:"one"})')).items.length,0);
    // Reload exact target; saved content and undo survive.
    await page.goto(url.replace('video=one','video=two'));await wait('!!document.querySelector("[data-attached-guide=explain-concept]")');
    await click('[data-attached-guide=explain-concept] summary');assert.match(await page.evaluate('document.querySelector("[data-attached-guide=explain-concept]").textContent'),/Rain arrives in bursts/);
    await click('[data-attached-guide=explain-concept] button');await wait('!document.querySelector("[data-attached-guide=explain-concept]") && !document.querySelector("#guideUndo").disabled');
    await click('#guideUndo');await wait('!!document.querySelector("[data-attached-guide=explain-concept]")');
    // An external attachment edit invalidates this form, rather than overwriting it.
    await page.evaluate('window.staleRemove=document.querySelector("[data-attached-guide=explain-concept] button")');
    await page.evaluate('window.sceneLoop.remove_guide({project:"project",video:"two",guide:"explain-concept",model:"Test"})');
    await page.evaluate('window.staleRemove.click()');await wait('document.querySelector("#guideStatus").textContent.includes("changed")');
    assert.equal((await page.evaluate('window.sceneLoop.get_video_guides({project:"project",video:"two"})')).items.length,0);
    // Delayed inspection and one-time handoff cannot populate a newly selected target.
    await click('[data-guide=explain-concept] button');
    await page.evaluate(`window.realFetch=window.fetch;window.fetch=async(...a)=>{if(String(a[0]).includes('/use_guide_once'))await new Promise(r=>window.releaseOnce=r);return window.realFetch(...a);}`);
    await click('#guideOnce');await choose('0');await wait('!!document.querySelector("#guideUndo") && !document.querySelector("#guideOnce").disabled');
    await page.evaluate('window.releaseOnce()');await new Promise(r=>setTimeout(r,150));assert.equal(await page.evaluate('!!document.querySelector("#guidePrompt")'),false);
    await page.evaluate('window.fetch=window.realFetch');
    await page.evaluate(`window.fetch=async(...a)=>{const b=JSON.parse(a[1]?.body||'{}');if(String(a[0]).includes('/get_video_guides')&&b.args.video==='two')await new Promise(r=>window.releaseTarget=r);return window.realFetch(...a);}`);
    await choose('1');await choose('0');await wait('!!document.querySelector("#guideUndo") && !document.querySelector("#guideOnce").disabled');
    await page.evaluate('window.releaseTarget()');await new Promise(r=>setTimeout(r,150));assert.equal(await page.evaluate('document.querySelectorAll("[data-attached-guide]").length'),0);
    await page.evaluate('window.fetch=window.realFetch');
    // Equivalent page tools genuinely use the explain-concept example to create a draft.
    const sample=await page.evaluate(`(async()=>{const g=await window.sceneLoop.inspect_guide({guide:'explain-concept'});await window.sceneLoop.get_rules({project:'project',video:'one'});const p=await window.sceneLoop.inspect_pattern({pattern:'process'});const s=await window.sceneLoop.instantiate_pattern({project:'project',video:'one',pattern:p.id,version:p.version,contentHash:p.contentHash,id:'barrel-example',title:g.example.title,inputs:{heading:'A barrel buffers a burst',steps:['Rain arrives','Barrel stores','Garden uses']},duration:10,narration:g.example.script,model:'Guide test'});return {scene:s,guide:g};})()`);
    assert.equal(sample.scene.id,'barrel-example');assert.equal((await page.evaluate('window.sceneLoop.list_scenes({project:"project",video:"one"})')).scenes.at(-1).narration,sample.guide.example.script);
    for(const [tab,panel] of [['libStylesTab','styleLibrary'],['libPatternsTab','patternLibrary'],['libMotionTab','motionLibrary'],['libMusicTab','musicLibrary'],['libGuidesTab','guideLibrary']]){await click('#'+tab);assert.equal(await page.evaluate(`document.querySelector('#${panel}').hidden`),false);}
    await click('#libMusicTab');
    await page.evaluate('window.sceneLoop.update_scene({project:"project",video:"one",scene:"s01-intro",title:"Changed scratch title",model:"Test"})');
    await new Promise(r=>setTimeout(r,650));
    assert.equal(await page.evaluate('document.querySelector("#musicLibrary").hidden'),false);
    const mobile=await browser.newPage({width:390,height:844});await mobile.goto(url);
    const end=Date.now()+15000;while(!await mobile.evaluate('!!document.querySelector("[data-guide=explain-concept] button")')){if(Date.now()>end)throw new Error('mobile timeout');await new Promise(r=>setTimeout(r,30));}
    for(const id of ['explain-concept','show-workflow','improve-pacing','review-video']){await mobile.evaluate(`document.querySelector('[data-guide=${id}] button').click()`);assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);}
    await mobile.evaluate('document.querySelector("#guideOnce").click()');
    while(!await mobile.evaluate('!!document.querySelector("#guidePrompt")'))await new Promise(r=>setTimeout(r,30));
    assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);
    assert.deepEqual(page.errors,[]);assert.deepEqual(mobile.errors,[]);await mobile.close();await page.close();
  }finally{await browser.close();server.kill();await new Promise(r=>server.once('exit',r));rmSync(root,{recursive:true,force:true});}
});
