import { $, toast } from "./util.js";
import { S, api, scene, latest, viewed, sceneAt, tc } from "./state.js";
import { player, boxEl } from "./stage.js";
import { selectScene } from "./filmstrip.js";

// ---------- comments ----------
let draft = null;

export function startComment() {
  player.pause();
  const ov = $("#overlay");
  ov.replaceChildren();
  ov.dataset.sig = "";
  ov.classList.add("drawing");
  toast("Drag a box around what should change, or click a spot. Esc cancels.");
}

export function overlayPos(e) {
  const r = $("#overlay").getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}

$("#overlay").addEventListener("mousedown", (e) => {
  const ov = $("#overlay");
  if (!ov.classList.contains("drawing")) return;
  const p0 = overlayPos(e);
  const box = boxEl({ x: p0.x, y: p0.y, w: 0, h: 0 });
  ov.replaceChildren(box);
  const move = (ev) => {
    const p = overlayPos(ev);
    Object.assign(box.style, { left: `${Math.min(p.x, p0.x) * 100}%`, top: `${Math.min(p.y, p0.y) * 100}%`, width: `${Math.abs(p.x - p0.x) * 100}%`, height: `${Math.abs(p.y - p0.y) * 100}%` });
  };
  const up = (ev) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    const p = overlayPos(ev);
    let region = { x: Math.min(p.x, p0.x), y: Math.min(p.y, p0.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
    if (region.w < 0.015 && region.h < 0.015) region = { x: Math.max(0, p.x - 0.04), y: Math.max(0, p.y - 0.06), w: 0.08, h: 0.12 };
    Object.assign(box.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` });
    openPop(region, ev);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

export function openPop(region, ev) {
  const t = player.currentTime;
  let sc = scene(), st = t, v = viewed();
  if (S.mode === "whole") {
    sc = sceneAt(t);
    st = t - sc.start;
    v = S.picked[sc.id] ?? latest(sc);
  }
  draft = { sceneId: sc.id, t: Math.round(st * 100) / 100, version: v, region };
  const pop = $("#pop");
  pop.hidden = false;
  pop.style.left = `${Math.min(window.innerWidth - 360, ev.clientX + 12)}px`;
  pop.style.top = `${Math.min(window.innerHeight - 170, ev.clientY + 12)}px`;
  $("#popWhere").textContent = `${sc.id} · v${v} · ${tc(draft.t)}`;
  $("#popText").value = "";
  $("#popText").focus();
}

export function closePop() {
  draft = null;
  $("#pop").hidden = true;
  const ov = $("#overlay");
  ov.classList.remove("drawing");
  ov.replaceChildren();
  ov.dataset.sig = "";
}

export async function savePop() {
  const text = $("#popText").value.trim();
  if (!text || !draft) return;
  const d = draft;
  closePop();
  await api(`/api/scene/${d.sceneId}/comments`, { body: { version: d.version, t: d.t, region: d.region, text } });
  if (d.sceneId !== S.sel) selectScene(d.sceneId);
}

$("#popSave").onclick = savePop;
$("#popCancel").onclick = closePop;
$("#popText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), savePop());
  if (e.key === "Escape") closePop();
});
