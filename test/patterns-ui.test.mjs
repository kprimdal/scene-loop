// Real browser controls, stale target guards, long content and portrait sizing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { launch } from '../lib/chrome.mjs';
import { TEMPLATE_DIR } from '../lib/projects.mjs';

test('pattern page creates in selected video, rejects stale forms, edits/restores/reloads, supports media, long inputs, mobile and Library tabs', {timeout:60000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-pattern-ui-'));
  for (const n of ['one','two']) cpSync(TEMPLATE_DIR,join(root,'project','videos',n),{recursive:true});
  const assets=join(root,'project','videos','two','assets');mkdirSync(assets,{recursive:true});
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=15','-t','3','-c:v','libx264','-pix_fmt','yuv420p',join(assets,'synthetic.mp4')]);
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=teal:s=320x240','-frames:v','1','-threads','1',join(assets,'synthetic.png')]);
  const listener=createServer().listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});
  let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  const browser=await launch();
  try {
    const page=await browser.newPage({width:1280,height:1000});
    const wait=async code=>{const end=Date.now()+15000;while(!await page.evaluate(code)){if(Date.now()>end)throw new Error(`Wait: ${code}; ${await page.evaluate('document.querySelector("#patternForm")?.textContent')}; ${logs}`);await new Promise(r=>setTimeout(r,30));}};
    while(!logs.includes('MCP:')){if(server.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,30));}
    const base=`http://127.0.0.1:${port}`;
    await page.goto(`${base}/?library=1&section=patterns&project=project&video=one`);
    await wait('!!document.querySelector("[data-pattern=process] button") && !document.querySelector("#patternLibrary").hidden && !!window.sceneLoop');
    const click=sel=>page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const input=(sel,value)=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'));})()`);
    await click('[data-pattern=process] button');
    await input('#pattern-heading','A draft for the old target');
    await page.evaluate('window.oldSubmit=document.querySelector("#patternForm").onsubmit');
    // Rapid target changes invalidate old closures; the fresh form names the final target.
    await input('#patternVideo','1');await input('#patternVideo','0');await input('#patternVideo','1');
    await page.evaluate('window.oldSubmit(new Event("submit",{cancelable:true}))');
    assert.equal((await page.evaluate('window.sceneLoop.list_scenes({project:"project",video:"one"})')).scenes.length,1);
    assert.equal((await page.evaluate('window.sceneLoop.list_scenes({project:"project",video:"two"})')).scenes.length,1);
    await input('#pattern-heading','Build a rooftop garden');await input('#pattern-steps','Find the light\nChoose hardy plants\nWater a little every morning');
    await input('#patternForm [name=title]','Garden plan');await input('#patternForm [name=duration]','5');
    await click('#patternForm button[type=submit]');await wait('!!document.querySelector("#patternResult a")');
    const targetUrl=await page.evaluate('document.querySelector("#patternResult a").href');
    assert.match(targetUrl,/video=two/);
    const scenes=(await page.evaluate('window.sceneLoop.list_scenes({project:"project",video:"two"})')).scenes;
    const id=scenes.at(-1).id;
    assert.equal(scenes.at(-1).pattern.inputs.heading,'Build a rooftop garden');
    assert.equal((await page.evaluate('window.sceneLoop.list_scenes({project:"project",video:"one"})')).scenes.length,1);
    await page.goto(targetUrl);await wait('document.querySelector("#player").ready && !!window.sceneLoop');
    const original=await page.evaluate(`window.sceneLoop.get_scene_html({scene:${JSON.stringify(id)}})`);
    await page.evaluate(`window.sceneLoop.write_scene_html({scene:${JSON.stringify(id)},html:${JSON.stringify(original.html.replace('Build a rooftop garden','A revised garden'))},resolves:[],model:'Browser test'})`);
    await page.evaluate(`window.sceneLoop.restore_version({scene:${JSON.stringify(id)},version:1})`);
    await page.goto(targetUrl);await wait('document.querySelector("#player").ready && !!window.sceneLoop');
    assert.equal((await page.evaluate(`window.sceneLoop.get_scene_html({scene:${JSON.stringify(id)}})`)).html,original.html);
    // All three maximum-size inputs at landscape and portrait: inspect real laid-out boxes.
    const checks=await page.evaluate(`(async()=>{
      const ps=(await window.sceneLoop.list_patterns()).items, out=[];
      for(const [width,height] of [[960,540],[540,960],[720,720],[960,720],[540,720],[540,810]]) {
        await window.sceneLoop.set_video({width,height,model:'Browser test'});
        for(const p of ps) {
          const inputs=Object.fromEntries(p.fields.map(f=>[f.key,f.optional?'':f.minItems?Array(f.maxItems).fill(('A thoughtful point with useful details and room to think. ').repeat(3).slice(0,f.max)):('A clear name with some meaningful detail. ').repeat(3).slice(0,f.max)]));
          const r=await window.sceneLoop.instantiate_pattern({pattern:p.id,inputs,duration:3,model:'Browser test'});
          const b=await fetch('/api/build/scene/'+r.id+'?v=disk&project=project&video=two').then(r=>r.json());
          const iframe=document.createElement('iframe');iframe.src=b.url;document.body.append(iframe);await new Promise(r=>iframe.onload=r);
          await iframe.contentWindow.__sl.ready;iframe.contentWindow.__sl.seek(2.9);
          const doc=iframe.contentDocument,root=doc.querySelector('.scene'),rect=root.getBoundingClientRect();
          const overflow=[...root.querySelectorAll('h1,h2,p,.pat-name,.pat-item')].filter(e=>{const b=e.getBoundingClientRect();return b.bottom>rect.bottom+1||b.right>rect.right+1||e.scrollHeight>e.clientHeight+1||e.scrollWidth>e.clientWidth+1}).map(e=>e.className||e.tagName);
          out.push({pattern:p.id,width,height,overflow});iframe.remove();
        }
      }
      for(const media of ['assets/synthetic.mp4','assets/synthetic.png']) {
        const p=ps.find(p=>p.id==='presenter');const r=await window.sceneLoop.instantiate_pattern({pattern:p.id,inputs:{...p.defaults,media},duration:3,model:'Browser test'});
        const b=await fetch('/api/build/scene/'+r.id+'?v=disk&project=project&video=two').then(r=>r.json());
        const iframe=document.createElement('iframe');iframe.src=b.url;document.body.append(iframe);await new Promise(r=>iframe.onload=r);await iframe.contentWindow.__sl.ready;
        out.push({media,ready:true});iframe.remove();
      }
      return out;
    })()`);
    for(const check of checks) if(check.overflow) assert.deepEqual(check.overflow,[],JSON.stringify(check));
    assert.equal(checks.filter(c=>c.ready).length,2);
    await page.goto(`${base}/?library=1&section=patterns`);await wait('!!document.querySelector("[data-pattern=comparison] button") && !document.querySelector("#patternLibrary").hidden');
    for(const [tab,panel] of [['libStylesTab','styleLibrary'],['libMusicTab','musicLibrary'],['libPatternsTab','patternLibrary']]) {await click('#'+tab);assert.equal(await page.evaluate(`document.querySelector('#${panel}').hidden`),false);}
    await click('[data-pattern=comparison] button');
    assert.equal(await page.evaluate('document.activeElement.id'),'pattern-heading');
    await click('#patternForm .pattern-form-head button');
    assert.equal(await page.evaluate('document.querySelector("#patternForm").hidden'),true);
    await click('[data-pattern=comparison] button');
    await input('#patternVideo','1');
    await page.evaluate('document.querySelector("#patternForm button[type=submit]").focus()');
    await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
    await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await wait('!!document.querySelector("#patternResult a")');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth'),1280);
    const mobile=await browser.newPage({width:390,height:844});await mobile.goto(`${base}/?library=1&section=patterns`);
    const end=Date.now()+10000;while(!await mobile.evaluate('!!document.querySelector("[data-pattern=presenter] button")')){if(Date.now()>end)throw new Error('mobile timeout');await new Promise(r=>setTimeout(r,30));}
    await mobile.evaluate('document.querySelector("[data-pattern=presenter] button").click()');
    assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'),390);
    assert.deepEqual(page.errors,[]);assert.deepEqual(mobile.errors,[]);
    await mobile.close();await page.close();
  } finally {await browser.close();server.kill();await new Promise(r=>server.once('exit',r));rmSync(root,{recursive:true,force:true});}
});
