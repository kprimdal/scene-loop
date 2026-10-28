// Real scratch server and page tools; synthetic words only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {launch} from '../lib/chrome.mjs';
import {TEMPLATE_DIR} from '../lib/projects.mjs';

// The importer accepts this real Scribe shape, including the middle point-timed word.
test('tools generate and save captions from point-timed Scribe words, keep the inference note and export exact cue bounds', {timeout:60000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-point-tools-'));cpSync(TEMPLATE_DIR,join(root,'demo'),{recursive:true});
  const listener=createServer().listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const proc=spawn(process.execPath,['server.mjs',join(root,'demo'),'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:process.env,stdio:['ignore','pipe','pipe']});let logs='';proc.stdout.on('data',c=>logs+=c);proc.stderr.on('data',c=>logs+=c);
  const browser=await launch();
  try{
    const page=await browser.newPage({width:1280,height:1000});
    const wait=async code=>{const deadline=Date.now()+15000;while(!await page.evaluate(code)){if(Date.now()>deadline)throw new Error(`Waiting for ${code}; ${logs}`);await new Promise(r=>setTimeout(r,25));}};
    while(!logs.includes('MCP:')){if(proc.exitCode!==null)throw new Error(logs);await new Promise(r=>setTimeout(r,25));}
    await page.goto(`http://127.0.0.1:${port}`);await wait('!!window.sceneLoop && document.querySelector("#player").ready');
    await page.evaluate('window.sceneLoop.update_scene({scene:"s01-intro",narration:"Det er fint.",model:"Synthetic zero-word regression"})');
    const accepted=await page.evaluate('window.sceneLoop.set_narration_words({scene:"s01-intro",scribe:{words:[{type:"word",text:"Det",start:.1,end:.3},{type:"word",text:"er",start:.32,end:.32},{type:"word",text:"fint.",start:.34,end:.8}]},adopt:false,model:"Synthetic zero-word regression"})');
    assert.equal(accepted.words[1].start,accepted.words[1].end);
    const sourceFile=join(root,'demo/assets/narration/s01-intro.words.json'),sbFile=join(root,'demo/storyboard.json');
    const sourceBefore=readFileSync(sourceFile,'utf8'),storyboardBefore=readFileSync(sbFile,'utf8');
    const target='project:"demo",video:"demo",scene:"s01-intro"';
    const info=await page.evaluate(`window.sceneLoop.get_scene_subtitles({${target}})`);
    const generated=await page.evaluate(`window.sceneLoop.generate_scene_subtitles({${target},contextHash:${JSON.stringify(info.contextHash)}})`);
    assert.deepEqual(generated.draft.cues,[{text:'Det er fint.',start:.45,end:1.15}]);
    await page.evaluate(`window.sceneLoop.set_scene_subtitles({${target},contextHash:${JSON.stringify(info.contextHash)},cues:${JSON.stringify(generated.draft.cues)},sourceHash:${JSON.stringify(generated.draft.provenance.sourceHash)},regenerate:true,model:"Synthetic zero-word regression"})`);
    const saved=await page.evaluate(`window.sceneLoop.get_scene_subtitles({${target}})`);
    assert.deepEqual(saved.snapshot.cues,[{text:'Det er fint.',start:.45,end:1.15}]);assert.equal(saved.snapshot.provenance.derivationVersion,2);assert.deepEqual(saved.snapshot.provenance.derivationNotes[0].sourceWords,[2]);
    assert.equal(readFileSync(sourceFile,'utf8'),sourceBefore);assert.equal(readFileSync(sbFile,'utf8'),storyboardBefore);
    const render=await page.evaluate('window.sceneLoop.render({project:"demo",video:"demo"})');
    let job;
    for(let i=0;i<1600;i++){job=await page.evaluate(`window.sceneLoop.get_render({job:${JSON.stringify(render.job)}})`);if(job.state!=='running')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(job.state,'done',job.error);
    // The scene title is above this crop. Only the caption can darken the lower band.
    for(const [n,on] of [[13,false],[14,true],[34,true],[35,false]]){
      const bytes=execFileSync('ffmpeg',['-v','error','-i',job.path,'-vf',`select=eq(n\\,${n}),crop=1920:280:0:800`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:3000000});
      let dark=0;for(let i=0;i<bytes.length;i+=3)if(bytes[i]<100&&bytes[i+1]<100&&bytes[i+2]<100)dark++;
      assert.equal(dark>1000,on,`frame ${n}, dark caption pixels ${dark}`);
    }
    assert.equal(readFileSync(sourceFile,'utf8'),sourceBefore);assert.equal(readFileSync(sbFile,'utf8'),storyboardBefore);
    assert.deepEqual(page.errors,[]);
  }finally{await browser.close();proc.kill();await new Promise(r=>proc.exitCode!==null?r():proc.once('exit',r));rmSync(root,{recursive:true,force:true});}
});
