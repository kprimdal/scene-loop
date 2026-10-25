import { $, h, toast } from './util.js';
import { S, api } from './state.js';
import { videoUrl } from './projects.js';

const tool = (name, args = {}) => api(`/api/tools/${name}`, { body: { args, via: 'page-js' } });
const Q = new URLSearchParams(location.search);
let styles = [], videos = [], selected = null, scenes = [], busy = false, loading = false, generation = 0;
let playing = true, initialized = false;
setInterval(() => {
  if (!playing || $("#styleLibrary").hidden) return;
  for (const p of document.querySelectorAll(".style-preview")) if (p.ready && p.currentTime >= p.duration) { p.seek(0); p.play(); }
}, 250);
const target = () => $('#styleTarget').value;
const chosenScenes = () => target() === '*' ? scenes : scenes.filter((s) => s.id === target());

export async function showStyles() {
  if (initialized) return busy ? undefined : loadTarget(target());
  initialized = true;
  styles = (await tool('list_styles')).items;
  videos = S.projects.flatMap((p) => p.videos.map((v) => ({ project: p.name, video: v.name, label: `${p.title} / ${v.title}` })));
  selected = videos.find((v) => v.project === S.project && v.video === S.video) ?? (videos.length === 1 ? videos[0] : null);
  $('#styleVideo').replaceChildren(h('option', { value: '', selected: !selected }, 'Choose a video'), ...videos.map((v, i) => h('option', { value: String(i), selected: v === selected }, v.label)));
  $('#styleVideo').onchange = async (e) => { selected = e.target.value === '' ? null : videos[Number(e.target.value)]; await loadTarget(); };
  $('#styleTarget').onchange = renderCurrent;
  const section = (music) => {
    $('#styleLibrary').hidden = music;
    $('#musicLibrary').hidden = !music;
    $('#libAdd').hidden = !music;
    for (const [id, on] of [['#libStylesTab', !music], ['#libMusicTab', music]]) { $(id).classList.toggle('on', on); $(id).setAttribute('aria-pressed', on); }
    for (const p of document.querySelectorAll('.style-preview')) music ? p.pause() : playing && p.play();
  };
  $('#libStylesTab').onclick = () => section(false);
  $('#libMusicTab').onclick = () => section(true);
  $('#styleList').replaceChildren(...styles.map((style) => {
    const preview = h('scene-player', { class: 'style-preview', src: style.previewUrl, 'aria-label': `${style.title} moving example` });
    preview.addEventListener('ready', () => { if (playing && !$('#styleLibrary').hidden) preview.play(); else if (!playing) preview.seek(2.6); });
    return h('article', { class: 'style-card', 'data-style': style.id },
      preview,
      h('div', { class: 'style-card-body' }, h('div', { class: 'style-card-heading' }, h('h2', {}, style.title), h('span', { class: 'muted small' }, `v${style.version}`)),
        h('p', {}, style.summary), h('button', { class: 'btn dark style-apply', onclick: () => change(style.id) }, `Apply ${style.title}`)));
  }));
  $('#styleList').before(h('button', { class: 'btn ghost small style-motion', onclick: (e) => {
    playing = !playing;
    for (const p of document.querySelectorAll('.style-preview')) playing ? p.play() : p.pause();
    e.target.textContent = playing ? 'Pause examples' : 'Play examples';
  } }, 'Pause examples'));
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { playing = false; $('.style-motion').textContent = 'Play examples'; }
  section(Q.get('section') === 'music');
  await loadTarget(Q.get('scene'));
}

async function loadTarget(preferred) {
  const gen = ++generation;
  const video = selected;
  scenes = [];
  loading = true;
  renderCurrent();
  try {
    const nextScenes = video ? (await tool('list_scenes', { project: video.project, video: video.video })).scenes : [];
    if (gen !== generation) return;
    scenes = nextScenes;
    $('#styleTarget').replaceChildren(...scenes.map((s) => h('option', { value: s.id, selected: s.id === preferred }, s.title)), ...(scenes.length ? [h('option', { value: '*', selected: preferred === '*' }, `Entire video (${scenes.length} scenes)`)] : [h('option', { value: '' }, 'No scenes')]));
    $('#styleOpenVideo').hidden = !video;
    if (video) $('#styleOpenVideo').href = videoUrl(video.project, video.video, preferred ? { scene: preferred } : {});
  } catch (e) { toast(e.message); }
  finally { if (gen === generation) { loading = false; renderCurrent(); } }
}

function renderCurrent() {
  const current = chosenScenes();
  if (selected) $('#styleOpenVideo').href = videoUrl(selected.project, selected.video, target() && target() !== '*' ? { scene: target() } : {});
  const enabled = !!selected && current.length > 0 && !busy && !loading;
  for (const b of document.querySelectorAll('.style-apply')) b.disabled = !enabled;
  $('#styleVideo').disabled = busy;
  $('#styleTarget').disabled = busy || loading || !selected;
  const pins = [...new Set(current.map((s) => s.style ? `${s.style.title} v${s.style.version}` : 'No library style'))];
  $('#styleCurrent').replaceChildren(...[
    h('span', {}, loading ? 'Loading scenes…' : !selected ? 'Choose a video to apply a style.' : !current.length ? 'Add a scene in the video first.' : `${target() === '*' ? 'Entire video' : current[0].title}: ${pins.join(' · ')}`),
    current.some((s) => s.style) ? h('button', { class: 'btn small', disabled: !enabled, onclick: () => change(null) }, 'Remove style') : null,
    current.some((s) => s.style) ? h('span', { class: 'muted small' }, 'Pinned copy. Restore previous versions in the video to undo.') : null].filter(Boolean));
}

async function change(id) {
  if (busy || loading || !selected || !chosenScenes().length) return;
  const selection = target();
  const args = { project: selected.project, video: selected.video, scope: selection === '*' ? 'video' : 'scene', ...(selection !== '*' ? { scene: selection } : {}), model: S.reviewer };
  busy = true;
  renderCurrent();
  try {
    const style = styles.find((s) => s.id === id);
    const r = await tool(id ? 'apply_style' : 'remove_style', { ...args, ...(id ? { style: id, version: style.version, contentHash: style.contentHash } : {}) });
    const updated = r.scenes.filter((s) => !s.unchanged).length;
    toast(`${id ? 'Style applied' : 'Style removed'} · ${updated} scene${updated === 1 ? '' : 's'} changed. Open the video to preview or restore a version.`);
    scenes = (await tool('list_scenes', { project: selected.project, video: selected.video })).scenes;
  } catch (e) { toast(e.message); }
  finally { busy = false; renderCurrent(); }
}
