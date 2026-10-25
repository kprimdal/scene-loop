import { $, h } from './util.js';
import { S, api } from './state.js';
import { videoUrl } from './projects.js';
const call=(name,args={})=>api(`/api/tools/${name}`,{body:{args,via:'page-js'}});
const Q=new URLSearchParams(location.search);
let initialized=false,catalog=[],videos=[],destination=null,scenes=[],info=null,selected=null,generation=0,busy=false;
let playing=!matchMedia('(prefers-reduced-motion: reduce)').matches;
const args=()=>({project:destination.project,video:destination.video,scene:$('#motionScene').value,model:S.reviewer});
const status=s=>$('#motionStatus').textContent=s;
const pre=()=>({baseVersion:info.version,contextHash:info.contextHash});
setInterval(()=>{
  if (!playing || $('#motionLibrary').hidden) return;
  for(const p of document.querySelectorAll('.motion-example')) if(p.ready && p.currentTime>=p.duration) {p.seek(0);p.play();}
},250);
document.addEventListener('librarysection',()=>{
  for(const p of document.querySelectorAll('.motion-example')) playing&&!$('#motionLibrary').hidden?p.play():p.pause();
  if($('#motionLibrary').hidden) $('#motionPreview').pause();
});
export async function showMotions() {
  if(initialized) return;
  initialized=true;
  try {
    catalog=(await call('list_motions')).items;
    videos=S.projects.flatMap(p=>p.videos.map(v=>({project:p.name,video:v.name,label:`${p.title} / ${v.title}`})));
    destination=videos.find(v=>v.project===(S.project||Q.get('project'))&&v.video===(S.video||Q.get('video'))) || (videos.length===1?videos[0]:null);
    $('#motionVideo').replaceChildren(h('option',{value:'',selected:!destination},'Choose a video'),...videos.map((v,i)=>h('option',{value:String(i),selected:v===destination},v.label)));
    $('#motionVideo').onchange=async e=>{destination=e.target.value===''?null:videos[Number(e.target.value)];await loadVideo();};
    $('#motionScene').onchange=()=>loadScene();
    $('#motionPlay').textContent=playing?'Pause examples':'Play examples';
    $('#motionPlay').onclick=e=>{playing=!playing;e.target.textContent=playing?'Pause examples':'Play examples';for(const p of document.querySelectorAll('.motion-example')) playing?p.play():p.pause();};
    $('#motionList').replaceChildren(...catalog.map(p=>{
      const preview=h('scene-player',{class:'motion-example',src:p.previewUrl,'aria-label':`${p.title} moving example`});
      preview.addEventListener('ready',()=>playing&&!$('#motionLibrary').hidden?preview.play():preview.seek(p.kind==='transition'?2.3:1.25));
      return h('article',{class:'style-card','data-motion':p.id},preview,h('div',{class:'style-card-body'},h('div',{class:'style-card-heading'},h('h2',{},p.title),h('span',{class:'muted small'},`v${p.version} · ${p.kind==='transition'?'Boundary':'Scene motion'}`)),h('p',{},p.summary),h('button',{class:'btn dark motion-choose',onclick:()=>{selected=p;renderForm();$('.motion-workspace').scrollIntoView({block:'start'});}},`Choose ${p.title}`)));
    }));
    $('#motionReplay').onclick=()=>{$('#motionPreview').seek(0);$('#motionPreview').play();};
    $('#motionWhole').onclick=()=>preview(true);
    await loadVideo(Q.get('scene')||S.sel);
  } catch(e) {initialized=false;status(e.message);}
}
async function loadVideo(preferred) {
  const gen=++generation, dest=destination;
  info=null;scenes=[];renderCurrent();renderForm();
  $('#motionScene').replaceChildren();
  $('#motionPreview').pause();$('#motionPreview').hidden=true;
  $('#motionOpenVideo').hidden=!dest;
  if(!dest) {status('Choose a video and scene.');return;}
  try {
    const list=await call('list_scenes',{project:dest.project,video:dest.video});
    if(gen!==generation) return;
    scenes=list.scenes;
    $('#motionScene').replaceChildren(...scenes.map(s=>h('option',{value:s.id,selected:s.id===preferred},s.title||s.id)));
    await loadScene();
  } catch(e){if(gen===generation)status(e.message);}
}
async function loadScene(time=0) {
  const gen=++generation;
  info=null;renderCurrent();renderForm();
  if(!destination || !$('#motionScene').value) return;
  const context=args();
  status('Inspecting scene and timing…');
  try {
    const data=await call('get_scene_motion',context);
    if(gen!==generation)return;
    info=data;
    $('#motionOpenVideo').href=videoUrl(context.project,context.video,{scene:context.scene});
    renderCurrent();renderForm();status(data.errors.join(' '));
    await preview(false,time,gen);
  } catch(e){if(gen===generation)status(e.message);}
}
async function preview(whole=false,time=0,gen=generation) {
  if(!info || !destination)return;
  const context=args();
  const r=await api(`/api/build/${whole?'whole':`scene/${context.scene}`}?${new URLSearchParams({project:context.project,video:context.video,...(!whole?{v:info.version}:{})})}`);
  if(gen!==generation)return;
  const player=$('#motionPreview');player.pause();player.setAttribute('src',r.url);
  player.addEventListener('ready',()=>{if(gen!==generation)return;player.hidden=false;player.seek(whole?(scenes.find(s=>s.id===context.scene)?.start||0):time);player.play();},{once:true});
  $('#motionReplay').textContent=whole?'Replay whole video':'Replay scene';
  $('#motionPreviewLabel').textContent=whole?'Whole video · includes the incoming boundary':'This scene · boundary appears only in Whole video';
}
async function mutate(name,extra={},time=0) {
  if(busy || !info)return;
  const gen=generation,context=args(),expected=pre();
  busy=true;setDisabled(true);status('Saving…');
  try {
    const r=await call(name,{...context,...expected,...extra});
    if(gen!==generation)return;
    await loadScene(r.timing?.t ?? time);
    status(r.timing?.warnings.length?r.timing.warnings.join(' '):name.includes('transition')?'Boundary saved in storyboard history. Preview Whole video to see it.':'Saved in scene versions. Replay to check the cue.');
    if(name.includes('transition'))await preview(true);
  } catch(e){if(gen===generation)status(`${e.message} Use Refresh scene to reload the current targets and choices.`);}
  finally{busy=false;setDisabled(false);}
}
function setDisabled(on) {
  for(const e of document.querySelectorAll('#motionLibrary button,#motionLibrary input,#motionLibrary select'))e.disabled=on;
  if(!on){renderForm();renderCurrent();}
}
function renderForm() {
  const gen=generation, captured=info;
  const form=$('#motionForm');form.replaceChildren();form.hidden=!selected;
  if(!selected)return;
  const p=selected;
  form.append(h('h2',{},p.title),h('p',{class:'muted small'},p.guidance));
  if(!info){form.append(h('p',{},'Choose a video and scene first.'));return;}
  if(p.kind==='transition'&&info.transition.first){form.append(h('p',{},'The first scene has no incoming boundary. Choose another scene.'));return;}
  const duration=h('input',{type:'number',min:.05,max:Math.min(5,info.duration),step:.05,value:p.duration,required:true});
  if(p.id!=='cut')form.append(h('label',{},'Duration (seconds)',duration));
  let target,start,mode,cue;
  if(p.kind==='motion') {
    target=h('select',{'aria-label':'Motion element'},...info.targets.map(t=>h('option',{value:t.id,disabled:!!t.reason},t.label+(t.reason?' · unavailable':''))));
    start=h('input',{type:'number',min:0,max:info.duration,step:.05,value:Math.min(1,Math.max(0,info.duration-p.duration)),required:true});
    mode=h('select',{'aria-label':'Motion timing'},h('option',{value:'seconds'},'Scene seconds'),h('option',{value:'word'},'Narration word'),h('option',{value:'sentence'},'Narration sentence'));
    cue=h('select',{'aria-label':'Narration cue'});
    const cueRow=h('label',{},'Cue',cue);cueRow.hidden=true;
    mode.onchange=()=>{
      cueRow.hidden=mode.value==='seconds';
      const words=info.words.length?info.words:((info.narration||'').match(/\S+/g)||[]).map(word=>({word}));
      const options=[];const counts={};let sentence=1;
      for(const w of words){
        const key=w.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
        if(mode.value==='word'&&key){counts[key]=(counts[key]||0)+1;options.push(h('option',{value:`word:${key}${counts[key]>1?'#'+counts[key]:''}`},`${w.word}${counts[key]>1?' (occurrence '+counts[key]+')':''}${w.start!=null?' · '+(w.start+info.narrationLead).toFixed(2)+' s':' · fallback until timed'}`));}
        if(mode.value==='sentence'&&(sentence===1||options.length<sentence)){options.push(h('option',{value:`sentence:${sentence}`},`Sentence ${sentence} · ${w.word}`));}
        if(/[.!?]["')]*$/.test(w.word))sentence++;
      }
      cue.replaceChildren(...options);
    };
    form.append(h('label',{},'Target element',target),h('label',{},'Start at',mode),cueRow,h('label',{},'Start / authored fallback (seconds)',start),h('p',{class:'muted small'},'A missing or out-of-scene word cue uses this fallback and reports a warning. Authored visibility and text start/end still apply.'));
  }
  form.append(h('button',{class:'btn dark',type:'submit',disabled:busy},p.kind==='transition'?'Apply boundary':'Apply motion'));
  form.onsubmit=e=>{e.preventDefault();if(gen!==generation || captured!==info || selected!==p || !form.checkValidity())return;mutate(p.kind==='transition'?'apply_transition':'apply_motion',{[p.kind==='transition'?'transition':'motion']:p.id,version:p.version,contentHash:p.contentHash,...(p.id!=='cut'?{duration:Number(duration.value)}:{}),...(target?{target:target.value,start:Number(start.value),...(mode.value!=='seconds'?{anchor:cue.value}:{})}:{})});};
}
function renderCurrent() {
  const box=$('#motionCurrent');box.replaceChildren();
  if(!info){box.append(h('p',{class:'muted'},'Choose a scene to inspect its saved choices.'));return;}
  const refresh=h('button',{class:'btn ghost small',disabled:busy,onclick:()=>loadScene()},'Refresh scene');
  box.append(h('h2',{},`Saved choices · v${info.version}`),refresh);
  for(const m of info.items){
    const timing=info.timing.find(t=>t.id===m.id);
    box.append(h('div',{class:'motion-saved'},h('strong',{},`${m.effect.title} · ${info.targets.find(t=>t.id===m.target)?.label||m.target}`),h('p',{class:'muted small'},`${m.anchor||'Scene seconds'} → ${timing.t} s · ${m.duration} s · v${m.effect.version}`),...timing.warnings.map(w=>h('p',{class:'motion-warning'},w)),h('button',{class:'btn small',disabled:busy,onclick:()=>mutate('remove_motion',{id:m.id})},`Remove ${m.effect.title}`)));
  }
  if(!info.items.length)box.append(h('p',{class:'muted'},'No managed motion. Authored animation stays as written.'));
  const version=h('select',{'aria-label':'Restore scene version'},...info.versions.map(v=>h('option',{value:v.v,selected:v.v===info.version},`v${v.v} · ${v.subject}`)));
  box.append(h('p',{class:'muted small'},'Scene versions restore content, motion, style and text together.'),version,h('button',{class:'btn small',disabled:busy,onclick:()=>mutate('restore_version',{version:Number(version.value)})},'Restore scene version'));
  if(info.transition.first)box.append(h('p',{},'First scene · no incoming boundary.'));
  else box.append(h('h3',{},`Incoming: ${info.transition.effective.type}${info.transition.effective.duration?' · '+info.transition.effective.duration+' s':''}`),h('div',{class:'motion-preview-controls'},h('button',{class:'btn small',disabled:busy||!info.transition.undoCount,onclick:()=>mutate('undo_transition')},'Undo transition'),h('button',{class:'btn small',disabled:busy,onclick:()=>mutate('reset_transition')},'Reset to default')),h('p',{class:'muted small'},'Storyboard history owns this boundary. Undo affects only this boundary, up to 10 changes. Reset uses the default 0.6 s dissolve.'));
}
