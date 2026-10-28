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
test('Record view Split & cut: split with keys, cut two parts, listen, apply as one edit, undo, at 1280 and 390px',{timeout:120000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-cuts-ui-'));cpSync(TEMPLATE_DIR,join(root,'scratch/videos/demo'),{recursive:true});
  const source=join(root,'source.mp4');
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc=s=320x180:r=30:d=3','-f','lavfi','-i','sine=frequency=300:sample_rate=48000:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
  const port=await new Promise(r=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  const browser=await launch({args:['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  try{
    while(!logs.includes('MCP:')){if(server.exitCode!==null)throw new Error(logs);await delay(30);}
    const page=await browser.newPage({width:1280,height:1000});
    const url=`http://127.0.0.1:${port}/?project=scratch&video=demo`;
    const wait=async code=>{const end=Date.now()+30000;while(!await page.evaluate(code)){if(Date.now()>end)throw new Error(`Wait ${code}: ${await page.evaluate('document.querySelector(".cut-dialog")?.textContent')}`);await delay(30);}};
    const key=(k,extra={})=>page.evaluate(`document.querySelector('.cut-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,...${JSON.stringify(extra)}}))`);
    const named=text=>page.evaluate(`[...document.querySelectorAll('.cut-dialog button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
    const idle='!!document.querySelector(".cut-dialog") && ![...document.querySelectorAll(".cut-dialog button")].some(b=>b.disabled && !b.textContent.startsWith("Cut"))';
    await page.goto(url);await wait('!!window.sceneLoop');
    await page.evaluate(`(async()=>{await window.sceneLoop.update_scene({scene:'s01-intro',duration:4,model:'test'});await window.sceneLoop.add_take({scene:'s01-intro',path:${JSON.stringify(source)}});await window.sceneLoop.choose_take({scene:'s01-intro',take:1,keep:[[0,3]]});})()`);
    await page.evaluate('document.querySelector("#recordBtn").click()');await wait('document.querySelector("#recTakes")?.textContent.includes("Split & cut")');
    // Cleanup is the chat's job now: the used take has no Cleanup button and the panel no editors.
    assert.equal(await page.evaluate('[...document.querySelectorAll("#recTakes button")].some(b=>b.textContent==="Cleanup") || !!document.querySelector("#noiseCleanup,#recordingRanges,#sceneText,#sceneSubtitles")'),false);
    // X in the Record view opens the editor on the used take.
    await page.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"x",bubbles:true}))');
    await wait('!!document.querySelector(".cut-dialog canvas") && document.querySelector(".cut-time").textContent.includes("/ 3.00 s")');
    assert.ok(await page.evaluate('!!document.querySelector(".cut-dialog video.cut-cam")?.src.includes("assets/cam/s01-intro.mp4")'));
    // Record keys stay inside: E would open the line editor behind the dialog.
    await key('e');assert.equal(await page.evaluate('!!document.querySelector("#recText textarea")'),false);
    // Arrows step frames: two 15-frame parts (0.5 s at 30 fps) cut, 15 frames apart.
    const frame='Number(document.querySelector(".cut-time").textContent.match(/frame (\\d+)/)[1])';
    const f0=await page.evaluate(frame);await key('ArrowRight');assert.equal(await page.evaluate(frame),f0+1);await key('ArrowLeft');
    await key('ArrowRight',{shiftKey:true});assert.equal(await page.evaluate(frame),f0+30);await key('s');
    for(let i=0;i<15;i++)await key('ArrowRight');await key('s');
    await key('ArrowLeft');await key('x');
    await key('ArrowRight');for(let i=0;i<15;i++)await key('ArrowRight');await key('s');
    for(let i=0;i<15;i++)await key('ArrowRight');await key('s');
    await key('ArrowLeft');await key('Delete');
    assert.match(await page.evaluate('document.querySelector(".cut-time").textContent'),/2 cut, 2\.00 s left/);
    // A split too close to another one is refused.
    await key('s');await key('s');assert.match(await page.evaluate('document.querySelector(".cut-status").textContent'),/Too close/);
    await named('Cut 2 parts');await wait('document.querySelector(".cut-review")?.textContent.includes("Recording 3.00 → 2.00 s")');
    assert.ok(await page.evaluate('!!document.querySelector(".cut-review audio")?.src.includes("/assets/ranges/s01-intro/")'));
    await named('Apply the cut');await wait(`${idle} && document.querySelector(".cut-status").textContent.startsWith("Cut.")`);
    assert.match(await page.evaluate('document.querySelector(".cut-time").textContent'),/\/ 2\.00 s/);
    const after=await page.evaluate('window.sceneLoop.inspect_recording_ranges({project:"scratch",video:"demo",scene:"s01-intro"})');
    // Every cut sits on the scene's frame grid: (recording seconds + lead) * fps is a whole frame.
    assert.equal(after.segments.length,3);assert.ok(Math.abs(after.seconds-2)<.002);assert.equal(after.duration,3);
    for(const g of after.segments.slice(1))assert.ok(Math.abs((g.from+after.lead)*30-Math.round((g.from+after.lead)*30))<.05,JSON.stringify(after.segments));
    for(const g of after.segments.slice(0,-1))assert.ok(Math.abs((g.to+after.lead)*30-Math.round((g.to+after.lead)*30))<.05,JSON.stringify(after.segments));
    await wait('document.querySelector("#recTakes").textContent.includes("3 ranges")');
    await named('Undo last cut');await wait(`${idle} && document.querySelector(".cut-time").textContent.includes("/ 3.00 s")`);
    assert.equal((await page.evaluate('window.sceneLoop.inspect_recording_ranges({project:"scratch",video:"demo",scene:"s01-intro"})')).duration,4);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth'),1280);
    await named('Close');await wait('!document.querySelector(".cut-dialog")');
    assert.equal(await page.evaluate('!!document.querySelector("#record:not([hidden])")'),true,'Esc/Close of the editor leaves the Record view open');
    const mobile=await browser.newPage({width:390,height:844});await mobile.goto(url);
    const until=async code=>{const end=Date.now()+30000;while(!await mobile.evaluate(code)){if(Date.now()>end)throw new Error(`390px: ${code}: ${await mobile.evaluate('document.querySelector("#record")?.innerText.slice(0,400)')}`);await delay(30);}};
    await until('!!window.sceneLoop && !!document.querySelector(".card[data-id=s01-intro]")');
    await mobile.evaluate('document.querySelector("#recordBtn").click()');await until('document.querySelector("#recTakes")?.textContent.includes("Split & cut")');
    await mobile.evaluate('[...document.querySelectorAll("#recTakes button")].find(b=>b.textContent==="Split & cut").click()');
    await until('document.querySelector(".cut-time")?.textContent.includes("/ 3.00 s")');
    assert.ok(await mobile.evaluate('document.querySelector(".cut-dialog").getBoundingClientRect().right<=390'));
    assert.deepEqual(page.errors,[]);assert.deepEqual(mobile.errors,[]);
  }finally{await browser.close();server.kill();if(server.exitCode===null)await new Promise(r=>server.once('exit',r));rmSync(root,{recursive:true,force:true});}
});
