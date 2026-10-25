import { $, h } from './util.js';
import { S, api } from './state.js';
import { player } from './stage.js';

const scope = id => JSON.stringify([S.project,S.video,id]);
const label = mode => mode === 'off' ? 'Cleanup off' : 'Gentle cleanup';
export function closeNoiseReview() { document.querySelector('.noise-dialog')?.close(); stopNoisePlayback(); }
export function stopNoisePlayback() { document.querySelectorAll('.noise-body audio').forEach(a=>a.pause()); }
// Native play events do not bubble, but capture covers both review players and take playback.
document.addEventListener('play',e=>{
  if (e.target.closest?.('.noise-body')) {
    player.pause();
    document.querySelectorAll('audio,video').forEach(a=>{if(a!==e.target && a.id!=='recPreview') a.pause();});
  } else if (e.target.id !== 'recPreview') stopNoisePlayback();
},true);

// Keep native audio keyboard controls from triggering scene/record shortcuts.
document.addEventListener('keydown',e=>{
  if (e.target.closest?.('.noise-body')) e.stopPropagation();
  else if (e.key === ' ' && !S.record) stopNoisePlayback();
},true);
document.addEventListener('click',e=>{if(e.target.closest?.('#playBtn')) stopNoisePlayback();},true);

function mount(container, id, stillHere) {
  let revision = 0, busy = false, data = null;
  const body = container.querySelector('.noise-body');
  const key = scope(id);
  const valid = () => container.isConnected && scope(id) === key && stillHere();
  const message = h('p',{class:'noise-status',role:'status','aria-live':'polite'});
  async function call(name,args) {
    // A saved click handler cannot operate another scene/video after navigation.
    if (!valid() || busy) return;
    busy = true; const version = ++revision;
    body.querySelectorAll('button,select').forEach(b=>b.disabled=true);
    message.textContent = name === 'preview_noise_cleanup' ? 'Preparing preview. Selected audio stays in use…' : name === 'inspect_noise_cleanup' ? 'Reading selected recording…' : 'Preparing the soundtrack…';
    try {
      const result = await api(`/api/tools/${name}`,{body:{args:{project:S.project,video:S.video,scene:id,...args},via:'page-js'}});
      if (!valid() || version !== revision) return;
      if (name === 'inspect_noise_cleanup' && JSON.stringify(result) === JSON.stringify(data)) { message.textContent = ''; return; }
      data = result; paint();
      message.textContent = name === 'keep_noise_cleanup' ? 'Kept. Preview and export now use this treatment.' : name === 'revert_noise_cleanup' ? 'Reverted to the prior audio. Soundtrack rebuilt.' : '';
    } catch(e) { if (valid() && version === revision) message.textContent = e.message; }
    finally {
      if (valid() && version === revision) {
        busy = false;
        body.querySelectorAll('button,select').forEach(b=>b.disabled=false);
      }
    }
  }
  const audio = (text,url) => h('label',{class:'noise-audio'},h('span',{},text),h('audio',{controls:true,preload:'metadata',src:url,'aria-label':text}));
  const button = (text,fn) => h('button',{type:'button',class:'btn',onclick:fn},text);
  function paint() {
    stopNoisePlayback();
    body.replaceChildren(message);
    if (!data?.supported) return body.append(h('p',{},data?.reason ?? 'Select a recorded take to review cleanup.'),button('Refresh recording',()=>call('inspect_noise_cleanup',{})));
    const d = data, p = d.preview;
    const mode = h('select',{'aria-label':'Cleanup treatment'},h('option',{value:'gentle'},'Gentle cleanup'),h('option',{value:'off'},'Cleanup off'));
    mode.value = p?.mode ?? (d.mode === 'gentle' ? 'off' : 'gentle');
    body.append(h('p',{class:'noise-context'},`${id} · Take ${d.take} · ${d.segments.length} edit range${d.segments.length===1?'':'s'}`),
      h('p',{},`In use: ${label(d.mode)}${d.defaultTreatment ? ' (existing default)' : ' (kept)'}.`),
      audio('Before · current selected audio',p?.beforeUrl ?? d.current.url),
      h('label',{class:'noise-mode'},'Compare treatment',mode),
      button('Prepare preview',()=>call('preview_noise_cleanup',{contextHash:d.contextHash,mode:mode.value})),
      button('Refresh recording',()=>call('inspect_noise_cleanup',{})));
    if (p) body.append(h('p',{class:'noise-pending'},`Pending preview: ${label(p.mode)}. Listen before you keep it.`),
      audio(`After · pending ${label(p.mode).toLowerCase()}`,p.url),
      h('p',{class:'small'},`${p.samples.toLocaleString()} samples at 48 kHz. Same cuts and timing.`),
      button(`Keep ${label(p.mode).toLowerCase()}`,()=>call('keep_noise_cleanup',{contextHash:d.contextHash,token:p.token})));
    if (d.previewStale) body.append(h('p',{},'The earlier preview expired because the recording, edit or mix changed. Prepare a new preview.'));
    if (d.canRevert) body.append(button(`Revert to prior ${label(d.revertMode).toLowerCase()}`,()=>call('revert_noise_cleanup',{contextHash:d.contextHash})));
    const originals = h('details',{},h('summary',{},'Original and same edit without cleanup'),
      h('p',{},'The original is the complete recording. Its playback time includes material outside the chosen edit.'),
      audio('Original recording · full take, unedited',d.original.url));
    if (p) originals.append(audio('Same edit · cleanup off',p.offUrl));
    body.append(originals,h('p',{class:'small'},d.limits),h('p',{class:'small'},'Older soundtrack builds use −16 LUFS on keep/revert when their loudness setting was not recorded. No timing or script changes.'));
  }
  paint();
  return {refresh:()=>call('inspect_noise_cleanup',{}),key};
}
let panel = null;
export function renderNoise() {
  const dialog = document.querySelector('.noise-dialog');
  if (dialog && dialog.dataset.scope !== scope(S.sel)) closeNoiseReview();
  const container = $('#noiseCleanup');
  if (!container || S.guest || !S.sel) return;
  const key = scope(S.sel);
  if (!panel || panel.key !== key) {
    stopNoisePlayback();
    panel = mount(container,S.sel,()=>S.sel && scope(S.sel)===key);
    container.ontoggle = () => {if(container.open) panel.refresh(); else stopNoisePlayback();};
  }
  if (container.open) panel.refresh();
}
export function openNoiseReview(id) {
  if (S.guest) return;
  const dialog = h('dialog',{class:'noise-dialog'},h('button',{type:'button',class:'btn',onclick:()=>dialog.close()},'Close'),h('h2',{},'Recording cleanup'),h('div',{class:'noise-body'}));
  dialog.addEventListener('close',()=>{stopNoisePlayback();dialog.remove();});
  dialog.dataset.scope = scope(id);
  document.body.append(dialog);
  const key = scope(id), review = mount(dialog,id,()=>S.record && scope(S.sel)===key && dialog.open);
  dialog.showModal(); review.refresh();
}
