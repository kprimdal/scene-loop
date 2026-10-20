import { $, h, toast, audioTime } from "./util.js";
import { S, api } from "./state.js";
import { player } from "./stage.js";
import { selectScene } from "./filmstrip.js";

// ---------- record view ----------
// The reviewer reads each scene's narration to camera. The text sits at the very top of the
// screen, next to the camera, so the eyes stay near the lens. Space counts 3-2-1 and records,
// Space again stops and uploads the take (POST /api/takes/<scene>); Enter uses the latest take
// (choose_take: narration audio and the camera clip) and moves on. Every take is kept.
const LS = (k, d) => { try { return JSON.parse(localStorage.getItem(`sl.rec.${k}`)) ?? d; } catch { return d; } };
const keep = (k, v) => localStorage.setItem(`sl.rec.${k}`, JSON.stringify(v));
const MIMES = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const R = {
  i: 0, state: "idle", // idle | countdown | recording | uploading
  stream: null, recorder: null, chunks: [], mime: null, startedAt: 0, raf: 0, audio: null, analyser: null, countdown: null,
  last: null, // { scene, n, url } the take just recorded
  takes: {}, // scene id -> list_takes entry
  font: LS("font", 46), scroll: LS("scroll", false), speed: LS("speed", 28),
};
const scenes = () => S.data.scenes;
const cur = () => scenes()[R.i];

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
    h("div", { class: "rec-count", id: "recCount", hidden: true }),
    h(
      "div",
      { class: "rec-bar" },
      h("div", { class: "rec-where" }, h("b", { id: "recTitle" }), h("span", { id: "recNum" })),
      h("div", { class: "rec-status", id: "recStatus" }),
      h("div", { class: "spacer" }),
      h("button", { class: "rec-btn", title: "Smaller text", onclick: () => font(-4) }, "A−"),
      h("button", { class: "rec-btn", title: "Larger text", onclick: () => font(4) }, "A+"),
      h("label", { class: "rec-scroll", title: "Scroll the text slowly while recording, for long blocks" }, h("input", { type: "checkbox", id: "recScroll", onchange: (e) => (keep("scroll", (R.scroll = e.target.checked)), e.target.blur()) }), " Scroll"),
      h("input", { type: "range", id: "recSpeed", min: 8, max: 120, step: 2, title: "Scroll speed", oninput: (e) => keep("speed", (R.speed = Number(e.target.value))), onchange: (e) => e.target.blur() }),
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
        h("div", { class: "rec-dev muted", id: "recDev" }),
      ),
    ),
    h("div", { class: "rec-keys" }, "Space record / stop · R record again · Enter use the take, next scene · ← → scene · P play the take · Esc close"),
  );
  $("#recScroll").checked = R.scroll;
  $("#recSpeed").value = R.speed;
  $("#recPreview").muted = true;
  $("#recPlayback").addEventListener("ended", () => showPlayback(false));
  showScene();
}

function font(d) {
  R.font = Math.max(24, Math.min(110, R.font + d));
  keep("font", R.font);
  $("#recText").style.fontSize = `${R.font}px`;
}

function showScene() {
  $("#recText").style.fontSize = `${R.font}px`;
  $("#recPrompt").scrollTop = 0;
  showPlayback(false);
  showInfo();
}

// The text (when the script changed), the counts, the takes and the status; the scroll
// position and a playing take stay as they are.
function showInfo() {
  const s = cur();
  const text = s.narration?.trim() || "(This scene has no narration.)";
  if ($("#recText").textContent !== text) $("#recText").textContent = text;
  $("#recText").classList.toggle("empty", !s.narration?.trim());
  $("#recTitle").textContent = s.title;
  const done = scenes().filter((x) => R.takes[x.id]?.chosen).length;
  $("#recNum").textContent = `${R.i + 1} / ${scenes().length} · ${done} recorded`;
  renderTakes();
  status();
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
    : t?.chosen ? `Take ${t.chosen} is used${t.stale ? " (the script changed since: record again)" : ""}. Space records another.`
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
        h("span", {}, `${audioTime(k.seconds)}${k.speech ? ` · speech ${k.speech.start.toFixed(2)}–${k.speech.end.toFixed(2)} s` : " · no speech found"}${k.stale ? " · script changed" : ""}`),
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
  R.audio.createMediaStreamSource(R.stream).connect(R.analyser);
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
    if (R.state === "recording") {
      const box = $("#recPrompt");
      if (R.scroll && box.scrollHeight > box.clientHeight) box.scrollTop += (R.speed * (now - last)) / 1000;
      status();
    }
    last = now;
    R.raf = requestAnimationFrame(frame);
  };
  R.raf = requestAnimationFrame(frame);
}

// ---------- takes ----------
function start() {
  if (R.state !== "idle") return;
  if (!R.stream) return toast("No camera or microphone yet.");
  if (!window.MediaRecorder) return toast("This browser cannot record.");
  showPlayback(false);
  $("#recPrompt").scrollTop = 0;
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
  R.startedAt = performance.now();
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
    const q = new URLSearchParams({ ...(S.project ? { project: S.project } : {}), ...(S.video ? { video: S.video } : {}) });
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
  if (R.state !== "idle") return;
  const i = Math.max(0, Math.min(scenes().length - 1, R.i + d));
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
  else if (k === "p") playLast();
  else if (e.key === "Escape") setRecord(false);
  else if (e.key === "+" || e.key === "=") font(4);
  else if (e.key === "-") font(-4);
});

$("#recordBtn").onclick = () => setRecord(true);
