import { h } from './util.js';
import { S, api, fps } from './state.js';
import { player } from './stage.js';

// ---------- split & cut ----------
// The used take of one scene on a timeline, opened from the Record view. S splits at the
// playhead, X (or Delete) cuts the part under it or brings it back, Space plays and skips the
// cut parts, so what you hear is the result. Cut sends every cut part as one remove edit
// (preview_recording_range with ranges), the result is listened to, then
// apply_recording_range: one edit, one undo. Times are seconds of the current edited
// recording; 0 is where the narration starts, and the camera clip runs narrationLead ahead.
// The playhead and splits sit on the video's frame grid (scene time k / fps, so recording time
// k / fps - lead): ← → step one frame, Shift a second, and a cut never splits a frame.
const MIN = 0.05; // the range tools keep no piece under 50 ms
const r3 = (n) => Math.round(n * 1000) / 1000;
let open = null;

export function closeCuts() { open?.close(); }

export function openCuts(id) {
  if (S.guest || open) return;
  document.querySelectorAll('audio,video').forEach((m) => { if (m.id !== 'recPreview') m.pause(); });
  player.pause();
  const target = { project: S.project, video: S.video, scene: id };
  const call = (name, args = {}) => api('/api/tools/' + name, { body: { args: { ...target, ...args }, via: 'page-js' } });

  let d = null, parts = [], peaks = null, busy = false, raf = 0, review = null;
  const audio = h('audio', { preload: 'auto' });
  const cam = h('video', { class: 'cut-cam', muted: true, playsinline: true, preload: 'auto' });
  cam.muted = true;
  const canvas = h('canvas', { class: 'cut-wave', 'aria-label': 'Recording timeline' });
  const time = h('span', { class: 'cut-time' });
  const message = h('p', { class: 'cut-status', role: 'status', 'aria-live': 'polite' });
  const skip = h('input', { type: 'checkbox', checked: true });
  const btn = (text, fn, title) => h('button', { type: 'button', class: 'rec-btn', title, onclick: (e) => { e.currentTarget.blur(); if (!busy) fn(); } }, text);
  const playBtn = btn('Play', () => toggle(), 'Play or pause (Space)');
  const cutBtn = btn('Cut', () => prepare(), 'Cut the red parts out of the recording');
  const undoBtn = btn('Undo last cut', () => run('undo_recording_range', { contextHash: d.contextHash }, 'The previous recording is back.'));
  const tools = h('div', { class: 'cut-tools' },
    playBtn,
    btn('Split', () => split(audio.currentTime), 'Split at the playhead (S)'),
    btn('Cut / keep part', () => flip(audio.currentTime), 'Cut the part under the playhead, or bring it back (X)'),
    btn('Clear', () => { drop(); parts = [{ from: 0, to: d.seconds, cut: false }]; draw(); }, 'Remove every split'),
    h('label', { class: 'cut-skip', title: 'Play the result: jump over the cut parts' }, skip, ' Skip cut parts'),
    time, h('span', { class: 'spacer' }), undoBtn, cutBtn);
  const body = h('div', { class: 'cut-body' });
  const dialog = h('dialog', { class: 'cut-dialog' },
    h('div', { class: 'cut-head' }, h('h2', {}, `Split & cut · ${S.data.scenes.find((s) => s.id === id)?.title ?? id}`), btn('Close', () => dialog.close(), 'Close (Esc)')),
    body,
    h('p', { class: 'cut-keys' }, 'Space play · S split at the playhead · X cut or keep the part · ← → one frame (Shift 1 s) · double-click a split to remove it · Esc close'));
  document.body.append(dialog);

  const say = (text) => (message.textContent = text ?? '');
  const partAt = (t) => { const i = parts.findIndex((p) => t < p.to); return i < 0 ? parts.length - 1 : i; };
  // Neighbouring cut parts are one range.
  const cuts = () => parts.reduce((out, p) => (p.cut ? (out.at(-1)?.to === p.from ? (out.at(-1).to = p.to) : out.push({ from: p.from, to: p.to })) : 0, out), []);
  const X = (t) => (t / d.seconds) * canvas.clientWidth;
  const lead = () => d.lead ?? 0;
  const frameOf = (t) => Math.round((t + lead()) * fps() + 1e-6);
  // The nearest frame inside the recording.
  const snap = (t) => { const k = frameOf(t); const a = k / fps() - lead(); return r3(a < 0 ? a + 1 / fps() : a > d.seconds ? a - 1 / fps() : a); };
  const step = (n) => seek(Math.max(0, Math.min(d.seconds, (frameOf(audio.currentTime) + n) / fps() - lead())));

  // Changing the parts drops a prepared result: it was made from the old ones.
  const drop = () => { if (review) review.remove(), (review = null), say(); };
  function split(t) {
    drop();
    t = snap(t);
    const i = partAt(t), p = parts[i];
    if (t - p.from < MIN || p.to - t < MIN) return say('Too close to the start, the end or another split. Move the playhead.');
    parts.splice(i, 1, { ...p, to: t }, { ...p, from: t });
    say(); draw();
  }
  function flip(t) {
    drop();
    const p = parts[partAt(t)];
    p.cut = !p.cut;
    if (parts.every((q) => q.cut)) { p.cut = false; return say('Keep at least one part.'); }
    say(); draw();
  }
  function join(i) {
    drop();
    const a = parts[i], b = parts[i + 1];
    parts.splice(i, 2, { from: a.from, to: b.to, cut: a.cut && b.cut });
    draw();
  }

  function seek(t) {
    audio.currentTime = snap(Math.max(0, Math.min(d.seconds, t)));
    sync(true); draw();
  }
  function sync(force) {
    if (!d?.camUrl) return;
    // Paused, show the middle of the playhead's frame: an exact frame time can land on the one before.
    const want = audio.paused ? (frameOf(audio.currentTime) + 0.5) / fps() : lead() + audio.currentTime;
    if (force || Math.abs(cam.currentTime - want) > 0.15) cam.currentTime = want;
    if (audio.paused && !cam.paused) cam.pause();
    else if (!audio.paused && cam.paused) cam.play().catch(() => {});
  }
  function toggle() {
    if (!audio.paused) return audio.pause();
    if (audio.currentTime >= d.seconds - 0.01) audio.currentTime = 0;
    audio.play().catch((e) => say(e.message));
  }
  function tick() {
    raf = 0;
    if (audio.paused) return;
    const i = partAt(audio.currentTime);
    if (skip.checked && parts[i]?.cut) {
      const next = parts.slice(i).find((p) => !p.cut);
      if (next) (audio.currentTime = next.from), sync(true);
      else audio.pause(), (audio.currentTime = d.seconds);
    }
    sync(); draw();
    raf = requestAnimationFrame(tick);
  }
  audio.addEventListener('play', () => { playBtn.textContent = 'Pause'; sync(true); if (!raf) raf = requestAnimationFrame(tick); });
  audio.addEventListener('pause', () => { playBtn.textContent = 'Play'; sync(); draw(); });

  function draw() {
    if (!d?.supported) return;
    const w = canvas.clientWidth, ht = canvas.clientHeight, dpr = devicePixelRatio || 1;
    if (!w) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(ht * dpr)) (canvas.width = Math.round(w * dpr)), (canvas.height = Math.round(ht * dpr));
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, ht);
    const lane = d.words?.length ? 20 : 0, wave = ht - lane, mid = wave / 2;
    for (const p of parts) {
      g.fillStyle = p.cut ? 'rgba(229,72,77,.22)' : '#15171b';
      g.fillRect(X(p.from), 0, X(p.to) - X(p.from), wave);
    }
    if (peaks) {
      for (let x = 0; x < w; x++) {
        const a = Math.floor((x / w) * peaks.length), b = Math.max(a + 1, Math.floor(((x + 1) / w) * peaks.length));
        let v = 0;
        for (let k = a; k < b; k++) v = Math.max(v, peaks[k]);
        g.fillStyle = parts[partAt((x / w) * d.seconds)]?.cut ? 'rgba(229,72,77,.6)' : '#8fb0ff';
        const y = Math.max(1, v * (mid - 4));
        g.fillRect(x, mid - y, 1, y * 2);
      }
    }
    if (lane) {
      g.font = '11px Inter, system-ui, sans-serif';
      g.textBaseline = 'middle';
      let free = 0;
      for (const word of d.words) {
        const x = X(word.start), text = word.word, width = g.measureText(text).width;
        g.fillStyle = 'rgba(255,255,255,.12)';
        g.fillRect(x, wave, 1, 4);
        if (x < free) continue;
        g.fillStyle = parts[partAt(word.start)]?.cut ? '#e5484d' : '#c9cbd0';
        g.fillText(text, x + 2, wave + lane / 2 + 2);
        free = x + width + 8;
      }
    }
    g.fillStyle = '#ffcf6b';
    for (const p of parts.slice(1)) g.fillRect(Math.round(X(p.from)) - 1, 0, 2, ht);
    g.fillStyle = '#fff';
    g.fillRect(Math.round(X(audio.currentTime)), 0, 1, ht);
    const left = parts.filter((p) => !p.cut).reduce((n, p) => n + p.to - p.from, 0), n = cuts().length;
    time.textContent = `${audio.currentTime.toFixed(3)} / ${d.seconds.toFixed(2)} s · frame ${frameOf(audio.currentTime)}${n ? ` · ${n} cut, ${left.toFixed(2)} s left` : ''}`;
    cutBtn.textContent = n ? `Cut ${n} part${n === 1 ? '' : 's'}` : 'Cut';
    cutBtn.disabled = busy || !n;
    undoBtn.hidden = !d.canUndo;
  }

  // The pointer seeks and scrubs; a double-click on a split removes it.
  let dragging = false;
  const at = (e) => ((e.clientX - canvas.getBoundingClientRect().left) / canvas.clientWidth) * d.seconds;
  canvas.addEventListener('pointerdown', (e) => { if (!d?.supported) return; dragging = true; canvas.setPointerCapture(e.pointerId); seek(at(e)); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) seek(at(e)); });
  canvas.addEventListener('pointerup', () => (dragging = false));
  canvas.addEventListener('dblclick', (e) => {
    if (!d?.supported) return;
    const x = e.clientX - canvas.getBoundingClientRect().left;
    const i = parts.findIndex((p, k) => k > 0 && Math.abs(X(p.from) - x) <= 6);
    if (i > 0) join(i - 1);
  });
  const resize = new ResizeObserver(() => draw());
  resize.observe(canvas);

  async function wave(url) {
    peaks = null;
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf);
      const ch = decoded.getChannelData(0), n = Math.min(4000, ch.length), size = ch.length / n, out = new Float32Array(n);
      let max = 1e-6;
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let k = Math.floor(i * size), end = Math.floor((i + 1) * size); k < end; k++) v = Math.max(v, Math.abs(ch[k]));
        out[i] = v; max = Math.max(max, v);
      }
      peaks = out.map((v) => v / max);
    } catch (e) { say(`Could not draw the waveform: ${e.message}`); }
    draw();
  }

  function load(result) {
    d = result; review = null;
    audio.pause();
    if (!d.supported) return body.replaceChildren(message, h('p', {}, d.reason ?? 'Use a recorded take first.'));
    parts = [{ from: 0, to: d.seconds, cut: false }];
    audio.src = d.currentUrl;
    if (d.camUrl) cam.src = d.camUrl;
    // A take chosen in the Record view keeps the scene's old duration until it is fitted, and the
    // camera clip is cut to the scene: past its end the picture stands still and Cut is refused.
    const short = d.duration + 1 / fps() < lead() + d.seconds;
    const fit = short && h('div', { class: 'cut-review' },
      h('p', { class: 'cut-warn' }, `The scene is ${d.duration.toFixed(2)} s but the recording runs ${(lead() + d.seconds).toFixed(2)} s with its lead. The camera clip and the video stop at ${d.duration.toFixed(2)} s.`),
      h('div', { class: 'cut-tools' }, h('span', { class: 'spacer' }), btn('Fit the scene to the recording', () => fitScene())));
    body.replaceChildren(...(d.camUrl ? [cam] : []), canvas, tools, ...(fit ? [fit] : []), message);
    body.classList.toggle('no-cam', !d.camUrl);
    audio.currentTime = 0;
    wave(d.currentUrl);
  }

  async function run(name, args, done) {
    busy = true; dialog.querySelectorAll('button').forEach((b) => (b.disabled = true));
    say(name === 'preview_recording_range' ? 'Preparing the cut…' : 'Saving the recording and rebuilding the soundtrack…');
    try {
      const r = await call(name, args);
      if (!dialog.open) return;
      if (name === 'preview_recording_range') return showReview(r);
      if (r.historyPending) { load(await call('inspect_recording_ranges')); return say(r.historyWarning); }
      load(r);
      say(done);
    } catch (e) { if (dialog.open) say(e.message); }
    finally { busy = false; dialog.querySelectorAll('button').forEach((b) => (b.disabled = false)); draw(); }
  }
  async function fitScene() {
    audio.pause();
    busy = true; dialog.querySelectorAll('button').forEach((b) => (b.disabled = true));
    say('Fitting the scene and cutting the camera clip again…');
    try {
      await call('fit_scenes_to_narration', { scenes: [id], lead: lead(), model: S.reviewer });
      if (!dialog.open) return;
      load(await call('inspect_recording_ranges'));
      say(`The scene is now ${d.duration.toFixed(2)} s.`);
    } catch (e) { if (dialog.open) say(e.message); }
    finally { busy = false; dialog.querySelectorAll('button').forEach((b) => (b.disabled = false)); draw(); }
  }
  function prepare() {
    const ranges = cuts();
    if (!ranges.length) return say('Split the recording and mark a part with X first.');
    audio.pause();
    run('preview_recording_range', { action: 'remove', ranges, contextHash: d.contextHash });
  }
  function showReview(r) {
    const impact = r.impact, p = r.pending;
    if (!impact) return say('The cut could not be prepared.');
    const words = (list) => list.map((w) => w.word).join(' ');
    review = h('div', { class: 'cut-review' },
      h('p', {}, `Recording ${impact.oldAudioSeconds.toFixed(2)} → ${impact.newAudioSeconds.toFixed(2)} s. Scene ${impact.oldDuration.toFixed(2)} → ${impact.newDuration.toFixed(2)} s.`),
      impact.removedWords.length ? h('p', {}, `Cut words: ${words(impact.removedWords)}`) : null,
      impact.affectedWords.length ? h('p', { class: 'cut-warn' }, `Cut through a word: ${words(impact.affectedWords)}. Listen to the join.`) : null,
      ...impact.errors.map((e) => h('p', { class: 'cut-warn' }, e)),
      p && impact.canApply ? h('audio', { controls: true, src: p.audioUrl, 'aria-label': 'The recording after the cut' }) : null,
      h('div', { class: 'cut-tools' },
        btn('Back to editing', () => { drop(); draw(); }),
        h('span', { class: 'spacer' }),
        p && impact.canApply ? btn('Apply the cut', () => run('apply_recording_range', { contextHash: r.contextHash, token: p.token }, 'Cut. Undo brings the previous recording back.')) : null),
      h('details', {}, h('summary', {}, 'Anchors, captions and timing'), h('pre', {}, JSON.stringify(impact, null, 2))));
    say(impact.canApply ? 'Listen to the result, then apply it.' : 'This cut cannot be applied yet.');
    body.append(review);
    review.scrollIntoView({ block: 'nearest' });
  }

  function onKey(e) {
    e.stopPropagation();
    if (!d?.supported || busy || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target !== skip) return;
    const k = e.key.toLowerCase();
    if (e.key === ' ') (e.preventDefault(), review ? review.querySelector('audio')?.[review.querySelector('audio').paused ? 'play' : 'pause']() : toggle());
    else if (k === 's') split(audio.currentTime);
    else if (k === 'x' || e.key === 'Delete' || e.key === 'Backspace') (e.preventDefault(), flip(audio.currentTime));
    else if (e.key === 'ArrowLeft') (e.preventDefault(), step(e.shiftKey ? -fps() : -1));
    else if (e.key === 'ArrowRight') (e.preventDefault(), step(e.shiftKey ? fps() : 1));
    else if (e.key === 'Home') seek(0);
  }
  dialog.addEventListener('keydown', onKey);
  dialog.addEventListener('close', () => {
    audio.pause(); cam.pause(); cancelAnimationFrame(raf); resize.disconnect();
    dialog.remove(); open = null;
  });
  open = { close: () => dialog.close() };
  dialog.showModal();
  body.replaceChildren(message);
  say('Reading the recording…');
  call('inspect_recording_ranges').then((r) => { if (dialog.open) (load(r), say()); }, (e) => say(e.message));
}
