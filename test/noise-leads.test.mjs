// A later chosen recording has no saved lead until fit/build. Cleanup must use the page
// and camera default for that scene, never the previous soundtrack build's global lead.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,mkdirSync,readFileSync,writeFileSync,rmSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {openVideo} from '../lib/video.mjs';
import {TEMPLATE_DIR} from '../lib/projects.mjs';
import {launch} from '../lib/chrome.mjs';
import {mediaHash} from '../lib/noise.mjs';

const ff=(...args)=>execFileSync('ffmpeg',['-nostdin','-y','-v','error',...args],{maxBuffer:32*1024*1024});
const decode=file=>{const b=ff('-i',file,'-vn','-ac','1','-ar','48000','-f','f32le','-');return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length));};
const onset=(samples,start,from,to,threshold)=>{
  for(let i=Math.round((start+from)*48000);i<Math.round((start+to)*48000);i++)if(Math.abs(samples[i])>threshold)return i/48000-start;
  throw new Error(`No audio onset in scene window ${from}–${to}`);
};

test('cleanup keep and revert mix later unbuilt camera takes at the page default lead and preserve explicit leads and word SFX',{timeout:60000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'sl-noise-leads-')),dir=join(root,'video');cpSync(TEMPLATE_DIR,dir,{recursive:true});
  const source=join(root,'recording.mp4');
  // Public-safe synthetic camera and tone: keep [1,2] begins at a known voiced onset.
  ff('-f','lavfi','-i','color=c=blue:s=160x90:r=30:d=3','-f','lavfi','-i',"aevalsrc='if(between(t,1,2),0.3*sin(2*PI*300*t),0)':s=48000:d=3",'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source);
  const v=await openVideo(dir,{project:'scratch',video:'leads',reviewer:'test',emit:()=>{}});
  const A='s01-intro',C='custom',B='later';
  let browser;
  try {
    await v.setMeta({width:160,height:90});await v.updateScene(A,{duration:2,narration:'First'});
    await v.createScene({id:C,title:'Custom lead',duration:2,narration:'Custom',model:'test'});
    const choose=async(id,word)=>{
      await v.addTake(id,{path:source});await v.chooseTake(id,1,{keep:[[1,2]]});
      await v.setNarrationWords(id,{words:[{word,start:.1,end:.4}],adopt:false,cut:false});
    };
    await choose(A,'First');await choose(C,'Custom');
    await v.buildSoundtrack({lead:.6,loudness:'off'});
    // An independently fitted scene has an explicit lead different from the last mix setting.
    await v.fitScenesToNarration({scenes:[C],lead:.2,tail:.1,model:'test'});
    await v.createScene({id:B,title:'Later recording',duration:3,narration:'Later',model:'test'});await choose(B,'Later');
    mkdirSync(join(dir,'assets/sfx'),{recursive:true});
    ff('-f','lavfi','-i','sine=frequency=1600:sample_rate=48000:duration=0.1',join(dir,'assets/sfx/lead-cue.wav'));
    const html=`<template><style>#root{position:absolute;inset:0}video{width:160px;height:90px}#later-word{animation:later-mark 1s both}@keyframes later-mark{from{opacity:0}}</style><div id="root" data-composition-id="later" data-duration="3"><video src="assets/cam/later.mp4" muted playsinline></video><div id="later-word" data-at="word:Later" data-sfx="lead-cue@word:Later+1.2">Later</div></div></template>`;
    await v.writeSceneHtml(B,{html,model:'test'},'api');
    const originalStoryboard=readFileSync(join(dir,'storyboard.json'),'utf8');
    const scenes=v.storyboard().scenes;
    assert.equal(scenes.find(s=>s.id===B).narrationLead,undefined);
    assert.equal(JSON.parse(readFileSync(join(dir,'.state/noise/soundtrack.json'),'utf8')).lead,.6);
    const leads={[A]:.6,[C]:.2,[B]:.35},words={[A]:'First',[C]:'Custom',[B]:'Later'};
    const unchangedFiles=Object.fromEntries(scenes.flatMap(s=>[
      `assets/cam/${s.id}.mp4`,`assets/narration/${s.id}.words.json`,`assets/takes/${s.id}/1.mp4`
    ]).map(p=>[p,mediaHash(join(dir,p))]));
    browser=await launch();const page=await browser.newPage({width:320,height:180});
    const evidence={previousMixLead:.6,defaultLead:.35,keep:null,revert:null};
    async function verify(operation){
      assert.equal(readFileSync(join(dir,'storyboard.json'),'utf8'),originalStoryboard,'cleanup must not persist leads, durations or starts');
      for(const [p,hash] of Object.entries(unchangedFiles))assert.equal(mediaHash(join(dir,p)),hash,p);
      const samples=decode(join(dir,'assets/narration.m4a')),actual={};
      for(const scene of scenes){
        const lead=leads[scene.id];
        const cam=JSON.parse(readFileSync(join(dir,'assets/takes',scene.id,'takes.json'),'utf8')).cam.spec;
        assert.equal(cam.t0,1-lead,'camera keeps its existing per-scene lead');
        await v.sceneBuildUrl(scene.id,'disk');await page.goto(pathToFileURL(join(dir,'.build',scene.id+'-disk/index.html')).href);
        const pageTiming=await page.evaluate(`({lead:window.__slConfig.scenes[0].narrationLead,word:window.__at[${JSON.stringify(scene.id)}](${JSON.stringify('word:'+words[scene.id])}),cssWord:document.querySelector('#later-word') ? parseFloat(getComputedStyle(document.querySelector('#later-word')).animationDelay) : null})`);
        assert.equal(pageTiming.lead,lead);assert.ok(Math.abs(pageTiming.word-(lead+.1))<1e-9);
        if(scene.id===B)assert.ok(Math.abs(pageTiming.cssWord-(lead+.1))<1e-9,'visible word anchor keeps the default lead');
        const voice=onset(samples,scene.start,0,1.1,.02);
        actual[scene.id]={lead,page:pageTiming,camT0:cam.t0,voiceOnset:voice};
        assert.ok(Math.abs(voice-lead)<.01,`${operation} ${scene.id}: decoded voice ${voice.toFixed(6)}, page/camera lead ${lead}`);
      }
      const later=scenes.find(s=>s.id===B),sfx=onset(samples,later.start,1.5,2.2,.005);
      actual.later.sfxOnset=sfx;actual.later.sfxExpected=leads[B]+.1+1.2;
      assert.ok(Math.abs(sfx-actual.later.sfxExpected)<.01,`${operation}: word SFX at ${sfx}, expected ${actual.later.sfxExpected}`);
      assert.deepEqual(page.errors,[]);evidence[operation]=actual;
      if(process.env.NOISE_LEAD_EVIDENCE_DIR){mkdirSync(process.env.NOISE_LEAD_EVIDENCE_DIR,{recursive:true});copyFileSync(join(dir,'assets/narration.m4a'),join(process.env.NOISE_LEAD_EVIDENCE_DIR,operation+'.m4a'));}
    }
    const state=v.inspectNoise(A),preview=await v.previewNoise(A,{mode:'off',contextHash:state.contextHash});
    await v.keepNoise(A,{token:preview.preview.token,contextHash:preview.contextHash});await verify('keep');
    await v.revertNoise(A,{contextHash:v.inspectNoise(A).contextHash});await verify('revert');
    if(process.env.NOISE_LEAD_EVIDENCE_DIR)writeFileSync(join(process.env.NOISE_LEAD_EVIDENCE_DIR,'measurements.json'),JSON.stringify(evidence,null,2));
  }finally{await browser?.close();rmSync(root,{recursive:true,force:true});}
});
