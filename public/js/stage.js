import { $, h, toast } from "./util.js";
import { S, api, scene, latest, viewed, sceneAt, tc } from "./state.js";
import { renderVersions, renderCompare, flip } from "./versions.js";
import { setScript } from "./script.js";
import { startComment } from "./comments.js";

export const player = $("#player");

// ---------- player ----------
export async function loadPlayer(force = false) {
  const sc = scene();
  // Keyed on what the build depends on: the scene and version, or every picked version, plus
  // the project stamp (storyboard and theme), so a theme, duration or order change reloads.
  const key = (S.mode === "scene" ? `scene:${sc.id}:v${viewed(sc)}` : `whole:latest:${S.data.scenes.map((s) => latest(s)).join(",")}`) + `:${S.data.stamp}`;
  if (key === S.loadedKey && !force) return;
  const [mode, sub] = key.split(":");
  const sameView = S.loadedKey?.startsWith(`${mode}:${sub}:`);
  const keepTime = sameView ? player.currentTime : null;
  S.loadedKey = key;
  $("#shade").hidden = false;
  const b = mode === "scene" ? await api(`/api/build/scene/${sc.id}?v=${viewed(sc)}`) : await api("/api/build/whole");
  S.picked = b.picked ?? {};
  let failed = null;
  const onErr = (e) => (failed = e.detail);
  player.addEventListener("error", onErr);
  player.setAttribute("src", b.url);
  const want = mode === "scene" ? sc.duration : S.data.duration;
  const t0 = Date.now();
  while (!failed && !(player.ready && Math.abs(player.duration - want) < 0.05) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
  player.removeEventListener("error", onErr);
  $("#shade").hidden = true;
  if (S.loadedKey !== key) return;
  if (failed || !player.ready) toast(`Preview did not load: ${failed ?? "no answer from the page in 30 s"}`);
  else if (Math.abs(player.duration - want) >= 0.05) toast(`Preview is ${player.duration.toFixed(2)} s, storyboard says ${want.toFixed(2)} s`);
  if (keepTime) player.seek(Math.min(keepTime, want - 0.01));
  else if (mode === "whole" && S.pendingSeek != null) player.seek(S.pendingSeek);
  S.pendingSeek = null;
  renderVersions();
  renderTrack();
}

export function duration() {
  return S.mode === "scene" ? scene().duration : S.data.duration;
}

export function renderTrack() {
  const track = $("#track");
  track.querySelectorAll(".seg-mark,.pinmark").forEach((e) => e.remove());
  const D = duration();
  const step = D <= 12 ? 1 : D <= 60 ? 5 : D <= 300 ? 30 : 60;
  const ticks = [];
  for (let t = 0; t <= D; t += step) ticks.push(h("span", { style: `left:${(t / D) * 100}%` }, `${t}s`));
  $("#ticks").replaceChildren(...ticks);
  if (S.mode === "whole") {
    for (const s of S.data.scenes) track.append(h("div", { class: "seg-mark", style: `left:${(s.start / D) * 100}%` }, h("span", {}, s.id.slice(0, 3))));
    for (const s of S.data.scenes)
      for (const c of s.comments.filter((c) => c.status === "pending"))
        track.append(h("div", { class: "pinmark", title: c.text, style: `left:${((s.start + c.t) / D) * 100}%` }));
  } else {
    const sc = scene();
    for (const c of sc.comments.filter((c) => c.version === viewed(sc)))
      track.append(h("div", { class: `pinmark ${c.status === "sent" ? "sent" : ""}`, title: c.text, style: `left:${(c.t / D) * 100}%` }));
  }
}

export function tick() {
  if (S.data) {
    const t = player.currentTime || 0;
    const D = duration();
    $("#time").replaceChildren(tc(t), h("span", { class: "total" }, ` / ${tc(D)}`));
    $("#head").style.left = `${Math.min(100, (t / D) * 100)}%`;
    $("#playBtn").textContent = player.paused === false ? "❚❚" : "▶";
    if (S.mode === "whole") {
      const cur = sceneAt(t).id;
      document.querySelectorAll(".card").forEach((c) => c.classList.toggle("playing", c.dataset.id === cur));
    }
    drawPins(t);
  }
  requestAnimationFrame(tick);
}

export function drawPins(t) {
  const ov = $("#overlay");
  if (ov.classList.contains("drawing")) return;
  const want = [];
  if (S.mode === "scene") {
    const sc = scene();
    sc.comments.forEach((c, i) => c.version === viewed(sc) && Math.abs(c.t - t) < 0.3 && c.region && want.push([c, i + 1]));
  } else {
    const sc = sceneAt(t);
    sc.comments.forEach((c, i) => c.version === S.picked[sc.id] && Math.abs(sc.start + c.t - t) < 0.3 && c.region && want.push([c, i + 1]));
  }
  const sig = want.map(([c]) => c.id + c.status).join();
  if (ov.dataset.sig === sig) return;
  ov.dataset.sig = sig;
  ov.replaceChildren(...want.map(([c, n]) => boxEl(c.region, `#${n} ${c.text.slice(0, 40)}`, c.status === "sent")));
}

export function boxEl(r, label, old) {
  return h("div", { class: `box ${old ? "old" : ""}`, style: `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%` }, label ? h("span", {}, label) : null);
}

// ---------- modes and transport ----------
export function setMode(mode) {
  if (S.script) setScript(false);
  S.mode = mode;
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  if (mode === "whole") S.pendingSeek = scene().start + 0.02;
  S.loadedKey = null;
  S.compare = null;
  renderVersions();
  loadPlayer();
}

document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("#playBtn").onclick = () => (player.paused === false ? player.pause() : player.play());
$("#commentBtn").onclick = startComment;
$("#flipBtn").onclick = flip;
$("#closeCompare").onclick = () => ((S.compare = null), renderCompare());
$("#track").addEventListener("mousedown", (e) => {
  const seekAt = (ev) => {
    const r = $("#track").getBoundingClientRect();
    player.seek(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * duration() * 0.9999);
  };
  seekAt(e);
  const up = () => window.removeEventListener("mousemove", seekAt);
  window.addEventListener("mousemove", seekAt);
  window.addEventListener("mouseup", up, { once: true });
});
