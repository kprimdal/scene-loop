import { $, h } from './util.js';
import { S, api, scene, latest, viewed } from './state.js';
import { player } from './stage.js';
import { refresh } from './data.js';
import { TEXT_POSITIONS, TEXT_STYLES, MAX_TEXTS, validateTexts, textMarkup } from './text-core.js';

const box = $('#sceneText');
let previewState = null;
let context = null, draft = null, saved = [], selected = null, serial = 0;
const key = () => S.data && [S.project, S.video, S.sel, S.mode, viewed(), latest(scene()), S.data.stamp, !!S.compare].join(':');
const editable = () => S.mode === 'scene' && viewed() === latest(scene()) && !S.compare;

// Called on every scene/version/mode change, including changes received from another agent.
// The context token guards both late reads and clicks on detached, stale form elements.
export function renderText() {
  if (S.guest || !S.data) { box.hidden = true; return; }
  box.hidden = false;
  const next = key();
  if (next === context) return;
  restorePreview();
  context = next;
  draft = null;
  selected = null;
  const token = ++serial;
  const open = box.open;
  box.replaceChildren(h('summary', {}, 'Text on screen'), h('div', { class: 'text-body muted small' }, 'Loading…'));
  if (!open) { box.open = false; return; }
  load(token);
}
async function load(token = ++serial) {
  if (!S.data || !context || S.guest || S.overview) return;
  const ctx = context;
  const sc = scene();
  const version = viewed(sc);
  try {
    const result = await api('/api/tools/get_scene_html', { body: { args: { scene: sc.id, version }, via: 'page-js' } });
    if (ctx !== context || token !== serial || !box.open) return;
    saved = result.texts;
    draft = structuredClone(saved);
    selected = draft[0]?.id;
    drawForm();
  } catch (e) {
    if (ctx === context && token === serial) box.replaceChildren(h('summary', {}, 'Text on screen'), h('div', { class: 'text-body' }, e.message));
  }
}
box.addEventListener('toggle', () => {
  if (box.open && !draft) load();
  if (!box.open) { restorePreview(); draft = null; ++serial; }
});
function restorePreview() {
  if (!previewState) return;
  const { root, original } = previewState;
  root.querySelectorAll('[data-sl-text-item],[data-sl-text-css]').forEach((el) => el.remove());
  root.prepend(...original);
  previewState = null;
  if (player.ready) player.seek(player.currentTime);
}
function preview(items = draft) {
  if (!items || !player.ready || !editable() || key() !== context) return;
  const frame = [...player.querySelectorAll('iframe')].find((f) => f.style.visibility === 'visible');
  const doc = frame?.contentDocument;
  const root = doc?.querySelector(`#sc-${S.sel}`);
  if (!root) return;
  if (previewState?.root !== root) {
    restorePreview();
    previewState = { root, original: [...root.querySelectorAll('[data-sl-text-item],[data-sl-text-css]')].map((el) => el.cloneNode(true)) };
  }
  root.querySelectorAll('[data-sl-text-item],[data-sl-text-css]').forEach((el) => el.remove());
  const template = doc.createElement('template');
  template.innerHTML = textMarkup(S.sel, items);
  root.prepend(template.content);
  player.seek(player.currentTime);
}
$('#player').addEventListener('ready', () => draft && context === key() && preview());

function drawForm() {
  const ctx = context, generation = ++serial, sc = scene();
  const active = () => context === ctx && serial === generation && box.open && key() === ctx;
  const body = h('div', { class: 'text-body' });
  box.replaceChildren(h('summary', {}, `Text on screen · ${draft.length}`), body);
  if (!editable()) {
    body.append(h('p', { class: 'muted small' }, 'View the latest version in This scene to edit text.'), ...draft.map((item) => h('p', {}, item.text, h('span', { class: 'muted small' }, ` · ${item.start}–${item.end} s · ${TEXT_POSITIONS[item.position]} · ${TEXT_STYLES[item.style]}`))));
    return;
  }
  const status = h('p', { class: 'text-status small', role: 'status' }, 'Draft preview · Save text to keep changes.');
  const form = h('form', {});
  const list = h('div', { class: 'text-list', 'aria-label': 'Text items' }, ...draft.map((item, i) => h('button', { type: 'button', class: `btn small ${selected === item.id ? 'on' : ''}`, 'data-text-choice': item.id, onclick: () => { if (!active()) return; selected = item.id; drawForm(); } }, `${i + 1}. ${item.text.slice(0, 25)}`)));
  const item = draft.find((x) => x.id === selected);
  form.append(list);
  const check = () => {
    try { validateTexts(draft, sc.duration); status.textContent = 'Draft preview · Save text to keep changes.'; save.disabled = false; preview(); }
    catch (e) { status.textContent = e.message; save.disabled = true; }
  };
  if (item) {
    const text = h('textarea', { id: 'textContent', rows: 3, maxlength: 240, 'aria-label': 'On-screen text' }, item.text);
    text.oninput = () => { if (!active()) return; item.text = text.value; const button = list.querySelector(`[data-text-choice="${item.id}"]`); button.textContent = `${draft.indexOf(item) + 1}. ${item.text.slice(0, 25)}`; check(); };
    const choice = (label, field, options) => {
      const select = h('select', { 'aria-label': label }, ...Object.entries(options).map(([value, name]) => h('option', { value }, name)));
      select.value = item[field];
      select.onchange = () => { if (!active()) return; item[field] = select.value; check(); };
      return h('label', {}, label, select);
    };
    const time = (label, field) => {
      const input = h('input', { type: 'number', min: 0, max: sc.duration, step: 'any', value: item[field], 'aria-label': label });
      input.oninput = () => { if (!active()) return; item[field] = input.value === '' ? NaN : Number(input.value); check(); };
      return h('label', {}, label, input);
    };
    form.append(h('label', {}, 'Text · up to 240 characters / 4 lines', text), h('div', { class: 'text-grid' }, choice('Position', 'position', TEXT_POSITIONS), choice('Treatment', 'style', TEXT_STYLES), time('Start (s)', 'start'), time('End (s)', 'end')),
      h('div', { class: 'text-actions' }, h('button', { type: 'button', class: 'btn small', onclick: () => { if (!active()) return; player.pause(); player.seek(item.start); } }, 'Preview start'), h('button', { type: 'button', class: 'btn small', onclick: () => { if (!active()) return; draft = draft.filter((x) => x.id !== item.id); selected = draft[0]?.id; drawForm(); preview(); } }, 'Remove item')));
  } else form.append(h('p', { class: 'muted small' }, 'Add a title, heading or lower third to this scene.'));
  const save = h('button', { type: 'submit', class: 'btn dark small' }, 'Save text');
  form.append(h('div', { class: 'text-actions' }, h('button', { type: 'button', class: 'btn small', disabled: draft.length >= MAX_TEXTS, onclick: () => {
    if (!active()) return;
    selected = `text-${crypto.randomUUID().slice(0, 8)}`;
    draft.push({ id: selected, text: 'Your title', position: 'title', style: 'dark', start: 0, end: sc.duration });
    drawForm(); preview(); $('#textContent').focus(); $('#textContent').select();
  } }, '+ Add text'), save, h('button', { type: 'button', class: 'btn small', onclick: () => { if (!active()) return; box.open = false; } }, 'Cancel')));
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!active()) return;
    try {
      const items = validateTexts(draft, sc.duration);
      for (const control of form.elements) control.disabled = true;
      const result = await api('/api/tools/set_scene_text', { body: { args: { project: S.project, video: S.video, scene: sc.id, baseVersion: latest(sc), items, model: 'Text controls' }, via: 'page-js' } });
      if (active()) { saved = result.texts; draft = null; context = null; }
      await refresh();
    } catch (err) { if (active()) { for (const control of form.elements) control.disabled = false; status.textContent = err.message; } }
  };
  body.append(form, status, h('p', { class: 'muted small' }, `Scene seconds · visible at start, hidden at end · ${sc.duration} s scene. Versions can restore saved text.`));
  check();
}
