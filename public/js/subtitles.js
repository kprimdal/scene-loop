// Shared, bounded markup for saved captions and the unsaved page preview. No input CSS/HTML.
export const SUBTITLE_STYLES = {
  dark: { id: 'dark', version: 1, label: 'Dark card', css: 'background:#15202b!important;color:#fff!important;' },
  light: { id: 'light', version: 1, label: 'Light card', css: 'background:#fff!important;color:#15202b!important;' },
  shadow: { id: 'shadow', version: 1, label: 'White · shadow', css: 'background:transparent!important;color:#fff!important;text-shadow:0 2px 6px #000,0 0 3px #000!important;' },
};
export function validateCues(cues, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Scene duration must be finite and positive.');
  if (!Array.isArray(cues) || cues.length > 200) throw new Error('Use at most 200 caption cues per scene.');
  let end = 0;
  return cues.map((c, i) => {
    if (!c || typeof c.text !== 'string' || !c.text.trim() || c.text.length > 84 || c.text.split(/\r\n|\r|\n/).length > 2 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c.text)) throw new Error(`Caption ${i+1}: enter 1–84 characters on at most 2 lines.`);
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < end || c.start < 0 || c.end <= c.start || c.end > duration || c.end-c.start > 8) throw new Error(`Caption ${i+1}: use ordered, non-overlapping 0 ≤ start < end ≤ ${duration} s, at most 8 s per cue. Edit or remove captions before shortening this scene.`);
    end = c.end;
    return { text: c.text, start: c.start, end: c.end };
  });
}
const escapeText = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function subtitleMarkup(scene, snapshot) {
  if (!snapshot) return '';
  if (!/^[a-zA-Z][\w-]*$/.test(scene)) throw new Error('Invalid caption scene id.');
  return snapshot.cues.map((c,i) => {
    const name = `sl-caption-${scene}-${i}`;
    return `<style data-sl-caption-css>@keyframes ${name}{from{opacity:1}to{opacity:0}}</style>
<div data-sl-caption="${i}" style="all:initial;position:absolute!important;inset:0!important;z-index:2147483100!important;pointer-events:none!important;box-sizing:border-box!important;padding:5% 6% 7%!important;display:flex!important;align-items:flex-end!important;justify-content:center!important;visibility:inherit!important;opacity:0;animation:${name} ${c.end-c.start}s steps(1,end) ${c.start}s forwards!important;">
<div style="all:initial;visibility:inherit!important;display:block!important;box-sizing:border-box!important;max-width:100%!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;text-align:center!important;font-family:Arial,Helvetica,sans-serif!important;font-size:min(5vw,5vh)!important;font-weight:700!important;line-height:1.25!important;padding:.25em .5em!important;border-radius:.15em!important;${snapshot.style.css}">${escapeText(c.text)}</div></div>`;
  }).join('\n');
}

let render = () => {};
export const renderSubtitles = () => render();
// Node imports only the pure functions above; the browser installs selected-scene controls.
if (typeof document !== 'undefined') startEditor();
async function startEditor() {
  const [{ $, h }, { S, api, scene, latest, viewed }, { player }, { refresh }] = await Promise.all([import('./util.js'),import('./state.js'),import('./stage.js'),import('./data.js')]);
  const box = $('#sceneSubtitles');
  let ctx, serial = 0, info, draft, selected = 0, previewState, generated = false;
  const key = () => S.data && !S.overview && [S.project,S.video,S.sel,S.mode,viewed(),latest(scene()),S.data.stamp,scene().subtitles?.contextHash,!!S.compare].join(':');
  const editable = () => S.mode === 'scene' && viewed() === latest(scene()) && !S.compare;
  const args = () => ({ project:S.project,video:S.video,scene:S.sel });
  const call = (name, a) => api(`/api/tools/${name}`,{body:{args:{...args(),...a},via:'page-js'}});
  function restorePreview() {
    if (!previewState) return;
    const {root,original} = previewState;
    root.querySelectorAll('[data-sl-caption],[data-sl-caption-css]').forEach(e=>e.remove());
    root.prepend(...original); previewState = null;
    if (player.ready) player.seek(player.currentTime);
  }
  function preview() {
    if (!draft || !editable() || key() !== ctx || !player.ready) return;
    const frame = [...player.querySelectorAll('iframe')].find(f=>f.style.visibility==='visible');
    const root = frame?.contentDocument?.querySelector(`#sc-${S.sel}`);
    if (!root) return;
    if (previewState?.root !== root) {
      restorePreview(); previewState = {root,original:[...root.querySelectorAll('[data-sl-caption],[data-sl-caption-css]')].map(e=>e.cloneNode(true))};
    }
    root.querySelectorAll('[data-sl-caption],[data-sl-caption-css]').forEach(e=>e.remove());
    const template = root.ownerDocument.createElement('template'); template.innerHTML = subtitleMarkup(S.sel,draft); root.prepend(template.content);
    player.seek(player.currentTime);
  }
  render = () => {
    if (S.guest || !S.data || S.overview) { restorePreview(); box.hidden = true; return; }
    box.hidden = false;
    if (key() === ctx) return;
    restorePreview(); ctx = key(); draft = null; info = null; generated=false; ++serial;
    box.replaceChildren(h('summary',{},'Captions'),h('div',{class:'text-body muted small'},'Loading…'));
    if (box.open) load();
  };
  async function load() {
    const here = ctx, generation = ++serial;
    try {
      const result = await call('get_scene_subtitles',{version:viewed()});
      if (ctx !== here || serial !== generation || key() !== here || !box.open) return;
      info = result; generated=false; draft = structuredClone(result.snapshot); selected = 0; draw();
    } catch(e) { if (ctx===here && serial===generation) box.lastChild.textContent=e.message; }
  }
  function discard() {
    restorePreview(); info=null; draft=null; generated=false; ++serial;
    box.replaceChildren(h('summary',{},'Captions'),h('div',{class:'text-body muted small'},'Loading…'));
  }
  box.addEventListener('toggle',()=>{if(box.open && !info) load(); else if(!box.open) discard();});
  player.addEventListener('ready',()=>{if(draft && key()===ctx) preview();});
  function draw() {
    const here=ctx, generation=++serial;
    const active=()=>here===ctx && key()===here && generation===serial && box.open;
    const body=h('div',{class:'text-body'}), status=h('p',{class:'small',role:'status'});
    box.replaceChildren(h('summary',{},`Captions · ${draft?.cues.length ?? 0}`),body);
    body.append(h('p',{class:'small'},'Scene seconds · visible at start, hidden at end. Captions have their own text; the script and transcript stay intact.'));
    if (info.stale) body.append(h('p',{class:'subtitle-warning',role:'status'},`Source changed: ${info.staleReasons.join(', ')}. Saved text and times stay fixed. Review or explicitly regenerate.`));
    const notes=draft?.provenance?.derivationNotes ?? [];
    if(notes.length) body.append(h('details',{class:'subtitle-inference'},h('summary',{},`Inferred timing · ${notes.length} generated cue${notes.length===1?'':'s'} · review`),h('p',{class:'small'},'Source words with zero duration stay intact. These notes describe the generated draft; your later timing edits override its display intervals.'),...notes.map(n=>h('p',{class:'small'},`Caption ${n.cue}: ${n.start}–${n.end} s · ${n.basis}${n.sourceWords.length ? ` · point-timed source words ${n.sourceWords.join(', ')}` : ''}.`))));
    if (!editable()) { body.append(h('p',{class:'small'},'View the latest version in This scene to edit captions.'),...(draft?.cues ?? []).map(c=>h('p',{},`${c.start}–${c.end} s · ${c.text}`))); return; }
    const form=h('form',{});
    const button=(label,fn)=>h('button',{type:'button',class:'btn small',onclick:()=>{if(active()) fn();}},label);
    const generate=button(draft ? 'Regenerate draft from words' : 'Generate draft from words',async()=>{
      generate.disabled=true;
      try {
        const result=await call('generate_scene_subtitles',{contextHash:info.contextHash});
        if(!active()) return;
        restorePreview(); draft=result.draft; generated=true; selected=0; draw();
      } catch(e) {if(active()) {status.textContent=e.message; generate.disabled=false;}}
    });
    generate.disabled=!info.canGenerate;
    form.append(generate);
    if(!info.canGenerate) form.append(h('p',{class:'small'},info.prerequisite));
    const save=h('button',{type:'submit',class:'btn dark small'},'Save captions');
    function check() {
      try {validateCues(draft?.cues ?? [],info.duration); save.disabled=false; status.textContent='Unsaved draft · Preview, then Save captions to keep changes.';}
      catch(e) {save.disabled=true;status.textContent=e.message;}
    }
    if(draft) {
      const style=h('select',{'aria-label':'Caption style'},...Object.values(SUBTITLE_STYLES).map(s=>h('option',{value:s.id},s.label)));
      // Do not replace a pinned style until the user explicitly chooses a new one.
      style.value=draft.style.id;
      style.onchange=()=>{if(active()) {draft.style=structuredClone(SUBTITLE_STYLES[style.value]);check();}};
      form.append(h('label',{},'Caption style',style));
      const list=h('div',{class:'text-list','aria-label':'Caption cues'},...draft.cues.map((c,i)=>button(`${i+1}. ${c.text.slice(0,24)}`,()=>{selected=i;draw();})));
      form.append(list);
      const cue=draft.cues[selected];
      if(cue) {
        const text=h('textarea',{id:'captionContent',rows:3,maxlength:84,'aria-label':'Caption text'},cue.text);
        text.oninput=()=>{if(active()){cue.text=text.value;list.children[selected].textContent=`${selected+1}. ${cue.text.slice(0,24)}`;check();}};
        const time=(label,field)=>{const input=h('input',{type:'number',min:0,max:info.duration,step:'any',value:cue[field],'aria-label':label});input.oninput=()=>{if(active()){cue[field]=input.value===''?NaN:Number(input.value);check();}};return h('label',{},label,input);};
        form.append(h('label',{},'Caption text · up to 84 characters / 2 lines',text),h('div',{class:'text-grid'},time('Caption start (s)','start'),time('Caption end (s)','end')),
          h('div',{class:'text-actions'},button('Preview cue',()=>{try {validateCues(draft.cues,info.duration);preview();player.pause();player.seek(cue.start);}catch(e){status.textContent=e.message;}}),button('Remove cue',()=>{draft.cues.splice(selected,1);selected=Math.max(0,selected-1);draw();})));
      }
    }
    form.append(h('div',{class:'text-actions'},button('Preview draft',()=>{try{validateCues(draft?.cues ?? [],info.duration);if(!draft){status.textContent='Generate a draft from timed words first.';return;}preview();}catch(e){status.textContent=e.message;}}),save,button('Remove all captions',()=>{draft=draft ? {...draft,cues:[]} : null;draw();}),button('Cancel',()=>{discard();box.open=false;})),status);
    form.onsubmit=async e=>{
      e.preventDefault();if(!active()) return;
      try {
        validateCues(draft?.cues ?? [],info.duration);
        for(const el of form.elements) el.disabled=true;
        await call('set_scene_subtitles',{contextHash:info.contextHash,cues:draft?.cues ?? [],style:draft?.style.id ?? 'dark',sourceHash:draft?.provenance?.sourceHash,regenerate:generated,model:'Caption controls'});
        if(active()) {restorePreview();ctx=null;info=null;draft=null;}
        await refresh();
      } catch(err){if(active()){for(const el of form.elements) el.disabled=false;status.textContent=err.message;}}
    };
    body.append(form,h('p',{class:'small'},'Bottom centre. May overlap existing lower thirds: review both together. Versions restores captions with scene content.'),button('Open scene history',()=>$('#versionsBtn').click()));
    check();
  }
  render();
}
