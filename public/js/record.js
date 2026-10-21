import { $, h, toast, audioTime, countWords } from "./util.js";
import { S, api } from "./state.js";
import { player } from "./stage.js";
import { selectScene } from "./filmstrip.js";
import { saveScriptNarration, recordAgainOf, keepTake } from "./script.js";
import { sentences, phrases } from "./phrases.js";

// ---------- record view ----------
// The reviewer reads each scene's narration to camera. The text sits at the very top of the
// screen, next to the camera, so the eyes stay near the lens. Space counts 3-2-1 and records,
// Space again stops and uploads the take (POST /api/takes/<scene>); Enter uses the latest take
// (choose_take: narration audio and the camera clip) and moves on. Every take is kept.
// Two layouts. Lens (the default): one sentence at a time in a narrow column right under the
// camera, the next one dim below it, so the eyes stay on the lens instead of travelling along
// full-width lines; it moves on when the reviewer pauses after speaking, or on ↓ / PageDown (a
// presenter clicker). Full text: the whole block, optionally scrolling.
// The script is fixed after recording: E edits the line in place, N goes to the next scene
// whose line changed since its take, K keeps the take after a spelling fix.
const LS = (k, d) => { try { return JSON.parse(localStorage.getItem(`sl.rec.${k}`)) ?? d; } catch { return d; } };
const keep = (k, v) => localStorage.setItem(`sl.rec.${k}`, JSON.stringify(v));
const MIMES = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const R = {
  i: 0, state: "idle", // idle | countdown | recording | uploading
  stream: null, recorder: null, chunks: [], mime: null, startedAt: 0, raf: 0, audio: null, analyser: null, countdown: null,
  last: null, // { scene, n, url } the take just recorded
  takes: {}, // scene id -> list_takes entry
  font: LS("font", 46), scroll: LS("scroll", false), speed: LS("speed", 28),
  layout: LS("layout", "lens"), lensFont: LS("lensFont2", 40), col: LS("col2", 520), pos: LS("pos", "center"),
  si: 0, sentenceAt: 0, heard: false, quietSince: null, // the sentence shown in the lens layout, and the pause after it
  live: { dbs: [], thr: null, at: 0 }, // the room, measured from the meter: the pause threshold
  editing: false,
};
const scenes = () => S.data.scenes;
const cur = () => scenes()[R.i];
// One list of scenes to record again, each with its reasons (list_takes, else the scene's own).
const reasons = (s) => R.takes[s.id]?.recordAgain ?? recordAgainOf(s);
const redo = (s) => reasons(s).length > 0;


export function setRecord(on = !S.record) {
  if (!S.data?.scenes.length) return;
  if (!on && (R.state === "recording" || R.state === "countdown")) return toast("Stop the take first (space).");
  if (S.record === on) return;
  document.activeElement?.blur(); // a focused Record button would take the next Space as a click
  S.record = on;
  document.body.classList.toggle("record-mode", on);
  $("#record").hidden = !on;
  if (on) {
    player.pause();
    R.i = Math.max(0, scenes().findIndex((s) => s.id === S.sel));
    build();
    startMedia();
    loadTakes();
  } else {
    stopMedia();
    selectScene(cur().id, true);
  }
}

function build() {
  const sel = (id, title) => h("select", { id, title, onchange: (e) => (keep(id, e.target.value), e.target.blur(), startMedia()) });
  $("#record").replaceChildren(
    h("div", { class: "rec-prompt", id: "recPrompt" }, h("div", { class: "rec-text", id: "recText" })),
    h("div", { class: "rec-redo-list", id: "recRedoList", hidden: true }),
    h("div", { class: "rec-count", id: "recCount", hidden: true }),
    h(
      "div",
      { class: "rec-bar" },
      h("div", { class: "rec-where" }, h("b", { id: "recTitle" }), h("span", { id: "recNum" })),
      h("div", { class: "rec-status", id: "recStatus" }),
      h("div", { class: "spacer" }),
      h("button", { class: "rec-btn rec-redo", id: "recRedo", hidden: true, title: "The scenes to record again, with the reasons (N goes to the next)", onclick: (e) => (e.target.blur(), toggleRedoList()) }),
      h("button", { class: "rec-btn", id: "recKeep", hidden: true, title: "Only the spelling changed: keep the take as it is (K)", onclick: (e) => (e.target.blur(), keepCurrent()) }, "Keep the take"),
      h("button", { class: "rec-btn", title: "Edit this scene's line (E)", onclick: (e) => (e.target.blur(), edit()) }, "Edit"),
      h("select", { id: "recLayout", title: "Text layout", onchange: (e) => (keep("layout", (R.layout = e.target.value)), e.target.blur(), layout()) }, h("option", { value: "lens" }, "Under the lens"), h("option", { value: "full" }, "Full text")),
      h("select", { id: "recPos", class: "lens-only", title: "Where the camera is", onchange: (e) => (keep("pos", (R.pos = e.target.value)), e.target.blur(), layout()) }, h("option", { value: "left" }, "Camera left"), h("option", { value: "center" }, "Camera centre"), h("option", { value: "right" }, "Camera right")),
      h("input", { type: "range", id: "recCol", class: "lens-only", min: 280, max: 1400, step: 20, title: "Column width", oninput: (e) => (keep("col2", (R.col = Number(e.target.value))), layout()), onchange: (e) => e.target.blur() }),
      h("button", { class: "rec-btn", title: "Smaller text", onclick: () => font(-4) }, "A−"),
      h("button", { class: "rec-btn", title: "Larger text", onclick: () => font(4) }, "A+"),
      h("label", { class: "rec-scroll full-only", title: "Scroll the text slowly while recording, for long blocks" }, h("input", { type: "checkbox", id: "recScroll", onchange: (e) => (keep("scroll", (R.scroll = e.target.checked)), e.target.blur()) }), " Scroll"),
      h("input", { type: "range", id: "recSpeed", class: "full-only", min: 8, max: 120, step: 2, title: "Scroll speed", oninput: (e) => keep("speed", (R.speed = Number(e.target.value))), onchange: (e) => e.target.blur() }),
      sel("cam", "Camera"),
      sel("mic", "Microphone"),
      h("button", { class: "rec-btn", title: "Close (Esc)", onclick: () => setRecord(false) }, "Close"),
    ),
    h(
      "div",
      { class: "rec-bottom" },
      h("div", { class: "rec-takes", id: "recTakes" }),
      h(
        "div",
        { class: "rec-media" },
        h("div", { class: "rec-screen" }, h("video", { id: "recPreview", class: "mirror", muted: true, playsinline: true, autoplay: true }), h("video", { id: "recPlayback", controls: true, playsinline: true, hidden: true })),
        h("div", { class: "rec-meter", title: "Microphone level" }, h("span", { id: "recLevel" })),
        h("div", { class: "rec-warn", id: "recWarn", hidden: true }),
        h("div", { class: "rec-dev muted", id: "recDev" }),
      ),
    ),
    h("div", { class: "rec-keys", id: "recKeys" }),
  );
  $("#recScroll").checked = R.scroll;
  $("#recSpeed").value = R.speed;
  $("#recLayout").value = R.layout;
  $("#recPos").value = R.pos;
  $("#recCol").value = R.col;
  $("#recPreview").muted = true;
  $("#recPlayback").addEventListener("ended", () => showPlayback(false));
  showScene();
}

function font(d) {
  const k = R.layout === "lens" ? "lensFont" : "font";
  R[k] = Math.max(20, Math.min(140, R[k] + d));
  keep(k === "lensFont" ? "lensFont2" : k, R[k]);
  layout();
}

// The layout settings onto the page: which controls show, the column, the type size.
function layout() {
  const lens = R.layout === "lens";
  $("#record").classList.toggle("lens", lens);
  $("#recPrompt").dataset.pos = R.pos;
  $("#recText").style.setProperty("--rec-col", `${R.col}px`);
  $("#recText").style.fontSize = `${lens ? R.lensFont : R.font}px`;
  $("#recKeys").textContent = `Space record / stop · R record again · Enter use the take, next scene · ← → scene${lens ? " · ↓ ↑ sentence (PageDown, a clicker)" : ""} · E edit the line · N next to record again · K keep the take · P play the take · Esc close`;
  showText();
}

function showScene() {
  R.si = 0;
  $("#recPrompt").scrollTop = 0;
  showPlayback(false);
  layout();
  showInfo();
}

// The scene's text: the whole block, or (lens) the current sentence and the next one dim.
// Left alone while the reviewer edits it.
function showText() {
  const el = $("#recText");
  if (!el || R.editing) return;
  const s = cur();
  const text = s.narration?.trim() || "(This scene has no narration.)";
  el.classList.toggle("empty", !s.narration?.trim());
  if (R.layout !== "lens") {
    if (el.dataset.key !== "full" || el.textContent !== text) (el.textContent = text), (el.dataset.key = "full");
    return;
  }
  const list = phrases(text);
  R.si = Math.max(0, Math.min(list.length - 1, R.si));
  const key = JSON.stringify([list, R.si]);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren(
    h("div", { class: "rec-now" }, list[R.si] ?? ""),
    h("div", { class: "rec-next" }, list[R.si + 1] ?? ""),
    h("div", { class: "rec-step" }, list.length > 1 ? `${R.si + 1} / ${list.length}` : ""),
  );
}

// The next (d = 1) or previous sentence in the lens layout; in the full text, a page of scroll.
function sentence(d) {
  if (R.editing) return;
  if (R.layout !== "lens") return void $("#recPrompt").scrollBy({ top: d * $("#recPrompt").clientHeight * 0.4, behavior: "smooth" });
  const n = phrases(cur().narration).length;
  const i = Math.max(0, Math.min(n - 1, R.si + d));
  if (i === R.si) return;
  R.si = i;
  R.sentenceAt = performance.now();
  R.heard = false;
  R.quietSince = null;
  showText();
}

// The counts, the takes and the status; the scroll position and a playing take stay as they are.
function showInfo() {
  const s = cur();
  showText();
  $("#recTitle").textContent = s.title;
  const done = scenes().filter((x) => R.takes[x.id]?.chosen).length;
  $("#recNum").textContent = `${R.i + 1} / ${scenes().length} · ${done} recorded`;
  const n = scenes().filter(redo).length;
  $("#recRedo").hidden = !n;
  $("#recRedo").textContent = `${n} to record again`;
  $("#recKeep").hidden = !redo(s);
  if (!$("#recRedoList").hidden) redoList();
  // A quiet take: the voice peaked under -24 dBFS (a mic far away, or its input low).
  const latest = R.takes[s.id]?.takes.at(-1);
  const quiet = latest?.level?.maxDb != null && latest.level.maxDb < -24;
  $("#recWarn").hidden = !quiet;
  if (quiet) $("#recWarn").textContent = `Take ${latest.n} peaked at ${latest.level.maxDb.toFixed(0)} dBFS: low input. Move the mic closer or raise the input level in macOS Sound settings.`;
  renderTakes();
  status();
}

// The scenes to record again, each with its reasons; a click goes there.
function redoList() {
  const list = scenes().map((s, i) => ({ s, i })).filter(({ s }) => redo(s));
  $("#recRedoList").replaceChildren(
    h("div", { class: "rec-redo-head" }, `${list.length} to record again`, h("span", {}, "N goes to the next")),
    ...list.map(({ s, i }) => h("button", { class: `rec-redo-row ${i === R.i ? "on" : ""}`, onclick: (e) => (e.target.closest("button").blur(), goTo(i), toggleRedoList(false)) }, h("b", {}, `${i + 1}. ${s.title}`), h("span", {}, reasons(s).join("; ")))),
  );
}
function toggleRedoList(on = $("#recRedoList").hidden) {
  $("#recRedoList").hidden = !on;
  if (on) redoList();
}

function status(text) {
  const el = $("#recStatus");
  if (!el) return;
  el.classList.toggle("live", R.state === "recording");
  if (text != null) return void (el.textContent = text);
  const t = R.takes[cur().id];
  const last = R.last?.scene === cur().id ? R.last : null;
  el.textContent =
    R.state === "recording" ? `● REC ${audioTime((performance.now() - R.startedAt) / 1000)}`
    : R.state === "uploading" ? "Saving the take…"
    : last && !last.chosen ? `Take ${last.n}: ${last.summary}. Enter uses it, R records again, P plays it.`
    : t?.chosen && redo(cur()) ? `Take ${t.chosen} is used. Record again: ${reasons(cur()).join("; ")}. Space records, K keeps the take.`
    : t?.chosen ? `Take ${t.chosen} is used. Space records another.`
    : "Space to record.";
}

function renderTakes() {
  const el = $("#recTakes");
  const t = R.takes[cur().id];
  if (!t?.takes.length) return el.replaceChildren(h("div", { class: "muted" }, "No takes for this scene yet."));
  el.replaceChildren(
    ...t.takes.slice().reverse().map((k) =>
      h(
        "div",
        { class: `rec-take ${k.chosen ? "on" : ""}` },
        h("b", {}, `Take ${k.n}`),
        h("span", { title: [k.devices?.mic && `Mic: ${k.devices.mic}`, k.devices?.camera && `Camera: ${k.devices.camera}`].filter(Boolean).join("\n") }, `${audioTime(k.seconds)}${k.segments ? ` · ${k.segments.length} ranges: ${k.segments.map((g) => `${g.from.toFixed(1)}–${g.to.toFixed(1)}`).join(", ")}` : k.speech ? ` · speech ${k.speech.start.toFixed(2)}–${k.speech.end.toFixed(2)} s` : " · no speech found"}${k.edits?.cut?.length ? ` · cut ${k.edits.cut.map((c) => c.text).join(", ")}` : ""}${k.level?.maxDb != null ? ` · peak ${k.level.maxDb.toFixed(0)} dBFS` : ""}${k.stale ? " · script changed" : ""}`),
        h("div", { class: "spacer" }),
        h("button", { class: "rec-btn", onclick: (e) => (e.target.blur(), play(k.url)) }, "Play"),
        k.chosen ? h("span", { class: "rec-used" }, "used") : h("button", { class: "rec-btn", onclick: (e) => (e.target.blur(), choose(cur().id, k.n)) }, "Use"),
      ),
    ),
  );
}

async function loadTakes() {
  try {
    const { scenes: list } = await api("/api/tools/list_takes", { body: { args: {}, via: "page-js" } });
    R.takes = Object.fromEntries(list.map((s) => [s.scene, s]));
  } catch (e) {
    toast(`Could not read the takes: ${e.message}`);
  }
  if (S.record) showInfo();
}

// A project event while the view is open: new takes, a changed script.
export function renderRecord() {
  if (!S.record) return;
  R.i = Math.min(R.i, scenes().length - 1);
  loadTakes();
}

// ---------- camera and microphone ----------
async function startMedia() {
  stopMedia(true);
  const cam = LS("cam", ""), mic = LS("mic", "");
  const want = (camId, micId) => ({
    video: { ...(camId ? { deviceId: { exact: camId } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    // We clean the audio ourselves (highpass, gentle denoise); the browser's processing pumps.
    audio: { ...(micId ? { deviceId: { exact: micId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } },
  });
  try {
    R.stream = await navigator.mediaDevices.getUserMedia(want(cam, mic)).catch((e) => (e.name === "OverconstrainedError" || e.name === "NotFoundError") && (cam || mic) ? navigator.mediaDevices.getUserMedia(want("", "")) : Promise.reject(e));
  } catch (e) {
    return status(`No camera or microphone: ${e.message}. Allow them for this page and reopen Record.`);
  }
  if (!S.record) return stopMedia();
  $("#recPreview").srcObject = R.stream;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const [vt] = R.stream.getVideoTracks(), [at] = R.stream.getAudioTracks();
  for (const [id, kind, track] of [["cam", "videoinput", vt], ["mic", "audioinput", at]]) {
    const using = track?.getSettings().deviceId;
    $(`#${id}`).replaceChildren(...devices.filter((d) => d.kind === kind).map((d, i) => h("option", { value: d.deviceId, selected: d.deviceId === using }, d.label || `${kind === "videoinput" ? "Camera" : "Microphone"} ${i + 1}`)));
  }
  R.mime = MIMES.find((m) => window.MediaRecorder?.isTypeSupported(m)) ?? "";
  const v = vt?.getSettings() ?? {};
  $("#recDev").textContent = `${v.width ?? "?"}×${v.height ?? "?"} · ${Math.round(v.frameRate ?? 0)} fps · ${R.mime.split(";")[0].split("/")[1] ?? "?"}`;
  meter();
}

function stopMedia(keepView) {
  cancelAnimationFrame(R.raf);
  R.stream?.getTracks().forEach((t) => t.stop());
  R.stream = null;
  R.audio?.close().catch(() => {});
  R.audio = R.analyser = null;
  if (!keepView && $("#recPreview")) $("#recPreview").srcObject = null;
}

// The level meter, and the auto-scroll and the clock while recording. Page UI, not a scene,
// so it runs on requestAnimationFrame.
function meter() {
  R.audio = new AudioContext();
  R.audio.resume().catch(() => {});
  R.analyser = R.audio.createAnalyser();
  R.analyser.fftSize = 2048;
  // The rumble cut as the server's analysis does (highpass 80 Hz), so the levels compare.
  const hp = new BiquadFilterNode(R.audio, { type: "highpass", frequency: 80 });
  R.audio.createMediaStreamSource(R.stream).connect(hp).connect(R.analyser);
  const buf = new Float32Array(R.analyser.fftSize);
  let last = performance.now(), peak = -90;
  const frame = (now) => {
    if (!R.analyser) return;
    R.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    const db = 10 * Math.log10(sum / buf.length + 1e-10);
    peak = Math.max(db, peak - ((now - last) / 1000) * 20);
    const el = $("#recLevel");
    if (el) {
      el.style.width = `${Math.max(0, Math.min(100, ((peak + 60) / 60) * 100))}%`;
      el.classList.toggle("hot", peak > -6);
    }
    room(db, now);
    if (R.state === "recording") {
      const box = $("#recPrompt");
      if (R.layout === "lens") follow(db, now);
      else if (R.scroll && box.scrollHeight > box.clientHeight) box.scrollTop += (R.speed * (now - last)) / 1000;
      status();
    }
    last = now;
    R.raf = requestAnimationFrame(frame);
  };
  R.raf = requestAnimationFrame(frame);
}

// The pause threshold, from the last 20 s of the meter the way the server finds speech in a
// take (lib/takes.mjs): a third of the way from the room's floor to the voice, 8 to 20 dB over
// the floor. Until there are a few seconds of it, the threshold of the latest take.
function room(db, now) {
  const L = R.live;
  if (db > -100) L.dbs.push(db);
  if (L.dbs.length > 1200) L.dbs.splice(0, L.dbs.length - 1200);
  if (now - L.at < 500 || L.dbs.length < 120) return;
  L.at = now;
  const sorted = [...L.dbs].sort((a, b) => a - b), pct = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const floor = pct(0.05), peak = pct(0.95);
  L.thr = floor + Math.max(8, Math.min(20, (peak - floor) * 0.35));
}
const pauseThreshold = () => R.live.thr ?? Object.values(R.takes).flatMap((t) => t.takes).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]?.level?.thresholdDb ?? -45;

// Lens layout while recording: the next sentence comes up when the reviewer pauses after
// speaking: under the threshold for 350 ms, once half the sentence's spoken length (2.4 words
// a second) has passed.
function follow(db, now) {
  if (db > pauseThreshold()) return void ((R.heard = true), (R.quietSince = null));
  if (!R.heard) return;
  R.quietSince ??= now;
  const said = (countWords(phrases(cur().narration)[R.si]) / 2.4) * 1000;
  if (now - R.quietSince >= 350 && now - R.sentenceAt >= said / 2) sentence(1);
}

// ---------- the script after recording ----------
// E: the line becomes a textarea in place; Enter or Esc saves it (Shift+Enter is a line
// break), through the Script view's save.
function edit() {
  if (R.state !== "idle" || R.editing || S.guest) return;
  const s = cur();
  R.editing = true;
  const ta = h("textarea", { class: "rec-edit", spellcheck: true, "aria-label": `Narration for ${s.id}` }, s.narration ?? "");
  ta.dataset.original = s.narration ?? "";
  const fit = () => ((ta.style.height = "auto"), (ta.style.height = `${ta.scrollHeight + 4}px`));
  ta.addEventListener("input", fit);
  ta.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") (e.preventDefault(), e.stopPropagation(), ta.blur());
  });
  ta.addEventListener("blur", async () => {
    await saveScriptNarration(s, ta);
    R.editing = false;
    $("#recText").dataset.key = "";
    showInfo();
  });
  $("#recText").dataset.key = "";
  $("#recText").replaceChildren(ta);
  ta.style.fontSize = `${Math.min(R.font, 46)}px`;
  fit();
  ta.focus();
  status("Editing the line: Enter or Esc saves, Shift+Enter is a line break.");
}

function nextRedo() {
  if (R.state !== "idle" || R.editing) return;
  const list = scenes();
  for (let k = 1; k <= list.length; k++) {
    const i = (R.i + k) % list.length;
    if (redo(list[i])) return goTo(i);
  }
  toast("No line changed since its take.");
}

async function keepCurrent() {
  const s = cur();
  if (R.state !== "idle" || R.editing || R.keeping || !redo(s)) return;
  R.keeping = true;
  try {
    await keepTake(s);
    await loadTakes();
  } finally {
    R.keeping = false;
  }
}

// ---------- takes ----------
function start() {
  if (R.state !== "idle") return;
  if (!R.stream) return toast("No camera or microphone yet.");
  if (!window.MediaRecorder) return toast("This browser cannot record.");
  if (R.editing) return;
  showPlayback(false);
  $("#recPrompt").scrollTop = 0;
  R.si = 0;
  showText();
  R.state = "countdown";
  const el = $("#recCount");
  let n = 3;
  const step = () => {
    if (R.state !== "countdown") return void (el.hidden = true);
    if (n === 0) return void ((el.hidden = true), record());
    el.hidden = false;
    el.textContent = n--;
    R.countdown = setTimeout(step, 800);
  };
  step();
  status("Get ready…");
}

function record() {
  const s = cur();
  R.chunks = [];
  R.recorder = new MediaRecorder(R.stream, { ...(R.mime ? { mimeType: R.mime } : {}), videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  R.recorder.ondataavailable = (e) => e.data.size && R.chunks.push(e.data);
  R.recorder.onstop = () => upload(s.id, new Blob(R.chunks, { type: (R.recorder.mimeType || R.mime || "video/webm").split(";")[0] }));
  R.recorder.start(1000);
  R.startedAt = R.sentenceAt = performance.now();
  R.heard = false;
  R.quietSince = null;
  R.state = "recording";
  document.body.classList.add("rec-live");
  status();
}

function stop() {
  if (R.state === "countdown") return void (clearTimeout(R.countdown), (R.state = "idle"), ($("#recCount").hidden = true), status());
  if (R.state !== "recording") return;
  R.state = "uploading";
  document.body.classList.remove("rec-live");
  R.recorder.stop();
  status();
}

async function upload(sceneId, blob) {
  const url = URL.createObjectURL(blob);
  try {
    // Which camera and microphone, by label, kept with the take.
    const [vt] = R.stream?.getVideoTracks() ?? [], [at] = R.stream?.getAudioTracks() ?? [];
    const q = new URLSearchParams({ ...(S.project ? { project: S.project } : {}), ...(S.video ? { video: S.video } : {}), ...(vt?.label ? { camera: vt.label } : {}), ...(at?.label ? { mic: at.label } : {}) });
    const r = await fetch(`/api/takes/${encodeURIComponent(sceneId)}?${q}`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    const k = j.take;
    R.last = { scene: sceneId, n: k.n, url, chosen: false, summary: `${audioTime(k.seconds)}${k.speech ? `, speech ${k.speech.start.toFixed(2)}–${k.speech.end.toFixed(2)} s` : ", no speech found"}` };
    R.state = "idle";
    await loadTakes();
  } catch (e) {
    R.state = "idle";
    status(`The take was not saved: ${e.message}`);
    toast(`The take was not saved: ${e.message}. It is still in this tab: P plays it.`);
    R.last = { scene: sceneId, n: null, url, chosen: true, summary: "not saved" };
  }
}

async function choose(sceneId, n) {
  toast(`Using take ${n} for ${sceneId}…`);
  try {
    const r = await api("/api/tools/choose_take", { body: { args: { scene: sceneId, take: n, model: S.reviewer }, via: "page-js" } });
    if (R.last?.scene === sceneId && R.last.n === n) R.last.chosen = true;
    toast(`${sceneId}: take ${n} is the narration (${audioTime(r.audio?.seconds ?? 0)})${r.cam ? " and the camera clip" : ""}.`);
  } catch (e) {
    toast(`Could not use take ${n} for ${sceneId}: ${e.message}`);
  }
  loadTakes();
}

// Enter: use the take just recorded (or the latest, when none is used yet) and go on.
function accept() {
  if (R.state !== "idle") return;
  const s = cur(), t = R.takes[s.id];
  const n = R.last?.scene === s.id && !R.last.chosen && R.last.n ? R.last.n : !t?.chosen && t?.takes.length ? t.takes.at(-1).n : null;
  if (n) choose(s.id, n);
  go(1);
}

function go(d) {
  goTo(Math.max(0, Math.min(scenes().length - 1, R.i + d)));
}

function goTo(i) {
  if (R.state !== "idle" || R.editing) return;
  if (i === R.i) return;
  R.i = i;
  S.sel = cur().id;
  showScene();
}

function showPlayback(on) {
  const pb = $("#recPlayback");
  if (!pb) return;
  if (!on) pb.pause();
  pb.hidden = !on;
  $("#recPreview").hidden = on;
}

function play(url) {
  const pb = $("#recPlayback");
  if (!pb.hidden && pb.dataset.src === url) return showPlayback(false);
  pb.src = pb.dataset.src = url;
  showPlayback(true);
  pb.play().catch(() => {});
}

function playLast() {
  const s = cur(), t = R.takes[s.id];
  const url = R.last?.scene === s.id ? R.last.url : (t?.takes.find((k) => k.chosen) ?? t?.takes.at(-1))?.url;
  if (url) play(url);
}

window.addEventListener("keydown", (e) => {
  if (!S.record || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && e.key !== "Escape") return;
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (e.key === " ") (e.preventDefault(), R.state === "idle" ? start() : stop());
  else if (k === "r") start();
  else if (e.key === "Enter") (e.preventDefault(), accept());
  else if (e.key === "ArrowLeft") go(-1);
  else if (e.key === "ArrowRight") go(1);
  else if (e.key === "ArrowDown" || e.key === "PageDown") (e.preventDefault(), sentence(1));
  else if (e.key === "ArrowUp" || e.key === "PageUp") (e.preventDefault(), sentence(-1));
  else if (k === "e") (e.preventDefault(), edit());
  else if (k === "n") nextRedo();
  else if (k === "k") keepCurrent();
  else if (k === "p") playLast();
  else if (e.key === "Escape") !$("#recRedoList").hidden ? toggleRedoList(false) : setRecord(false);
  else if (e.key === "+" || e.key === "=") font(4);
  else if (e.key === "-") font(-4);
});

$("#recordBtn").onclick = () => setRecord(true);
