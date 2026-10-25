// Real scratch server, owner page and page tools; synthetic words only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {launch} from '../lib/chrome.mjs';
import {TEMPLATE_DIR} from '../lib/projects.mjs';

test('caption page/tools generate, correct, preview/cancel/save/reload/remove/restore, stale source/forms and 390px', {timeout:45000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-subtitle-ui-'));cpSync(TEMPLATE_DIR,join(root,'demo'),{recursive:true});
  const listener=createServer().listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const server=spawn(process.execPath,['server.mjs',join(root,'demo'),'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',c=>logs+=c);server.stderr.on('data',c=>logs+=c);
  const browser=await launch();const art=process.env.SL_SUBTITLE_ARTIFACT_DIR;
  const shots=[];
  try{
    const page=await browser.newPage({width:1280,height:1000});
    const wait=async(code)=>{const until=Date.now()+12000;while(!await page.evaluate(code)){if(Date.now()>until)throw new Error(`Waiting for ${code}; ${logs}`);await new Promise(r=>setTimeout(r,25));}};
    while(!logs.includes('MCP:')){if(server.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,25));}
    await page.goto(`http://127.0.0.1:${port}`);await wait('document.querySelector("#player").ready && !!window.sceneLoop');
    const click=s=>page.evaluate(`document.querySelector(${JSON.stringify(s)}).click()`);
    const button=label=>page.evaluate(`[...document.querySelectorAll('#sceneSubtitles button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    const input=(s,value,type='input')=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(s)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(type)}));})()`);
    const inspect=()=>page.evaluate('window.sceneLoop.get_scene_subtitles({project:"demo",video:"demo",scene:"s01-intro"})');
    const capture=async(name)=>{if(!art)return;await wait('document.querySelector("#player").ready && document.querySelector("#shade").hidden');await page.evaluate('[...document.querySelectorAll("#sceneSubtitles button")].find(b=>b.textContent==="Preview cue")?.click()');mkdirSync(join(art,'img'),{recursive:true});writeFileSync(join(art,`img/${name}.png`),await page.screenshot());shots.push(name);};
    await click('#sceneSubtitles summary');await wait('!!document.querySelector("#sceneSubtitles form")');
    assert.match(await page.evaluate('document.querySelector("#sceneSubtitles").textContent'),/Timed narration words are required/);
    await button('Preview draft');assert.match(await page.evaluate('document.querySelector("#sceneSubtitles").textContent'),/Generate a draft/);
    await capture('01-no-words');
    await page.evaluate('window.sceneLoop.update_scene({scene:"s01-intro",narration:"Hello verden. Æble ø og å.",model:"Synthetic UI fixture"})');
    await page.evaluate('import("/js/data.js").then(m=>m.refresh())');
    await page.evaluate('window.sceneLoop.set_narration_words({scene:"s01-intro",words:[{word:"Hello",start:.1,end:.4},{word:"verden.",start:.4,end:.8},{word:"Æble",start:1,end:1.3},{word:"ø",start:1.3,end:1.5},{word:"og",start:1.5,end:1.7},{word:"å.",start:1.7,end:2}],adopt:false,model:"Synthetic UI fixture"})');
    await page.evaluate('import("/js/data.js").then(m=>m.refresh())');
    await wait('[...document.querySelectorAll("#sceneSubtitles button")].some(b=>b.textContent==="Generate draft from words" && !b.disabled)');
    const sourceBefore=readFileSync(join(root,'demo/assets/narration/s01-intro.words.json'),'utf8'),scriptBefore=JSON.parse(readFileSync(join(root,'demo/storyboard.json'))).scenes[0].narration;
    await button('Generate draft from words');await wait('!!document.querySelector("#captionContent")');
    assert.equal((await inspect()).snapshot,null);
    await button('Preview cue');await capture('02-generated');
    await input('#captionContent','Hej, verden!');await input('[aria-label="Caption start (s)"]','0.6');await input('[aria-label="Caption end (s)"]','1.25');await input('[aria-label="Caption style"]','light','change');await button('Preview cue');await capture('03-corrected-draft');
    const inFrame=()=>page.evaluate('document.querySelector("#player iframe").contentDocument.querySelector("[data-sl-caption]")?.textContent.trim()');
    assert.equal(await inFrame(),'Hej, verden!');assert.equal((await inspect()).snapshot,null);
    await button('Cancel');await wait('!document.querySelector("#sceneSubtitles").open');assert.equal(await inFrame(),undefined);
    await click('#sceneSubtitles summary');await wait('!!document.querySelector("#sceneSubtitles form")');await button('Generate draft from words');await wait('!!document.querySelector("#captionContent")');
    await input('#captionContent','Hej, verden!');await input('[aria-label="Caption start (s)"]','0.6');await input('[aria-label="Caption end (s)"]','1.25');await input('[aria-label="Caption style"]','light','change');
    await click('#sceneSubtitles button[type=submit]');await wait('document.querySelector("#captionContent")?.value === "Hej, verden!" && document.querySelector("#versionsBtn").textContent==="Versions (2)"');
    let saved=await inspect();assert.deepEqual(saved.snapshot.cues[0],{text:'Hej, verden!',start:.6,end:1.25});assert.equal(saved.snapshot.style.id,'light');
    await button('Preview cue');await capture('04-saved');
    const sourceAfterCaptionSave=readFileSync(join(root,'demo/assets/narration/s01-intro.words.json'),'utf8'),scriptAfterCaptionSave=JSON.parse(readFileSync(join(root,'demo/storyboard.json'))).scenes[0].narration;
    assert.equal(sourceAfterCaptionSave,sourceBefore);assert.equal(scriptAfterCaptionSave,scriptBefore);
    // Source-only changes invalidate open forms even when storyboard stamp/version is unchanged.
    await input('#captionContent','Old detached correction');await page.evaluate('window.oldForm=document.querySelector("#sceneSubtitles form");window.oldInput=document.querySelector("#captionContent")');
    await page.evaluate('window.sceneLoop.set_narration_words({scene:"s01-intro",words:[{word:"Hello",start:.2,end:.5},{word:"verden.",start:.5,end:.9},{word:"Æble",start:1.1,end:1.4},{word:"ø",start:1.4,end:1.6},{word:"og",start:1.6,end:1.8},{word:"å.",start:1.8,end:2.1}],adopt:false,model:"Synthetic change"})');
    await wait('document.querySelector("#sceneSubtitles .subtitle-warning") && document.querySelector("#captionContent")?.value === "Hej, verden!"');
    await page.evaluate('window.oldInput.value="Stale edit";window.oldInput.dispatchEvent(new Event("input"));window.oldForm.dispatchEvent(new Event("submit",{cancelable:true}))');
    assert.equal((await inspect()).snapshot.cues[0].text,'Hej, verden!');assert.equal((await inspect()).stale,true);await capture('05-stale-source');
    await button('Regenerate draft from words');await wait('document.querySelector("#captionContent")?.value === "Hello verden."');assert.equal((await inspect()).snapshot.cues[0].text,'Hej, verden!');
    await button('Cancel');await click('#sceneSubtitles summary');await wait('document.querySelector("#captionContent")?.value === "Hej, verden!"');
    // Source is stale but corrections remain editable. An explicit regeneration rebases it.
    await button('Regenerate draft from words');await wait('document.querySelector("#captionContent")?.value === "Hello verden."');await click('#sceneSubtitles button[type=submit]');await wait('!document.querySelector("#sceneSubtitles .subtitle-warning") && !!document.querySelector("#captionContent")');
    assert.equal((await inspect()).stale,false);assert.equal((await inspect()).snapshot.cues[0].start,.55);await capture('06-regenerated');
    await page.evaluate('window.sceneLoop.create_scene({id:"second",title:"Second",duration:2,model:"Synthetic UI fixture"})');await wait('!!document.querySelector(".card[data-id=second]") && !!document.querySelector("#captionContent")');
    await input('#captionContent','Unsaved navigation draft');await page.evaluate('window.oldForm=document.querySelector("#sceneSubtitles form")');
    await click('.card[data-id=second]');await wait('document.querySelector("#panelSub").textContent.startsWith("second") && !!document.querySelector("#sceneSubtitles form")');
    await click('.card[data-id="s01-intro"]');await wait('document.querySelector("#captionContent")?.value === "Hello verden."');
    await page.evaluate('window.oldForm.dispatchEvent(new Event("submit",{cancelable:true}))');assert.equal((await inspect()).snapshot.cues[0].text,'Hello verden.');
    await page.evaluate('import("/js/versions.js").then(m=>m.openCompare(1))');await wait('document.querySelector("#sceneSubtitles").textContent.includes("latest version")');assert.match(await page.evaluate('document.querySelector("#sceneSubtitles").textContent'),/latest version/);
    await click('#closeCompare');await wait('!!document.querySelector("#captionContent")');
    await page.evaluate('import("/js/versions.js").then(m=>m.viewVersion(1))');await wait('!document.querySelector("#captionContent") && document.querySelector("#viewing").textContent.includes("v1")');
    await page.evaluate('import("/js/versions.js").then(m=>m.viewVersion(3))');await wait('!!document.querySelector("#captionContent")');
    await button('Remove all captions');await button('Preview draft');assert.equal(await inFrame(),undefined);await click('#sceneSubtitles button[type=submit]');await wait('!document.querySelector("#captionContent")');assert.equal((await inspect()).snapshot,null);await capture('07-removed');
    await page.evaluate(`window.sceneLoop.restore_version({scene:"s01-intro",version:${saved.version},model:"Restore caption correction"})`);await wait('document.querySelector("#captionContent")?.value === "Hej, verden!"');await button('Preview cue');await capture('08-history-restored');
    const mobile=await browser.newPage({width:390,height:844});await mobile.goto(`http://127.0.0.1:${port}`);
    for(let i=0;i<300 && !await mobile.evaluate('document.querySelector("#player").ready && !!window.sceneLoop');i++)await new Promise(r=>setTimeout(r,25));
    await mobile.evaluate('document.querySelector("#sceneSubtitles summary").click()');
    for(let i=0;i<300 && !await mobile.evaluate('!!document.querySelector("#captionContent")');i++)await new Promise(r=>setTimeout(r,25));
    assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);assert.equal(await mobile.evaluate('document.querySelector("#captionContent").value'),'Hej, verden!');
    if(art){for(let i=0;i<400 && !await mobile.evaluate('document.querySelector("#player").ready && document.querySelector("#shade").hidden');i++)await new Promise(r=>setTimeout(r,25));await mobile.evaluate('[...document.querySelectorAll("#sceneSubtitles button")].find(b=>b.textContent==="Preview cue").click()');writeFileSync(join(art,'img/09-mobile.png'),await mobile.screenshot());await mobile.evaluate('document.querySelector("#captionContent").scrollIntoView({block:"center"})');writeFileSync(join(art,'img/10-mobile-editor.png'),await mobile.screenshot());writeFileSync(join(art,'source-unchanged.json'),JSON.stringify({syntheticSource:true,sourceBefore,sourceAfterCaptionSave,scriptBefore,scriptAfterCaptionSave,saved,shots,pageErrors:page.errors,mobileErrors:mobile.errors},null,2));}
    assert.deepEqual(page.errors,[]);assert.deepEqual(mobile.errors,[]);await mobile.close();await page.close();
  }finally{await browser.close();server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));rmSync(root,{recursive:true,force:true});}
});

// The importer accepts this real Scribe shape, including the middle point-timed word.
// This regression exercises the actual page Generate/Save path, rather than a hand pin.
test('page generates and saves accepted point-timed Scribe words, explains inference and exports exact cue bounds', {timeout:60000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-point-ui-'));cpSync(TEMPLATE_DIR,join(root,'demo'),{recursive:true});
  const listener=createServer().listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const proc=spawn(process.execPath,['server.mjs',join(root,'demo'),'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});let logs='';proc.stdout.on('data',c=>logs+=c);proc.stderr.on('data',c=>logs+=c);
  const browser=await launch(),art=process.env.SL_SUBTITLE_ARTIFACT_DIR;
  try{
    const page=await browser.newPage({width:1280,height:1000});
    const wait=async code=>{const deadline=Date.now()+15000;while(!await page.evaluate(code)){if(Date.now()>deadline)throw new Error(`Waiting for ${code}; ${logs}`);await new Promise(r=>setTimeout(r,25));}};
    while(!logs.includes('MCP:')){if(proc.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,25));}
    await page.goto(`http://127.0.0.1:${port}`);await wait('!!window.sceneLoop && document.querySelector("#player").ready');
    await page.evaluate('window.sceneLoop.update_scene({scene:"s01-intro",narration:"Det er fint.",model:"Synthetic zero-word regression"})');
    const accepted=await page.evaluate('window.sceneLoop.set_narration_words({scene:"s01-intro",scribe:{words:[{type:"word",text:"Det",start:.1,end:.3},{type:"word",text:"er",start:.32,end:.32},{type:"word",text:"fint.",start:.34,end:.8}]},adopt:false,model:"Synthetic zero-word regression"})');
    assert.equal(accepted.words[1].start,accepted.words[1].end);
    await page.evaluate('import("/js/data.js").then(m=>m.refresh())');
    const sourceFile=join(root,'demo/assets/narration/s01-intro.words.json'),sbFile=join(root,'demo/storyboard.json');
    const sourceBefore=readFileSync(sourceFile,'utf8'),storyboardBefore=readFileSync(sbFile,'utf8');
    await page.evaluate('document.querySelector("#sceneSubtitles summary").click()');await wait('!!document.querySelector("#sceneSubtitles form")');
    await page.evaluate('[...document.querySelectorAll("#sceneSubtitles button")].find(b=>b.textContent==="Generate draft from words").click()');
    await wait('document.querySelector("#captionContent")?.value === "Det er fint."');
    assert.match(await page.evaluate('document.querySelector("#sceneSubtitles").textContent'),/Inferred timing/);
    assert.equal(await page.evaluate('document.querySelectorAll("#sceneSubtitles input")[0].value'),'0.45');
    assert.equal(await page.evaluate('document.querySelectorAll("#sceneSubtitles input")[1].value'),'1.15');
    await wait('document.querySelector("#player").ready && document.querySelector("#shade").hidden');
    await page.evaluate('[...document.querySelectorAll("#sceneSubtitles button")].find(b=>b.textContent==="Preview cue").click()');
    if(art){mkdirSync(join(art,'img'),{recursive:true});writeFileSync(join(art,'img/zero-after.png'),await page.screenshot());}
    await page.evaluate('document.querySelector("#sceneSubtitles .subtitle-inference").open=true');
    assert.match(await page.evaluate('document.querySelector("#sceneSubtitles .subtitle-inference").textContent'),/point-timed source words 2/);
    if(art)writeFileSync(join(art,'img/zero-inference.png'),await page.screenshot());
    await page.evaluate('document.querySelector("#sceneSubtitles button[type=submit]").click()');await wait('document.querySelector("#versionsBtn").textContent==="Versions (2)" && !!document.querySelector("#captionContent")');
    const inspect=()=>page.evaluate('window.sceneLoop.get_scene_subtitles({project:"demo",video:"demo",scene:"s01-intro"})');
    const saved=await inspect();assert.deepEqual(saved.snapshot.cues,[{text:'Det er fint.',start:.45,end:1.15}]);assert.equal(saved.snapshot.provenance.derivationVersion,2);assert.deepEqual(saved.snapshot.provenance.derivationNotes[0].sourceWords,[2]);
    assert.equal(readFileSync(sourceFile,'utf8'),sourceBefore);assert.equal(readFileSync(sbFile,'utf8'),storyboardBefore);
    const render=await page.evaluate('window.sceneLoop.render({project:"demo",video:"demo"})');
    let job;
    for(let i=0;i<1600;i++){job=await page.evaluate(`window.sceneLoop.get_render({job:${JSON.stringify(render.job)}})`);if(job.state!=='running')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(job.state,'done',job.error);
    // The scene title is above this crop. Only the caption can darken the lower band.
    const {execFileSync}=await import('node:child_process');
    const frames=[];
    for(const [n,on] of [[13,false],[14,true],[34,true],[35,false]]){
      const bytes=execFileSync('ffmpeg',['-v','error','-i',job.path,'-vf',`select=eq(n\\,${n}),crop=1920:280:0:800`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:3000000});
      let dark=0;for(let i=0;i<bytes.length;i+=3)if(bytes[i]<100&&bytes[i+1]<100&&bytes[i+2]<100)dark++;
      assert.equal(dark>1000,on,`frame ${n}, dark caption pixels ${dark}`);frames.push({frame:n,seconds:n/30,darkCaptionPixels:dark,expectedVisible:on});
    }
    // Reload exposes the same saved inference note, with the transcript still byte-identical.
    await page.goto(`http://127.0.0.1:${port}`);await wait('document.querySelector("#player").ready && !!window.sceneLoop');await page.evaluate('document.querySelector("#sceneSubtitles summary").click()');await wait('document.querySelector("#captionContent")?.value === "Det er fint."');
    assert.ok(await page.evaluate('!!document.querySelector("#sceneSubtitles .subtitle-inference")'));
    assert.equal(readFileSync(sourceFile,'utf8'),sourceBefore);assert.equal(readFileSync(sbFile,'utf8'),storyboardBefore);
    if(art){mkdirSync(join(art,'video'),{recursive:true});cpSync(job.path,join(art,'video/zero-page-export.mp4'));writeFileSync(join(art,'zero-after.json'),JSON.stringify({syntheticSource:true,accepted,sourceBefore,sourceAfter:readFileSync(sourceFile,'utf8'),storyboardBefore,storyboardAfter:readFileSync(sbFile,'utf8'),saved,frames,pageErrors:page.errors},null,2));}
    assert.deepEqual(page.errors,[]);
  }finally{await browser.close();proc.kill();await new Promise(r=>proc.exitCode!==null?r():proc.once('exit',r));rmSync(root,{recursive:true,force:true});}
});
