// The Library's cards, formats and sources (lib/cards.mjs). One grid of cards in stage order,
// filtered by format, kind, status and words; a drawer with the whole card and what you can do
// with it in the chosen video: attach a technique or workflow, apply a style, motion or
// boundary to a scene, or make a new scene from a pattern. Every action goes through the same
// tools the chat uses.
import { $, h, toast } from "./util.js";
import { S, api } from "./state.js";
import { videoUrl } from "./projects.js";

const tool = (name, args = {}) => api(`/api/tools/${name}`, { body: { args, via: "page-js" } });
const Q = new URLSearchParams(location.search);
const KIND = { technique: "Technique", workflow: "Workflow", style: "Style", motion: "Motion", transition: "Transition", pattern: "Pattern" };
const STATUS = { have: "In scene-loop", partial: "In part", missing: "Not yet" };
const F = { format: Q.get("format") ?? "", kind: "", status: "", q: "" };
let lib = null, formats = [], sources = [], videos = [], target = null, scenes = [], attached = null, videoFormat = null, initialized = false, gen = 0;
let open = null; // the card in the drawer
let created = null; // the last scene a pattern made: { card, project, video, id }, shown until the next one

// ---------- previews: load when on screen, play while on screen ----------
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = e.target;
    if (e.isIntersecting) { if (!p.getAttribute("src")) p.setAttribute("src", p.dataset.src); else if (p.ready) p.play(); }
    else if (p.ready) p.pause();
  }
}, { rootMargin: "200px" });
setInterval(() => { for (const p of document.querySelectorAll(".card-preview")) if (p.ready && p.currentTime >= p.duration - 0.02) { p.seek(0); p.play(); } }, 250);
function preview(url, label, cls = "card-preview") {
  const p = h("scene-player", { class: cls, "data-src": url, "aria-label": label });
  p.addEventListener("ready", () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? p.seek(Math.min(2, p.duration / 2)) : p.play()));
  seen.observe(p);
  return p;
}

const copy = async (text, button) => {
  try { await navigator.clipboard.writeText(text); if (button) { button.textContent = "Copied"; setTimeout(() => (button.textContent = "Copy"), 1200); } }
  catch { toast("Copy did not work here. Select the text instead."); }
};
const promptBox = (c) => c.prompt && h("div", { class: "card-prompt" },
  h("div", { class: "card-prompt-head" }, h("span", {}, c.prompt.asShown ? "Tell the chat · as shown" : "Tell the chat"), h("button", { class: "btn small", type: "button", onclick: (e) => copy(c.prompt.text ?? c.prompt, e.target) }, "Copy")),
  h("code", {}, c.prompt.text ?? c.prompt));
const statusChip = (c) => c.kind === "technique" ? h("span", { class: `card-status s-${c.status}` }, STATUS[c.status]) : h("span", { class: "card-status s-have" }, KIND[c.kind]);

// ---------- loading ----------
export async function showCards() {
  if (initialized) return refreshTarget();
  initialized = true;
  try {
    const [l, f, s] = await Promise.all([tool("list_cards"), tool("list_formats"), tool("list_sources")]);
    lib = l; formats = f.items; sources = s.items;
    $("#libTitle").textContent = lib.library.title === "Library" ? "Library" : `Library · ${lib.library.title}`;
    videos = S.projects.flatMap((p) => p.videos.map((v) => ({ project: p.name, video: v.name, label: `${p.title} / ${v.title}${v.title !== v.name ? ` (${v.name})` : ""}` })));
    target = videos.find((v) => v.project === (S.project || Q.get("project")) && v.video === (S.video || Q.get("video"))) ?? (videos.length === 1 ? videos[0] : null);
    $("#cardVideo").replaceChildren(h("option", { value: "", selected: !target }, "Choose a video"), ...videos.map((v, i) => h("option", { value: String(i), selected: v === target }, v.label)));
    $("#cardVideo").onchange = (e) => { target = e.target.value === "" ? null : videos[Number(e.target.value)]; loadTarget(); };
    $("#cardScene").onchange = () => { if (open) renderAction(open); renderTarget(); };
    renderFilters();
    renderGrid();
    renderFormats();
    renderSources();
    if (lib.errors?.length) $("#cardErrors").replaceChildren(h("summary", {}, `${lib.errors.length} library file${lib.errors.length === 1 ? "" : "s"} did not load`), ...lib.errors.map((e) => h("p", { class: "small" }, h("b", {}, e.file.split("/").slice(-2).join("/")), " ", e.problems.join("; "))));
    $("#cardErrors").hidden = !lib.errors?.length;
    await loadTarget(Q.get("scene") || S.sel);
    if (Q.get("card")) openCard(Q.get("card"));
  } catch (e) { initialized = false; toast(e.message); }
}

async function loadTarget(preferred) {
  const g = ++gen;
  scenes = []; attached = null; videoFormat = null;
  renderTarget();
  if (!target) return;
  try {
    const [list, cards, files] = await Promise.all([tool("list_scenes", target), tool("get_video_cards", target), tool("get_video_files", target)]);
    if (g !== gen) return;
    scenes = list.scenes; attached = cards;
    try { videoFormat = JSON.parse(files.storyboard ?? "{}").format ?? null; } catch { videoFormat = null; }
    $("#cardScene").replaceChildren(...(scenes.length ? scenes.map((s) => h("option", { value: s.id, selected: s.id === preferred }, s.title || s.id)) : [h("option", { value: "" }, "No scenes")]));
  } catch (e) { if (g === gen) toast(e.message); }
  if (g === gen) { renderTarget(); renderGrid(); renderFormats(); if (open) renderAction(open); }
}
async function refreshTarget() { if (target) await loadTarget($("#cardScene").value); }

function renderTarget() {
  $("#cardOpenVideo").hidden = !target;
  if (target) $("#cardOpenVideo").href = videoUrl(target.project, target.video, $("#cardScene").value ? { scene: $("#cardScene").value } : {});
  $("#cardScene").disabled = !target || !scenes.length;
  $("#cardTargetInfo").replaceChildren(...(!target ? [h("span", { class: "muted" }, "Choose a video to attach cards, apply styles and motion, or make scenes.")] : [
    h("span", {}, videoFormat ? `Format: ${videoFormat.title}` : "No format set"),
    h("span", { class: "muted" }, " · "),
    h("span", {}, attached ? `${attached.items.length} card${attached.items.length === 1 ? "" : "s"} attached` : "…"),
    attached?.items.length ? h("span", { class: "muted small" }, ` (${attached.items.map((c) => c.title).join(", ")})`) : null,
  ].filter(Boolean)));
}

// ---------- filters and grid ----------
function chips(id, options, key) {
  $(id).replaceChildren(...options.map(([value, label]) => h("button", { class: `chip ${F[key] === value ? "on" : ""}`, type: "button", onclick: () => { F[key] = F[key] === value && value !== "" ? "" : value; renderFilters(); renderGrid(); } }, label)));
}
function renderFilters() {
  $("#cardFormat").replaceChildren(h("option", { value: "" }, "Every format"), ...formats.map((f) => h("option", { value: f.id, selected: F.format === f.id }, f.title)));
  $("#cardFormat").onchange = (e) => { F.format = e.target.value; renderGrid(); };
  const kinds = [...new Set(lib.items.map((c) => c.kind))];
  chips("#cardKinds", [["", "All kinds"], ...kinds.map((k) => [k, `${KIND[k]}s`])], "kind");
  chips("#cardStatus", [["", "Any status"], ...Object.entries(STATUS)], "status");
  $("#cardSearch").value = F.q;
  $("#cardSearch").oninput = (e) => { F.q = e.target.value; renderGrid(); };
}
const matches = (c) => (!F.kind || c.kind === F.kind) && (!F.status || (c.kind === "technique" ? c.status === F.status : F.status === "have")) && (!F.format || !c.formats.length || c.formats.includes(F.format)) && F.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => [c.title, c.summary, c.prompt].join(" ").toLowerCase().includes(w));

function cardEl(c) {
  const isAttached = attached?.items.some((x) => x.id === c.id);
  return h("article", { class: `lcard k-${c.kind}${isAttached ? " attached" : ""}`, "data-card": c.id },
    c.previewUrl ? preview(c.previewUrl, `${c.title} moving example`) : null,
    h("div", { class: "lcard-body" },
      h("div", { class: "lcard-head" }, h("h3", {}, c.title), statusChip(c)),
      h("p", {}, c.summary),
      promptBox({ prompt: c.prompt ? { text: c.prompt, asShown: c.promptAsShown } : null }),
      h("div", { class: "lcard-foot" },
        c.sources.length ? h("span", { class: "muted small" }, sources.filter((s) => c.sources.includes(s.id)).map((s) => s.title).join("; ")) : null,
        h("span", { class: "spacer" }),
        isAttached ? h("span", { class: "card-in" }, "In this video") : null,
        h("button", { class: "btn small dark", type: "button", onclick: () => openCard(c.id) }, "Open"))));
}
function renderGrid() {
  const shown = lib.items.filter(matches);
  $("#cardCount").textContent = `${shown.length} of ${lib.items.length} cards`;
  $("#cardGrid").replaceChildren(...lib.library.stages.map((st) => {
    const list = shown.filter((c) => c.stage === st.id);
    return list.length ? h("section", { class: "card-stage", id: `stage-${st.id}` }, h("h2", {}, st.title), st.intro ? h("p", { class: "muted" }, st.intro) : null, h("div", { class: "card-grid" }, ...list.map(cardEl))) : null;
  }).filter(Boolean));
  if (!shown.length) $("#cardGrid").replaceChildren(h("p", { class: "ov-empty" }, "No cards match. Clear a filter."));
}

// ---------- the drawer ----------
export async function openCard(id) {
  let c;
  try { c = await tool("get_card", { card: id }); } catch (e) { return toast(e.message); }
  open = c;
  const d = $("#cardDrawer");
  d.replaceChildren(
    h("div", { class: "drawer-head" }, h("div", { style: "min-width:0;flex:1" }, h("div", { class: "muted small" }, `${KIND[c.kind]} · ${lib.library.stages.find((s) => s.id === c.stage)?.title ?? c.stage} · v${c.version}`), h("h2", {}, c.title)), statusChip(c), h("button", { class: "x", type: "button", "aria-label": "Close", onclick: closeCard }, "×")),
    h("div", { class: "card-detail" },
      c.previewUrl ? preview(c.previewUrl, `${c.title} moving example`, "card-preview card-preview-big") : null,
      h("p", { class: "card-what" }, c.what ?? c.summary),
      c.when ? [h("h4", {}, "When to use it"), h("p", {}, c.when)] : null,
      promptBox(c),
      c.guidance ? [h("h4", {}, "Guidance for the chat"), h("p", { class: "muted" }, c.guidance)] : null,
      c.kind === "workflow" && c.implementation ? workflowBody(c.implementation) : null,
      c.kind === "technique" ? [h("h4", {}, "In scene-loop"), h("p", {}, STATUS[c.status], c.gap ? `. ${c.gap}` : ".", ...(c.implementedBy ?? []).map((i) => i.card ? h("button", { class: "chip", type: "button", onclick: () => openCard(i.card) }, `${i.card} →`) : h("code", { class: "card-tool" }, i.tool)))] : null,
      c.formats.length ? [h("h4", {}, "Formats"), h("p", {}, c.formats.map((f) => formats.find((x) => x.id === f)?.title ?? f).join(", "))] : null,
      c.sources.length ? [h("h4", {}, "Sources"), h("ul", { class: "card-sources" }, c.sources.map((s) => h("li", {}, s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.title ?? s.source) : s.title ?? s.source, s.author ? ` · ${s.author}` : "", s.at ? ` · ${s.at}` : "", s.note ? h("span", { class: "muted" }, ` · ${s.note}`) : null)))] : null,
      c.related.length ? [h("h4", {}, "Related"), h("div", { class: "chips-inline" }, c.related.map((r) => h("button", { class: "chip", type: "button", onclick: () => openCard(r.id) }, r.title)))] : null,
      h("section", { id: "cardAction", class: "card-action" })));
  d.hidden = $("#drawerShade").hidden = false;
  renderAction(c);
  history.replaceState(null, "", `?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), card: c.id })}`);
}
function closeCard() {
  open = null;
  $("#cardDrawer").hidden = $("#drawerShade").hidden = true;
  const q = new URLSearchParams(location.search); q.delete("card");
  history.replaceState(null, "", `?${q}`);
}
$("#drawerShade").addEventListener("click", () => !$("#cardDrawer").hidden && closeCard());
$("#cardDrawer").addEventListener("keydown", (e) => e.key === "Escape" && closeCard());

const workflowBody = (w) => [h("h4", {}, "Workflow"), h("ol", {}, w.workflow.map((s) => h("li", {}, s))), h("h4", {}, `Example · ${w.example.title}`), h("p", {}, w.example.situation), h("p", { class: "muted" }, w.example.expected), h("h4", {}, "Checklist"), h("ul", {}, w.checklist.map((s) => h("li", {}, s)))];

function renderAction(c) {
  const box = $("#cardAction");
  if (!box) return;
  const scene = $("#cardScene").value;
  if (!target) return box.replaceChildren(h("p", { class: "muted" }, "Choose a video at the top of the Library to use this card."));
  const where = `${target.label}`;
  if (c.kind === "technique" || c.kind === "workflow") return box.replaceChildren(...attachControls(c, where));
  if (c.kind === "pattern") return box.replaceChildren(...patternForm(c, where));
  if (!scenes.length) return box.replaceChildren(h("p", { class: "muted" }, `${where} has no scenes yet.`));
  if (c.kind === "style") return box.replaceChildren(...styleControls(c, scene));
  return motionControls(c, box, scene);
}

const busyOn = (box, on) => box.querySelectorAll("button,input,select,textarea").forEach((e) => (e.disabled = on));
async function act(box, fn, done) {
  busyOn(box, true);
  try { const r = await fn(); await done?.(r); } catch (e) { toast(e.message); } finally { busyOn(box, false); }
}

function attachControls(c, where) {
  const isAttached = attached?.items.find((x) => x.id === c.id);
  const old = isAttached && isAttached.contentHash !== c.contentHash;
  const box = () => $("#cardAction");
  return [
    h("h4", {}, `In ${where}`),
    h("p", { class: "muted small" }, isAttached ? (old ? "An older version of this card is attached. Detach it and attach again to take this one." : "Attached: the chat gets this card with get_rules.") : "Attach it, and the chat gets it with the video's rules (get_rules)."),
    h("div", { class: "card-buttons" },
      isAttached
        ? h("button", { class: "btn", type: "button", onclick: () => act(box(), () => tool("detach_card", { ...target, card: c.id, contextHash: attached.contextHash, model: S.reviewer }), async () => { toast(`${c.title} detached.`); await refreshTarget(); }) }, "Detach")
        : h("button", { class: "btn dark", type: "button", onclick: () => act(box(), () => tool("attach_card", { ...target, card: c.id, version: c.version, contentHash: c.contentHash, contextHash: attached?.contextHash, model: S.reviewer }), async () => { toast(`${c.title} attached to ${where}.`); await refreshTarget(); }) }, "Attach to video"),
      h("button", { class: "btn", type: "button", onclick: () => act(box(), () => tool("use_card_once", { ...target, card: c.id, version: c.version, contentHash: c.contentHash }), (r) => { copy(r.prompt); toast("Prompt copied. Paste it in the chat beside the page."); }) }, "Copy prompt for once"),
      attached?.undoCount ? h("button", { class: "btn ghost", type: "button", onclick: () => act(box(), () => tool("undo_cards", { ...target, contextHash: attached.contextHash, model: S.reviewer }), async () => { toast("Last card change undone."); await refreshTarget(); }) }, "Undo last card change") : null),
  ];
}

function styleControls(c, scene) {
  const scope = h("select", { "aria-label": "Apply to" }, h("option", { value: "scene" }, `This scene (${scenes.find((s) => s.id === scene)?.title ?? scene})`), h("option", { value: "video" }, `Entire video (${scenes.length} scenes)`));
  const current = scenes.find((s) => s.id === scene)?.style;
  const run = (name, extra) => act($("#cardAction"), () => tool(name, { ...target, scope: scope.value, ...(scope.value === "scene" ? { scene } : {}), model: S.reviewer, ...extra }), async (r) => { const n = r.scenes.filter((s) => !s.unchanged).length; toast(`${name === "apply_style" ? "Style applied" : "Style removed"} · ${n} scene${n === 1 ? "" : "s"} changed.`); await refreshTarget(); });
  return [h("h4", {}, "Apply"), h("p", { class: "muted small" }, current ? `This scene has ${current.title} v${current.version}.` : "This scene has no Library style."), h("label", {}, "Apply to ", scope),
    h("div", { class: "card-buttons" }, h("button", { class: "btn dark", type: "button", onclick: () => run("apply_style", { style: c.id, version: c.implementation.version, contentHash: c.implementation.contentHash }) }, `Apply ${c.title}`), current ? h("button", { class: "btn", type: "button", onclick: () => run("remove_style", {}) }, "Remove style") : null)];
}

function patternForm(c, where) {
  const p = c.implementation;
  const fields = p.fields.map((f) => {
    const input = h(f.minItems ? "textarea" : "input", { name: f.key, ...(f.minItems ? { rows: f.maxItems + 1 } : { type: "text", maxlength: f.max }), required: !f.optional });
    input.value = f.minItems ? p.defaults[f.key].join("\n") : p.defaults[f.key];
    return h("label", {}, f.label, input, h("span", { class: "muted small" }, f.minItems ? `${f.minItems} to ${f.maxItems} lines, one per line` : f.key === "media" ? "An assets/ path in this video. Blank gives a labelled placeholder." : `Up to ${f.max} characters`));
  });
  const title = h("input", { name: "title", type: "text", maxlength: 100, required: true, value: p.defaults.heading });
  const duration = h("input", { name: "duration", type: "number", min: 3, max: 60, step: 0.1, required: true, value: 8 });
  const made = created && created.card === c.id && created.project === target.project && created.video === target.video ? created : null;
  const form = h("form", { class: "pattern-form" }, h("h4", {}, `New scene in ${where}`), ...fields, h("label", {}, "Scene name", title), h("label", {}, "Duration (seconds)", duration), h("button", { class: "btn dark", type: "submit" }, "Create new scene"),
    made ? h("a", { class: "btn dark", href: videoUrl(made.project, made.video, { scene: made.id }) }, `Open ${made.id} →`) : null);
  form.onsubmit = (e) => {
    e.preventDefault();
    const inputs = Object.fromEntries(p.fields.map((f) => [f.key, f.minItems ? form.elements[f.key].value.split("\n").map((s) => s.trim()).filter(Boolean) : form.elements[f.key].value]));
    act(form, () => tool("instantiate_pattern", { ...target, pattern: c.id, version: p.version, contentHash: p.contentHash, inputs, title: title.value, duration: Number(duration.value), model: S.reviewer }), async (r) => {
      toast(`Created ${r.id}.`);
      created = { card: c.id, project: target.project, video: target.video, id: r.id };
      await refreshTarget();
    });
  };
  return [form];
}

async function motionControls(c, box, scene) {
  const g = gen;
  box.replaceChildren(h("p", { class: "muted" }, "Looking at the scene…"));
  let info;
  try { info = await tool("get_scene_motion", { ...target, scene }); } catch (e) { return box.replaceChildren(h("p", {}, e.message)); }
  if (g !== gen || open?.id !== c.id) return;
  const p = c.implementation, pre = { baseVersion: info.version, contextHash: info.contextHash };
  const run = (name, extra) => act(box, () => tool(name, { ...target, scene, model: S.reviewer, ...pre, ...extra }), async (r) => { toast(r.timing?.warnings?.length ? r.timing.warnings.join(" ") : name.includes("transition") ? "Boundary saved. Play the whole video to see it." : "Saved as a new scene version."); motionControls(c, box, scene); });
  const parts = [h("h4", {}, `In ${scenes.find((s) => s.id === scene)?.title ?? scene}`)];
  if (c.kind === "transition") {
    if (info.transition.first) return box.replaceChildren(...parts, h("p", {}, "The first scene has no incoming boundary. Choose another scene."));
    const duration = h("input", { type: "number", min: 0.05, max: Math.min(5, info.duration), step: 0.05, value: p.duration || 0.6 });
    parts.push(h("p", { class: "muted small" }, `Now: ${info.transition.effective.type}${info.transition.effective.duration ? ` ${info.transition.effective.duration} s` : ""}`),
      p.id !== "cut" ? h("label", {}, "Duration (seconds) ", duration) : null,
      h("div", { class: "card-buttons" }, h("button", { class: "btn dark", type: "button", onclick: () => run("apply_transition", { transition: c.id, version: p.version, contentHash: p.contentHash, ...(p.id !== "cut" ? { duration: Number(duration.value) } : {}) }) }, `Use ${c.title} into this scene`),
        h("button", { class: "btn", type: "button", disabled: !info.transition.undoCount, onclick: () => run("undo_transition", {}) }, "Undo"), h("button", { class: "btn ghost", type: "button", onclick: () => run("reset_transition", {}) }, "Reset to default")));
    return box.replaceChildren(...parts);
  }
  const el = h("select", { "aria-label": "Element" }, ...info.targets.map((t) => h("option", { value: t.id, disabled: !!t.reason }, t.label + (t.reason ? " · unavailable" : ""))));
  const start = h("input", { type: "number", min: 0, max: info.duration, step: 0.05, value: Math.min(1, Math.max(0, info.duration - p.duration)) });
  const duration = h("input", { type: "number", min: 0.05, max: Math.min(5, info.duration), step: 0.05, value: p.duration });
  const words = info.words.length ? info.words : ((info.narration || "").match(/\S+/g) || []).map((word) => ({ word }));
  const counts = {};
  const cue = h("select", { "aria-label": "On the word" }, h("option", { value: "" }, "At the seconds below"), ...words.map((w) => {
    const key = w.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (!key) return null;
    counts[key] = (counts[key] || 0) + 1;
    return h("option", { value: `word:${key}${counts[key] > 1 ? "#" + counts[key] : ""}` }, `${w.word}${counts[key] > 1 ? ` (${counts[key]})` : ""}${w.start != null ? ` · ${(w.start + info.narrationLead).toFixed(2)} s` : ""}`);
  }).filter(Boolean));
  parts.push(h("label", {}, "Element ", el), h("label", {}, "On the word ", cue), h("label", {}, "Start, or fallback (seconds) ", start), h("label", {}, "Duration (seconds) ", duration),
    h("div", { class: "card-buttons" }, h("button", { class: "btn dark", type: "button", onclick: () => run("apply_motion", { motion: c.id, version: p.version, contentHash: p.contentHash, target: el.value, start: Number(start.value), duration: Number(duration.value), ...(cue.value ? { anchor: cue.value } : {}) }) }, `Apply ${c.title}`)));
  if (info.items.length) parts.push(h("h4", {}, "Motion in this scene"), ...info.items.map((m) => h("div", { class: "motion-saved" }, h("span", {}, `${m.effect.title} · ${info.targets.find((t) => t.id === m.target)?.label || m.target} · ${m.anchor || `${m.start} s`}`), h("button", { class: "btn small", type: "button", onclick: () => run("remove_motion", { id: m.id }) }, "Remove"))));
  box.replaceChildren(...parts);
}

// ---------- formats and sources ----------
function renderFormats() {
  $("#formatList").replaceChildren(...formats.map((f) => h("article", { class: "format-card", "data-format": f.id },
    h("div", { class: "lcard-head" }, h("h3", {}, f.title), videoFormat?.id === f.id ? h("span", { class: "card-in" }, "This video's format") : null),
    h("p", {}, f.summary),
    h("dl", { class: "format-facts" }, ...[["Canvas", `${f.width} x ${f.height}${f.aspect ? ` (${f.aspect})` : ""}`], ["Length", f.length], ["Hook", f.hook], ["Captions", f.captions]].filter(([, v]) => v).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    f.rules?.length ? [h("h4", {}, "Rules"), h("ul", {}, f.rules.map((r) => h("li", {}, r)))] : null,
    f.structure?.length ? [h("h4", {}, "Structure"), h("ol", {}, f.structure.map((r) => h("li", {}, r)))] : null,
    f.cards.length ? [h("h4", {}, "Cards that matter most"), h("div", { class: "chips-inline" }, f.cards.map((c) => h("button", { class: "chip", type: "button", onclick: () => openCard(c.id) }, c.title)))] : null,
    h("div", { class: "card-buttons" },
      h("button", { class: "btn", type: "button", onclick: () => { F.format = f.id; renderFilters(); renderGrid(); setSection("cards"); } }, "Show its cards"),
      target ? h("button", { class: "btn dark", type: "button", disabled: videoFormat?.id === f.id, onclick: (e) => act(e.target.parentNode, () => tool("set_video", { ...target, format: f.id, note: `format: ${f.title}`, model: S.reviewer }), async (r) => { toast(r.formatCanvas ?? `${target.label} is now ${f.title}.`); await refreshTarget(); }) }, `Use for ${target.label}`) : null))));
}
function renderSources() {
  $("#sourceList").replaceChildren(...sources.map((s) => h("article", { class: "source-row" },
    h("div", {}, s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.title) : h("b", {}, s.title), h("span", { class: "muted small" }, ` · ${s.author} · ${s.kind}${s.date ? ` · ${s.date}` : ""}`)),
    s.note ? h("p", { class: "muted small" }, s.note) : null,
    h("div", { class: "chips-inline" }, s.cards.map((c) => h("button", { class: "chip", type: "button", onclick: () => openCard(c.id) }, c.title))))));
}

let setSection = () => {};
export const onSection = (fn) => (setSection = fn);
