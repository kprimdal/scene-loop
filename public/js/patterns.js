import { $, h } from './util.js';
import { S, api } from './state.js';
import { videoUrl } from './projects.js';
const tool = (name,args={}) => api(`/api/tools/${name}`,{body:{args,via:'page-js'}});
let initialized = false, patterns = [], videos = [], selected = null, pattern = null, generation = 0, busy = false;
let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
setInterval(() => {
  if (!playing || $('#patternLibrary').hidden) return;
  for (const p of document.querySelectorAll('.pattern-preview')) if (p.ready && p.currentTime >= p.duration) { p.seek(0); p.play(); }
},250);
document.addEventListener('librarysection', () => {
  for (const p of document.querySelectorAll('.pattern-preview')) !$('#patternLibrary').hidden && playing ? p.play() : p.pause();
});
export async function showPatterns() {
  if (initialized) return;
  initialized = true;
  try {
    patterns = (await tool('list_patterns')).items;
    videos = S.projects.flatMap(p => p.videos.map(v => ({project:p.name,video:v.name,label:`${p.title} / ${v.title}`})));
    selected = videos.find(v => v.project===S.project && v.video===S.video) ?? (videos.length===1?videos[0]:null);
    $('#patternVideo').replaceChildren(h('option',{value:'',selected:!selected},'Choose a video'),...videos.map((v,i) => h('option',{value:String(i),selected:v===selected},v.label)));
    $('#patternVideo').onchange = e => {
      selected = e.target.value===''?null:videos[Number(e.target.value)];
      generation++;
      $('#patternForm').replaceChildren();
      $('#patternForm').hidden=true;
      $('#patternResult').replaceChildren();
      if (pattern) openPattern(pattern);
    };
    $('#patternMotion').textContent = playing?'Pause examples':'Play examples';
    $('#patternMotion').onclick = e => {
      playing = !playing;
      for (const p of document.querySelectorAll('.pattern-preview')) playing?p.play():p.pause();
      e.target.textContent = playing?'Pause examples':'Play examples';
    };
    $('#patternList').replaceChildren(...patterns.map(p => {
      const preview = h('scene-player',{class:'style-preview pattern-preview',src:p.previewUrl,'aria-label':`${p.title} moving example`});
      preview.addEventListener('ready',() => playing && !$('#patternLibrary').hidden ? preview.play():preview.seek(2.8));
      return h('article',{class:'style-card','data-pattern':p.id},preview,h('div',{class:'style-card-body'},h('div',{class:'style-card-heading'},h('h2',{},p.title),h('span',{class:'muted small'},`v${p.version}`)),h('p',{},p.summary),h('button',{class:'btn dark pattern-choose',onclick:() => openPattern(p)},`Use ${p.title}`)));
    }));
  } catch(e) { initialized=false; $('#patternResult').textContent=e.message; }
}
function openPattern(p) {
  pattern=p;
  const gen=++generation, destination=selected;
  const form=$('#patternForm');
  $('#patternResult').replaceChildren();
  const fields = p.fields.map(f => {
    const input = h(f.minItems?'textarea':'input',{id:`pattern-${f.key}`,name:f.key,...(f.minItems?{rows:f.maxItems+1}:{type:'text',maxlength:f.max}),required:!f.optional});
    input.value=f.minItems?p.defaults[f.key].join('\n'):p.defaults[f.key];
    return h('label',{},f.label,input,h('span',{class:'muted small'},f.minItems?`${f.minItems}–${f.maxItems} lines · one per line · up to ${f.max} characters each`:f.key==='media'?'Existing assets/ path in this video, including assets/cam/<scene>.mp4. Blank uses a labelled placeholder.':`Up to ${f.max} characters`));
  });
  const contentFields = p.id==='comparison' ? [fields[0],h('div',{class:'pattern-side-fields'},fields[1],fields[2]),h('div',{class:'pattern-side-fields'},fields[3],fields[4])] : fields;
  const title=h('input',{name:'title',type:'text',maxlength:100,required:true,value:p.defaults.heading});
  const duration=h('input',{name:'duration',type:'number',min:3,max:60,step:.1,required:true,value:8});
  const submit=h('button',{class:'btn dark',type:'submit',disabled:!destination||busy},'Create new scene');
  const status=h('p',{class:'muted small','aria-live':'polite'},destination?`New scene in ${destination.label}. Existing scenes stay as they are.`:'Choose a target video above.');
  form.replaceChildren(h('div',{class:'pattern-form-head'},h('h2',{},`Make it yours · ${p.title}`),h('button',{class:'btn ghost small',type:'button',onclick:()=>{generation++;form.replaceChildren();form.hidden=true;pattern=null;}},'Close')),h('div',{class:'pattern-fields'},...contentFields),h('div',{class:'pattern-fields pattern-meta'},h('label',{},'Scene name',title),h('label',{},'Duration (seconds)',duration)),status,submit);
  form.onsubmit=async e => {
    e.preventDefault();
    if (gen!==generation || busy || !destination || destination!==selected || !form.checkValidity()) return;
    const inputs=Object.fromEntries(p.fields.map(f=>[f.key,f.minItems?form.elements[f.key].value.split('\n').map(s=>s.trim()).filter(Boolean):form.elements[f.key].value]));
    const args={project:destination.project,video:destination.video,pattern:p.id,version:p.version,contentHash:p.contentHash,inputs,title:title.value,duration:Number(duration.value),model:S.reviewer};
    busy=true; submit.disabled=true; $('#patternVideo').disabled=true;
    for (const b of document.querySelectorAll('.pattern-choose')) b.disabled=true;
    status.textContent='Creating scene…';
    try {
      const r=await tool('instantiate_pattern',args);
      if (gen!==generation) return;
      status.textContent=`Created ${r.id} · v${r.version}. Edit and restore it in the video.`;
      $('#patternResult').replaceChildren(h('a',{class:'btn dark',href:videoUrl(destination.project,destination.video,{scene:r.id})},'Open new scene →'),r.soundtrackWarning?h('p',{class:'muted small'},r.soundtrackWarning):null);
    } catch(e) { if(gen===generation) status.textContent=e.message; }
    finally {
      busy=false; $('#patternVideo').disabled=false;
      for (const b of document.querySelectorAll('.pattern-choose')) b.disabled=false;
      if (gen===generation) submit.disabled=!selected;
    }
  };
  form.hidden=false;
  form.scrollIntoView({block:'nearest'});
  form.querySelector('input,textarea')?.focus({preventScroll:true});
}
