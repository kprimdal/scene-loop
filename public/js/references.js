import { $, h } from './util.js';
import { S, api } from './state.js';
import { videoUrl } from './projects.js';
const tool=(name,args)=>api(`/api/tools/${name}`,{body:{args,via:'page-js'}});
let initialized=false,project='',video='',library=null,attachments=null,generation=0,busy=false,loading=false,objectUrl=null;
const status=text=>{$('#referenceStatus').textContent=text;};
const target=()=>({project,video});
const rangeText=i=>`${i.range.start}–${i.range.end} s · ${i.media?'local media time':'source time · unverified'}`;
const button=(label,fn,attrs={})=>h('button',{type:'button',class:'btn',onclick:fn,...attrs},label);
const pause=()=>{for(const v of document.querySelectorAll('#referenceLibrary video'))v.pause();};
function clearDetail() {pause();if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}$('#referenceDetail').replaceChildren();}
function controls() {
  for(const id of ['referenceProject','referenceVideo'])$('#'+id).disabled=busy;
  for(const b of document.querySelectorAll('#referenceLibrary [data-write]'))b.disabled=busy||loading||!library||!project||b.dataset.blocked==='true';
  $('#referenceNew').disabled=busy||loading||!library||!project;
  $('#referenceUndoLibrary').disabled=busy||loading||!library?.undoCount;
  $('#referenceUndoAttachments').disabled=busy||loading||!attachments?.undoCount;
  $('#referenceScope').textContent=project?`Private to project: ${project}. ${video?`Attachment target: ${project} / ${video}.`:'Choose a video to attach references.'} Owners only.`:'Choose a project. References stay within that project, separate from shared music.';
}
export async function showReferences() {
  if(initialized){if(!busy && !loading)await refresh();return;}
  initialized=true;
  project=S.projects.some(p=>p.name===S.project)?S.project:S.projects.length===1?S.projects[0].name:'';
  $('#referenceProject').replaceChildren(h('option',{value:'',selected:!project},'Choose a project'),...S.projects.map(p=>h('option',{value:p.name,selected:p.name===project},p.title)));
  $('#referenceProject').onchange=e=>{project=e.target.value;video='';setVideos();loadTarget();};
  $('#referenceVideo').onchange=e=>{video=e.target.value;loadTarget();};
  $('#referenceSearch').oninput=renderList;$('#referenceTag').onchange=renderList;$('#referenceRemoved').onchange=renderList;
  $('#referenceNew').onclick=()=>editForm();
  $('#referenceUndoLibrary').onclick=()=>mutate('undo_reference_library',{contextHash:library.contextHash},'Library metadata restored');
  $('#referenceUndoAttachments').onclick=()=>mutate('undo_reference_attachments',{contextHash:attachments.contextHash},'Previous attachment snapshots restored');
  document.addEventListener('librarysection',()=>{if($('#referenceLibrary').hidden)pause();});
  setVideos();await loadTarget();
}
function setVideos() {
  const videos=S.projects.find(p=>p.name===project)?.videos??[];
  video=videos.some(v=>v.name===S.video)?S.video:videos.length===1?videos[0].name:'';
  $('#referenceVideo').replaceChildren(h('option',{value:'',selected:!video},'Choose a video'),...videos.map(v=>h('option',{value:v.name,selected:v.name===video},v.title)));
}
async function loadTarget() {
  const gen=++generation;library=attachments=null;loading=true;clearDetail();status('');
  $('#referenceList').replaceChildren();$('#referenceAttached').replaceChildren();$('#referenceRules').replaceChildren();
  controls();await refresh();if(gen===generation){loading=false;controls();}
}
async function refresh() {
  if(!project)return;
  const gen=generation,dest=target();
  try {
    const results=await Promise.all([tool('list_references',{project:dest.project}),dest.video?tool('get_video_references',dest):null,tool('get_project_instructions',{project:dest.project})]);
    if(gen!==generation || busy)return;
    library=results[0];attachments=results[1];
    $('#referenceRules').replaceChildren(h('details',{},h('summary',{},'Project instructions take priority'),h('pre',{class:'guide-plain'},results[2].markdown??'No project.md yet. Add project instructions before production.')));
    const oldTag=$('#referenceTag').value;
    const tags=[...new Set(library.items.flatMap(i=>i.tags))].sort();
    $('#referenceTag').replaceChildren(h('option',{value:''},'All tags'),...tags.map(t=>h('option',{value:t,selected:t===oldTag},t)));
    renderList();renderAttachments();controls();
  } catch(e){if(gen===generation)status(e.message);}
}
function renderList() {
  if(!library)return;
  const text=$('#referenceSearch').value.trim().toLowerCase(),tag=$('#referenceTag').value,removed=$('#referenceRemoved').checked,gen=generation,expected=library.contextHash;
  const items=library.items.filter(i=>(removed||!i.removed)&&(!tag||i.tags.includes(tag))&&[i.title,i.intent,i.creator,...i.tags].join(' ').toLowerCase().includes(text));
  $('#referenceCount').textContent=`${items.length} shown · ${library.items.filter(i=>!i.removed).length} saved in ${project}`;
  $('#referenceList').replaceChildren(...(items.length?items.map(i=>h('article',{class:'reference-card','data-reference':i.id},h('div',{class:'muted small'},`${i.media?'VIDEO':'SOURCE LINK'} · v${i.version}${i.removed?' · REMOVED':''}`),h('h3',{},i.title),h('p',{class:'small'},rangeText(i)),h('p',{},i.intent),h('div',{class:'tags'},...i.tags.map(t=>h('span',{class:'tag'},t))),button(i.removed?'Inspect / restore':'Inspect reference',()=>{if(gen===generation)inspect(i,expected);}))):[h('p',{class:'muted'},library.items.length?'No references match these filters.':'Save a video or source link for this project.')]));
}
function notes(i) {
  return h('div',{class:'reference-notes'},h('h3',{},'What matters'),h('p',{class:'guide-plain'},i.intent),
    ...[['Observations',i.analysis.observations],['Desired qualities',i.analysis.desiredQualities],['Reproduction gaps',i.analysis.gaps]].map(([label,text])=>h('div',{},h('h4',{},label),h('p',{class:'guide-plain'},text||'Not supplied.'))),
    h('p',{class:'muted small'},`Analysis: ${i.analysis.provenance} supplied · not machine-verified. No automatic analysis.`),
    h('h4',{},'Source & credit'),h('p',{class:'guide-plain'},[i.creator,i.license,i.credit].filter(Boolean).join('\n')||'Not supplied.'),
    i.sourceUrl?h('a',{class:'btn small',href:i.sourceUrl,target:'_blank',rel:'noopener noreferrer'},'Open source'):null,
    h('p',{class:'muted small guide-identity'},`${i.id} · v${i.version} · SHA-256 ${i.contentHash}`));
}
function preview(url,getRange) {
  const player=h('video',{controls:true,preload:'metadata',playsinline:true,src:url,'aria-label':'Reference video preview'});
  const loop=h('input',{type:'checkbox','aria-label':'Loop selected range'}),feedback=h('p',{class:'muted small',role:'status'},'Preview the selected range. Original media stays intact.');
  let active=false;
  const range=()=>{const r=getRange();if(!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<=r.start||(Number.isFinite(player.duration)&&r.end>player.duration+1e-6))throw new Error('Choose 0 ≤ start < end within the local media duration.');return r;};
  player.addEventListener('error',()=>{feedback.textContent='This browser cannot play this file’s codec. The original is preserved; use the media link to inspect it externally.';});
  player.addEventListener('timeupdate',()=>{if(!active)return;try{const r=range();if(player.currentTime>=r.end){if(loop.checked){player.currentTime=r.start;player.play().catch(()=>{});}else{active=false;player.pause();player.currentTime=r.end;}}}catch{active=false;player.pause();}});
  return {player,node:h('div',{class:'reference-preview'},player,h('div',{class:'reference-actions'},button('Play selected range',async()=>{try{const r=range();player.currentTime=r.start;active=true;await player.play();feedback.textContent=`Playing ${r.start}–${r.end} s of the local file.`;}catch(e){feedback.textContent=e.message;}}),button('Stop / seek to start',()=>{active=false;player.pause();try{player.currentTime=range().start;}catch(e){feedback.textContent=e.message;}}),h('label',{class:'reference-check'},loop,'Loop range'),h('a',{class:'btn small',href:url,target:'_blank',rel:'noopener noreferrer'},'Open original media')),feedback)};
}
function inspect(i,expected=library.contextHash) {
  clearDetail();const gen=generation,ctx=attachments?.contextHash;
  const attached=attachments?.items.find(a=>a.id===i.id);
  $('#referenceDetail').replaceChildren(h('div',{class:'style-card-heading'},h('h2',{tabindex:-1},i.title),button('Close',clearDetail)),h('p',{},rangeText(i)),
    i.media?preview(i.media.url,()=>i.range).node:h('p',{class:'reference-unverified'},'Link only: media duration and contents are unverified. Open the source to inspect it. This page does not download or embed it.'),
    notes(i),h('div',{class:'reference-actions'},
      button('Edit metadata / range',()=>{if(gen===generation)editForm(i,expected);},{disabled:i.removed,'data-write':true,'data-blocked':String(i.removed)}),
      button(i.removed?'Restore reference':'Remove from library',()=>{if(gen===generation)mutate(i.removed?'restore_reference':'remove_reference',{reference:i.id,contextHash:expected},i.removed?'Reference restored':'Reference removed; original media and attached snapshots retained');},{'data-write':true}),
      button(attached?(attached.contentHash===i.contentHash?'Already attached':'Update attachment explicitly'):'Attach to selected video',()=>{if(gen===generation)mutate(attached?'update_reference_attachment':'attach_reference',{reference:i.id,contentHash:i.contentHash,contextHash:ctx},'Exact reference snapshot saved to the selected video');},{disabled:!video||!attachments||i.removed||attached?.contentHash===i.contentHash,'data-attach':true})),
    h('p',{class:'muted small'},'Guidance only. This does not insert media into the rendered video or promise recreation.'));
  $('#referenceDetail h2').focus();
}
function field(label,name,value='',attrs={}) {const el=h(attrs.rows?'textarea':'input',{name,id:'ref-'+name,...attrs});el.value=value;return h('label',{},label,el);}
function editForm(item=null,expected=library.contextHash) {
  clearDetail();const gen=generation,dest=target(),form=h('form',{id:'referenceForm'}),fields=h('div',{class:'reference-fields'});
  fields.append(field('Title','title',item?.title??'',{required:true,maxlength:160}),field('Source URL · http(s), never downloaded','sourceUrl',item?.sourceUrl??'',{type:'url',maxlength:2000}),field('Start · seconds in this file (or unverified source)','start',item?.range.start??0,{type:'number',step:'any',min:0,required:true}),field('End · seconds in this file (or unverified source)','end',item?.range.end??1,{type:'number',step:'any',min:0,required:true}),field('Intent · what matters to this video','intent',item?.intent??'',{rows:3,required:true,maxlength:3000}),field('Tags · comma separated','tags',item?.tags.join(', ')??'',{maxlength:1219}),field('Creator','creator',item?.creator??'',{maxlength:300}),field('License','license',item?.license??'',{maxlength:300}),field('Credit / original source offsets, if known','credit',item?.credit??'',{rows:2,maxlength:2000}),
    ...[['Observations · what is in the reference','observations'],['Desired qualities · what to carry forward','desiredQualities'],['Reproduction gaps · limits or missing evidence','gaps']].map(([label,key])=>field(label,key,item?.analysis[key]??'',{rows:2,maxlength:4000})));
  const provenance=h('select',{name:'provenance',id:'ref-provenance'},...['user','agent'].map(value=>h('option',{value,selected:value===(item?.analysis.provenance??'user')},`${value} supplied · not machine-verified`)));
  fields.append(h('label',{},'Analysis provenance',provenance));
  const mediaArea=h('div'),fileInput=h('input',{type:'file',id:'referenceFile',accept:'video/mp4,video/webm,video/quicktime,.mov'});
  const getRange=()=>({start:Number(form.elements.start.value),end:Number(form.elements.end.value)});
  const setPreview=url=>{const p=preview(url,getRange);mediaArea.replaceChildren(p.node,h('div',{class:'reference-actions'},button('Use current time as start',()=>{form.elements.start.value=p.player.currentTime.toFixed(3);}),button('Use current time as end',()=>{form.elements.end.value=p.player.currentTime.toFixed(3);})));return p.player;};
  if(item?.media)setPreview(item.media.url);
  if(!item)fileInput.onchange=()=>{
    if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}mediaArea.replaceChildren();
    const file=fileInput.files[0];if(!file)return;
    if(file.size>100*1024*1024){fileInput.value='';status('Reference upload limit is 100 MiB.');return;}
    const url=objectUrl=URL.createObjectURL(file),initialRange={start:form.elements.start.value,end:form.elements.end.value},p=setPreview(url);
    p.addEventListener('loadedmetadata',()=>{
      if(gen!==generation || objectUrl!==url)return;
      // Duration may arrive after the user has chosen a range. Only fill an untouched pair.
      if(form.elements.start.value===initialRange.start && form.elements.end.value===initialRange.end){form.elements.start.value=0;form.elements.end.value=Number.isFinite(p.duration)?Math.floor(p.duration*1000)/1000:1;}
    },{once:true});
  };
  form.append(h('div',{class:'style-card-heading'},h('h2',{},item?'Edit reference':'Save a reference'),button('Cancel',clearDetail,{'data-write':true})),h('p',{class:'muted small'},`Save in project ${dest.project}. ${item?'Media is immutable; attached videos keep their previous snapshots.':'Choose a local video (100 MiB maximum), a source URL, or both. The full local file is preserved.'}`),...(!item?[h('label',{class:'reference-file'},'Video file',fileInput)]:[]),mediaArea,fields,h('p',{class:'muted small'},'Local ranges use this uploaded file’s clock. If it is an excerpt, record original-source offsets in Credit. Link contents and supplied notes are unverified.'),h('button',{type:'submit',class:'btn dark','data-write':true},item?'Save metadata / range':'Save reference'));
  form.onsubmit=async e=>{
    e.preventDefault();if(gen!==generation||busy||loading)return;
    const data=Object.fromEntries(new FormData(form));
    const args={...dest,contextHash:expected,model:S.reviewer,...data,start:Number(data.start),end:Number(data.end),tags:data.tags.split(',').map(t=>t.trim()).filter(Boolean),analysis:Object.fromEntries(['observations','desiredQualities','gaps','provenance'].map(k=>[k,data[k]]))};
    if(item)args.reference=item.id;
    busy=true;controls();status(`Saving reference in ${dest.project}…`);
    try {
      let r;
      if(!item && fileInput.files[0]) {
        const file=fileInput.files[0];
        const mime=file.type||(/\.mov$/i.test(file.name)?'video/quicktime':/\.webm$/i.test(file.name)?'video/webm':'video/mp4');
        const response=await fetch('/api/references/upload?'+new URLSearchParams({project:dest.project}),{method:'POST',headers:{'Content-Type':'application/x-scene-loop-reference'},body:new Blob([JSON.stringify({metadata:args,mime})+'\n',file])});
        r=await response.json();if(!response.ok)throw new Error(r.error??'Upload failed.');
      } else r=await tool(item?'edit_reference':'save_reference',args);
      if(gen!==generation)return;
      library=r;renderList();const saved=item?r.items.find(i=>i.id===item.id):r.items.at(-1);inspect(saved);status('Reference saved. Attach or explicitly update the snapshot for the selected video.');
    }catch(e){if(gen===generation)status(e.message);}
    finally{busy=false;controls();}
  };
  $('#referenceDetail').append(form);$('#ref-title').focus();
}
function renderAttachments() {
  const gen=generation,ctx=attachments?.contextHash;
  $('#referenceAttached').replaceChildren(h('h2',{},video?`Attached to ${project} / ${video}`:'Choose a video for attachments'),...(attachments?.items??[]).map(i=>h('article',{class:'reference-attached','data-attached-reference':i.id},h('div',{class:'style-card-heading'},h('h3',{},`${i.title} · saved v${i.version}`),button('Detach reference',()=>{if(gen===generation)mutate('detach_reference',{reference:i.id,contextHash:ctx},'Reference detached; original media retained');},{'data-write':true})),h('p',{},rangeText(i)),h('details',{},h('summary',{},'Inspect exact snapshot · same copy the agent receives'),i.media?preview(i.media.url,()=>i.range).node:null,notes(i),h('pre',{class:'reference-json'},JSON.stringify(i,null,2))))),...(attachments && !attachments.items.length?[h('p',{class:'muted'},'No references attached to this video.')]:[]));
  $('#referenceHistory').textContent=library?.history??'';
}
async function mutate(name,args,message) {
  if(busy||loading||!library)return;
  const gen=generation,dest=target();busy=true;controls();status(`Saving for ${dest.project}${dest.video?' / '+dest.video:''}…`);
  try {
    await tool(name,{...dest,...args,model:S.reviewer});
    if(gen!==generation)return;clearDetail();busy=false;await refresh();status(`${message}. ${dest.project}${dest.video?' / '+dest.video:''}.`);
  }catch(e){if(gen===generation)status(e.message);}
  finally{busy=false;controls();}
}
