import { $, h } from './util.js';
import { S, latest, viewed } from './state.js';
import { player } from './stage.js';
const scope=id=>JSON.stringify([S.project,S.video,id,S.view[id]??null]);
let mounted=null;
function stop(){document.querySelectorAll('.range-body audio,.range-body video').forEach(a=>a.pause());}
document.addEventListener('play',e=>{if(e.target.closest?.('.range-body')){player.pause();document.querySelectorAll('audio,video').forEach(a=>{if(a!==e.target && a.id!=='recPreview')a.pause();});}else stop();},true);
document.addEventListener('keydown',e=>{if(e.target.closest?.('.range-body'))e.stopPropagation();},true);
function mount(container,id,key){
  const body=container.querySelector('.range-body');let busy=false,data=null,revision=0;
  let from=0,to=null,action='remove';
  const valid=()=>container.isConnected && S.sel===id && scope(id)===key && viewed()===latest(S.data.scenes.find(s=>s.id===id));
  const message=h('p',{class:'range-status',role:'status','aria-live':'polite'});
  const button=(text,fn)=>{const b=h('button',{type:'button',class:'btn'},text);b.onclick=()=>{if(b.isConnected && valid() && !busy)fn();};return b;};
  const media=(label,url,video=false)=>h('label',{},h('span',{},label),h(video?'video':'audio',{src:url,controls:true,preload:'metadata','aria-label':label}));
  async function call(name,args={}){
    if(!valid()||busy)return;
    busy=true;const rev=++revision;
    body.querySelectorAll('button,input,select').forEach(b=>b.disabled=true);
    message.textContent=name==='preview_recording_range'?'Preparing the range and impact report…':name==='inspect_recording_ranges'?'Reading the current recording…':'Preparing audio, camera and soundtrack…';
    const target={project:S.project,video:S.video,scene:id};
    try{
      // Capture the entire target before awaiting. Late results cannot repaint a new scene.
      const r=await fetch('/api/tools/'+name+'?'+new URLSearchParams(target),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({args:{...target,...args},via:'page-js'})});
      const result=await r.json();if(!r.ok)throw new Error(result.error??r.statusText);
      if(!valid()||rev!==revision)return;
      if(name==='inspect_recording_ranges' && JSON.stringify(result)===JSON.stringify(data)){message.textContent='';return;}
      data=result;if(to===null||to>data.seconds)to=data.seconds;
      paint();message.textContent=result.historyWarning??(name==='apply_recording_range'?'Applied. Preview and export now use this edit.':name==='undo_recording_range'?'Previous recording edit restored. Current soundtrack rebuilt.':'');
    }catch(e){if(valid()&&rev===revision)message.textContent=e.message;}
    finally{if(valid()&&rev===revision){busy=false;body.querySelectorAll('button,input,select').forEach(b=>b.disabled=false);}}
  }
  function paint(){
    stop();body.replaceChildren(message);
    if(!data?.supported){body.append(h('p',{},data?.reason??'Select a chosen recorded take. External narration is unavailable here.'),button('Refresh recording',()=>call('inspect_recording_ranges')));return;}
    const d=data;
    body.append(h('p',{class:'range-clock'},'Current edited recording seconds'),h('p',{},`${id} · Take ${d.take} · 0–${d.seconds.toFixed(3)} s · ${d.mode} cleanup`),
      h('p',{class:'small'},`Scene time = recording time + ${d.lead.toFixed(3)} s narration lead. Scene duration ${d.duration.toFixed(3)} s.`));
    const audio=media('Current recording · seek here to mark a range',d.currentUrl);const a=audio.querySelector('audio');body.append(audio);
    const input=(label,value,set)=>{const el=h('input',{type:'number',min:0,max:d.seconds,step:.001,value, 'aria-label':label,oninput:e=>{set(e.target.valueAsNumber);invalidate();}});return h('label',{},label,el);};
    const inputs=h('div',{class:'range-inputs'},input('Start (recording seconds)',from,n=>from=n),input('End (recording seconds)',to,n=>to=n));
    const invalidate=()=>{body.querySelector('.range-impact')?.remove();body.querySelector('.range-apply')?.remove();};
    body.append(inputs,button('Mark start at playhead',()=>{from=Math.round(a.currentTime*1000)/1000;inputs.querySelectorAll('input')[0].value=from;invalidate();}),button('Mark end at playhead',()=>{to=Math.round(a.currentTime*1000)/1000;inputs.querySelectorAll('input')[1].value=to;invalidate();}),
      button('Preview selected range',async()=>{if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to>d.seconds){message.textContent='Use 0 ≤ start < end ≤ recording duration.';return;}a.currentTime=from;try{await a.play();}catch(e){message.textContent=e.message;}const end=()=>{if(a.currentTime>=to){a.pause();a.removeEventListener('timeupdate',end);}};a.addEventListener('timeupdate',end);}),
      h('div',{class:'range-actions'},...['remove','mute','keep'].map(value=>button(({remove:'Remove range',mute:'Mute range · voice only',keep:'Keep only range'})[value],()=>{action=value;call('preview_recording_range',{contextHash:d.contextHash,action,from,to});}))),
      button('Refresh recording',()=>call('inspect_recording_ranges')));
    const candidate=d.pending;
    const p=candidate && candidate.impact.selection.from===Math.round(from*1000)/1000 && candidate.impact.selection.to===Math.round(to*1000)/1000 ? candidate:null,impact=d.impact??p?.impact;
    if(impact){
      const report=h('div',{class:'range-impact'},h('h4',{},`${({remove:'Remove range',mute:'Mute voice only',keep:'Keep only range'})[impact.action]} · review before applying`),
        h('p',{},`Selected ${impact.selection.from}–${impact.selection.to} s. Recording ${impact.oldAudioSeconds} → ${impact.newAudioSeconds} s. Scene ${impact.oldDuration.toFixed(3)} → ${impact.newDuration.toFixed(3)} s.`),
        h('p',{class:'small'},`Lead ${impact.lead.toFixed(3)} s; preserved tail ${impact.tail.toFixed(3)} s; frame rounding adds ${impact.rounding.extraSeconds.toFixed(6)} s at ${impact.rounding.fps} fps.`));
      for(const error of impact.errors)report.append(h('p',{class:'range-status'},error));
      report.append(h('p',{},`${impact.removedWords.length} removed words; ${impact.affectedWords.length} partially cut words. ${impact.script}`));
      if(impact.captions)report.append(h('p',{},impact.captions.message));
      report.append(h('p',{class:'small'},impact.authoredMotion),h('p',{class:'small'},impact.cleanup),
        h('details',{},h('summary',{},'Exact words, anchors, captions and original ranges'),h('pre',{},JSON.stringify(impact,null,2))));
      body.append(report);
      if(p && impact.canApply){report.append(media('Prepared result · edited recording clock starts at 0',p.audioUrl));
        if(p.camUrl)report.append(media('Prepared camera · scene clock includes narration lead',p.camUrl,true));
        const apply=button('Apply reviewed range',()=>call('apply_recording_range',{contextHash:d.contextHash,token:p.token}));apply.classList.add('range-apply');body.append(apply,button('Dismiss preview (not applied)',()=>{data={...d,pending:null,impact:null};paint();}));}
    }
    if(d.pendingStale)body.append(h('p',{},'The earlier range preview expired after another edit. Prepare a fresh range.'));
    if(d.canUndo)body.append(button('Undo previous recording edit',()=>call('undo_recording_range',{contextHash:d.contextHash})));
    if(d.undoConflict)body.append(h('p',{},d.undoConflict));
    body.append(h('details',{},h('summary',{},'Original mapping and recovery'),h('p',{},d.clock),h('pre',{},JSON.stringify({originalTakeRanges:d.segments,voiceMutesInCurrentRecording:d.mutes},null,2)),media('Original full take · original clock',d.original.url),h('p',{class:'small'},d.recovery)));
  }
  paint();return {key,refresh:()=>call('inspect_recording_ranges')};
}
export function renderRanges(){
  const container=$('#recordingRanges');if(!container||S.guest||!S.sel)return;
  const sc=S.data.scenes.find(s=>s.id===S.sel),key=scope(S.sel);
  if(!sc||viewed(sc)!==latest(sc)) {stop();mounted=null;container.querySelector('.range-body').replaceChildren(h('p',{},'Range editing requires the latest scene view. Return to latest to edit the selected recording.'));return;}
  const stamp=JSON.stringify([S.data.stamp,latest(sc),sc.words,sc.audio]);
  if(!mounted||mounted.key!==key){stop();mounted=mount(container,S.sel,key);mounted.stamp=stamp;container.ontoggle=()=>{if(container.open)mounted.refresh();else stop();};if(container.open)mounted.refresh();}
  else if(mounted.stamp!==stamp){mounted.stamp=stamp;if(container.open)mounted.refresh();}
}
