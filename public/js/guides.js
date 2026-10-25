import { $, h } from './util.js';
import { S, api } from './state.js';
import { videoUrl } from './projects.js';
const tool = (name,args={}) => api(`/api/tools/${name}`,{body:{args,via:'page-js'}});
let initialized=false, catalogue=[], videos=[], selected=null, guide=null, current=null, generation=0, busy=false, loading=false;
const status = text => { $('#guideStatus').textContent=text; };
const identity = p => `${p.title} · v${p.version} · SHA-256 ${p.contentHash}`;
function contents(p) {
  return h('div',{class:'guide-contents'},
    h('p',{class:'muted small guide-identity'},identity(p)),
    h('p',{},p.guidance), h('h3',{},'Workflow'),h('ol',{},p.workflow.map(step=>h('li',{},step))),
    h('section',{class:'guide-example'},h('h3',{},`Worked example · ${p.example.title}`),h('p',{},p.example.situation),
      ...[['Draft script',p.example.script],['Visual explanation',p.example.visual],['Tool path to try',p.example.tools],['Expected result',p.example.expected]].map(([label,text])=>h('div',{},h('h4',{},label),h('p',{class:'guide-plain'},text)))),
    h('h3',{},'Review checklist'),h('ul',{},p.checklist.map(text=>h('li',{},text))),
    h('h3',{},'Reusable prompt'),h('p',{class:'guide-plain'},p.prompt));
}
export async function showGuides() {
  // Live refreshes update saved choices without discarding a prepared handoff.
  if (initialized) return refreshSaved();
  try {
    catalogue=(await tool('list_guides')).items;
    videos=S.projects.flatMap(p=>p.videos.map(v=>({project:p.name,video:v.name,label:`${p.title} / ${v.title} · ${v.name}`})));
    selected=videos.find(v=>v.project===S.project && v.video===S.video) ?? (videos.length===1?videos[0]:null);
    $('#guideVideo').replaceChildren(h('option',{value:'',selected:!selected},'Choose a video'),...videos.map((v,i)=>h('option',{value:String(i),selected:v===selected},v.label)));
    $('#guideVideo').onchange=e=>{ selected=e.target.value===''?null:videos[Number(e.target.value)]; loadTarget(); };
    $('#guideList').replaceChildren(...catalogue.map(p=>h('article',{class:'guide-card','data-guide':p.id},h('span',{class:'muted small'},`GUIDE · v${p.version}`),h('h2',{},p.title),h('p',{},p.summary),h('button',{class:'btn',onclick:()=>openGuide(p)},'Read guide & example'))));
    initialized=true;
    await loadTarget();
  } catch(e) { status(e.message); }
}
async function refreshSaved() {
  if (!selected || !current || busy || loading) return;
  const gen=generation, destination=selected, expected=current.contextHash;
  try {
    const next=await tool('get_video_guides',destination);
    if(gen!==generation || busy || current?.contextHash!==expected)return;
    if(next.contextHash!==expected) {current=next;renderAttached();renderControls();}
  } catch(e) {if(gen===generation)status(e.message);}
}
async function loadTarget() {
  const gen=++generation, destination=selected;
  current=null;loading=true;
  $('#guideHandoff').replaceChildren();$('#guideInstructions').replaceChildren();$('#guideAttached').replaceChildren();
  status('');if(guide)openGuide(guide,false);renderControls();
  $('#guideOpenVideo').hidden=!destination;
  if (destination) $('#guideOpenVideo').href=videoUrl(destination.project,destination.video);
  try {
    if (!destination) return;
    const results=await Promise.allSettled([tool('get_video_guides',destination),tool('get_project_instructions',{project:destination.project})]);
    if (gen!==generation) return;
    for (const result of results) if (result.status==='rejected') throw result.reason;
    current=results[0].value;
    const instructions=results[1].value;
    $('#guideInstructions').replaceChildren(h('h3',{},'Project instructions take priority'),h('p',{class:'muted small'},`Project: ${destination.project} · Video: ${destination.video}. These instructions and your explicit rules override Library guidance.`),h('details',{},h('summary',{},'Read project instructions'),h('pre',{class:'guide-plain'},instructions.markdown ?? 'No project.md. Add project instructions in the project before production.')));
    renderAttached();
  } catch(e) { if(gen===generation) status(e.message); }
  finally { if(gen===generation) { loading=false;renderControls(); } }
}
function openGuide(p,focus=true) {
  const gen=generation;
  guide=p;$('#guideHandoff').replaceChildren();status('');
  $('#guideDetail').replaceChildren(h('div',{class:'style-card-heading'},h('h2',{tabindex:-1},p.title),h('button',{class:'btn small',onclick:()=>{guide=null;$('#guideDetail').replaceChildren();$('#guideHandoff').replaceChildren();}},'Close')),
    contents(p),h('div',{class:'guide-actions'},h('button',{id:'guideOnce',class:'btn',onclick:()=>{if(gen===generation)useOnce();}},'Use once · prepare prompt'),h('button',{id:'guideAttach',class:'btn dark',onclick:()=>mutate('attach',p,gen)},'Attach to selected video')),
    h('p',{class:'muted small'},'Use once prepares text for the chat beside the page. Attach saves guidance for future get_rules calls. Neither action runs a task.'));
  renderControls();
  if(focus) $('#guideDetail h2').focus();
}
function renderAttached() {
  const gen=generation, expected=current.contextHash;
  $('#guideAttached').replaceChildren(h('h2',{},'Attached to this video'),
    ...(current.items.length ? [] : [h('p',{class:'muted'},'No guides attached.')]),
    ...current.items.map(p=>h('article',{class:'guide-attached','data-attached-guide':p.id},h('div',{class:'style-card-heading'},h('h3',{},`${p.title} · v${p.version}`),h('button',{class:'btn small guide-mutate',onclick:()=>mutate('remove',p,gen,expected)},'Remove guide')),h('details',{},h('summary',{},'Inspect saved contents · same copy the agent receives'),contents(p)))),
    h('button',{id:'guideUndo',class:'btn guide-mutate',onclick:()=>mutate('undo',null,gen,expected)},`Undo last guide change (${current.undoCount})`),h('p',{class:'muted small'},current.history));
}
function renderControls() {
  const enabled=!!selected && !!current && !busy && !loading;
  $('#guideVideo').disabled=busy;
  for(const b of document.querySelectorAll('.guide-mutate')) b.disabled=!enabled;
  if($('#guideUndo')) $('#guideUndo').disabled=!enabled || !current.undoCount;
  if($('#guideOnce')) $('#guideOnce').disabled=!enabled;
  if($('#guideAttach')) {
    const attached=current?.items.some(p=>p.id===guide?.id);
    $('#guideAttach').disabled=!enabled || attached;
    $('#guideAttach').textContent=attached?'Already attached':'Attach to selected video';
  }
  $('#guideTargetLabel').textContent=loading?'Loading selected video…':selected?`Selected video: ${selected.label}`:'Choose a video to prepare a prompt or attach guidance.';
}
async function useOnce() {
  if(busy || loading || !selected || !guide || !current)return;
  const gen=generation, destination=selected, p=guide;
  status('Preparing a prompt…');
  try {
    const r=await tool('use_guide_once',{...destination,guide:p.id,version:p.version,contentHash:p.contentHash});
    if(gen!==generation || guide!==p)return;
    const textarea=h('textarea',{id:'guidePrompt',readonly:true,rows:12,'aria-label':'One-time guide prompt'});textarea.value=r.prompt;
    const feedback=h('p',{role:'status',class:'muted small'},'Ready to copy. No guidance was attached and no task has run.');
    $('#guideHandoff').replaceChildren(h('h2',{},'One-time handoff'),h('p',{},`For ${destination.project} / ${destination.video}. Copy this exact selection into the chat beside the page. It includes the full versioned guide.`),textarea,h('button',{id:'guideCopy',class:'btn dark',onclick:async()=>{
      if(gen!==generation || guide!==p)return;
      try {
        if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(r.prompt);
        feedback.textContent='Copied. Paste into the chat beside the page to ask the agent to use it.';
      } catch {
        textarea.focus();textarea.select();
        feedback.textContent='Clipboard unavailable. The full prompt is selected; copy it with Ctrl+C or Command+C, then paste into chat.';
      }
    }},'Copy prompt'),feedback);
    status('One-time prompt ready. The video is unchanged.');
  } catch(e) {if(gen===generation)status(e.message);}
}
async function mutate(action,p,expectedGeneration,expectedContext) {
  if(expectedGeneration!==generation)return;
  if(busy || loading || !selected || !current)return;
  if(expectedContext && expectedContext!==current.contextHash){status("Guide attachments changed. Review the current saved contents before trying again.");return;}
  const gen=generation,destination=selected,contextHash=current.contextHash;
  busy=true;renderControls();status(`${action==='undo'?'Restoring':'Saving'} guide attachments for ${destination.label}…`);
  try {
    const r=await tool(action==='undo'?'undo_guides':`${action}_guide`,{...destination,contextHash,model:S.reviewer,...(p?{guide:p.id}:{}),...(action==='attach'?{version:p.version,contentHash:p.contentHash}:{})});
    if(gen!==generation)return;
    current=r;renderAttached();status(`${action==='attach'?'Guide attached':action==='remove'?'Guide removed':'Previous guide attachments restored'} · ${destination.label}. Scene content and project instructions are unchanged.`);
  } catch(e) { if(gen===generation){status(e.message); await loadTarget();status(e.message);} }
  finally {busy=false;renderControls();}
}
