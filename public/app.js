// Scene loop UI. Vanilla JS, no build step. State lives on the server; this file
// renders it and turns clicks into API calls.
const $ = (s) => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};
const api = async (path, opts = {}) => {
  const r = await fetch(path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers: { "Content-Type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
};
const fmt = (t) => (Number.isFinite(t) ? t.toFixed(2) : "–");
const ago = (iso) => {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};
const AGENT = { claude: "Claude", codex: "Codex", manual: "Manual edit", restore: "Restore", import: "Import" };

const S = {
  data: null,
  mode: "scene",
  wholeMode: "latest",
  sel: null,
  view: {}, // sceneId -> pinned version; absent = follow latest
  compare: null, // { a, b }
  tab: "scene",
  picked: {}, // whole video: sceneId -> version used
  loadedKey: null,
  chat: [],
  reviewer: "You",
};

const player = $("#player");
player.disableClickToPlay = true;

const scene = (id = S.sel) => S.data.scenes.find((s) => s.id === id);
const latest = (sc) => sc.versions.at(-1).v;
const viewed = (sc = scene()) => S.view[sc.id] ?? latest(sc);
const sceneAt = (t) => S.data.scenes.findLast((s) => t >= s.start - 1e-6) ?? S.data.scenes[0];

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4200);
}

// ---------- data ----------
async function refresh() {
  S.data = await api("/api/project");
  S.sel ??= S.data.scenes[0].id;
  $("#title").textContent = S.data.title;
  $("#meta").textContent = `${S.data.scenes.length} scenes · ${S.data.duration.toFixed(1)} s`;
  renderFilmstrip();
  renderVersions();
  renderPanel();
  renderRenders();
  await loadPlayer();
}

// ---------- player ----------
async function loadPlayer(force = false) {
  const sc = scene();
  const key = S.mode === "scene" ? `scene:${sc.id}:v${viewed(sc)}` : `whole:${S.wholeMode}:${S.data.scenes.map((s) => (S.wholeMode === "approved" ? s.approved ?? latest(s) : latest(s))).join(",")}`;
  if (key === S.loadedKey && !force) return;
  const [mode, sub] = key.split(":");
  const sameView = S.loadedKey?.startsWith(`${mode}:${sub}:`);
  // The whole video re-prepares every shader transition on load (about a minute), so a
  // new scene version marks it stale instead of reloading under the viewer.
  if (mode === "whole" && sameView && !force) {
    S.wholeStale = true;
    renderVersions();
    return;
  }
  S.wholeStale = false;
  const keepTime = sameView ? player.currentTime : null;
  S.loadedKey = key;
  $("#shade").hidden = mode === "whole"; // the player shows its own progress while it prepares transitions
  const b = mode === "scene" ? await api(`/api/build/scene/${sc.id}?v=${viewed(sc)}`) : await api(`/api/build/whole?mode=${S.wholeMode}`);
  S.picked = b.picked ?? {};
  player.setAttribute("src", b.url);
  const want = mode === "scene" ? sc.duration : S.data.duration;
  const t0 = Date.now();
  while (!(player.ready && Math.abs(player.duration - want) < 0.05) && Date.now() - t0 < 180000) await new Promise((r) => setTimeout(r, 100));
  $("#shade").hidden = true;
  if (S.loadedKey !== key) return;
  if (keepTime) player.seek(Math.min(keepTime, want - 0.01));
  else if (mode === "whole" && S.pendingSeek != null) player.seek(S.pendingSeek);
  S.pendingSeek = null;
  renderVersions();
  renderTrack();
}

function duration() {
  return S.mode === "scene" ? scene().duration : S.data.duration;
}

function renderTrack() {
  const track = $("#track");
  track.querySelectorAll(".seg-mark,.pinmark").forEach((e) => e.remove());
  const D = duration();
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

function tick() {
  if (S.data) {
    const t = player.currentTime || 0;
    const D = duration();
    $("#time").textContent = `${fmt(t)} / ${fmt(D)}`;
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

function drawPins(t) {
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

function boxEl(r, label, old) {
  return h("div", { class: `box ${old ? "old" : ""}`, style: `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%` }, label ? h("span", {}, label) : null);
}

// ---------- filmstrip ----------
function renderFilmstrip() {
  const strip = $("#filmstrip");
  strip.replaceChildren(
    ...S.data.scenes.map((s, i) => {
      const lv = latest(s);
      const v = s.versions.at(-1);
      const poster = v.stills.at(-1) ?? s.versions.findLast((x) => x.stills.length)?.stills.at(-1);
      const pins = s.comments.filter((c) => c.status === "pending").length;
      return h(
        "button",
        { class: `card ${s.id === S.sel ? "on" : ""}`, "data-id": s.id, style: `flex-grow:${Math.max(s.duration, 2.4)}`, onclick: () => selectScene(s.id, true) },
        poster ? h("img", { src: poster.url, alt: "" }) : h("div", { class: "noimg" }),
        h(
          "div",
          { class: "badges" },
          h("span", { class: "badge" }, `v${lv}`),
          s.approved ? h("span", { class: "badge ok" }, s.approved === lv ? "✓" : `✓v${s.approved}`) : null,
          pins ? h("span", { class: "badge pins" }, pins) : null,
          s.running ? h("span", { class: "badge run" }, AGENT[s.running.agent]) : null,
        ),
        h("div", { class: "cap" }, h("b", {}, `${i + 1}. ${s.title}`), h("span", { class: "muted" }, `${s.duration.toFixed(1)}s`)),
      );
    }),
  );
}

function selectScene(id, fromStrip) {
  S.sel = id;
  S.compare = null;
  if (S.mode === "whole" && fromStrip) player.seek(scene(id).start + 0.02);
  renderFilmstrip();
  renderVersions();
  if (S.tab === "scene") loadChat();
  renderPanel();
  if (S.mode === "scene") loadPlayer();
}

// ---------- versions ----------
function renderVersions() {
  const sc = scene();
  $("#versionsTitle").textContent = `Versions · ${sc.id}`;
  $("#viewing").replaceChildren(
    S.mode === "scene" ? `viewing v${viewed(sc)}${S.view[sc.id] ? " (pinned)" : " (latest)"}` : `whole video uses v${S.picked[sc.id] ?? latest(sc)}`,
    S.mode === "whole" && S.wholeStale ? h("button", { class: "btn accent", style: "margin-left:10px", onclick: () => loadPlayer(true) }, "New versions · reload whole video") : "",
  );
  $("#narration").replaceChildren(h("b", {}, "Narration "), sc.narration ?? "");
  const box = $("#versions");
  box.replaceChildren(
    ...sc.versions.map((v) => {
      const comments = sc.comments.filter((c) => (v.comments ?? []).includes(c.id));
      const isView = S.mode === "scene" && v.v === viewed(sc);
      return h(
        "div",
        { class: `ver ${isView ? "on" : ""}` },
        h("div", {}, h("div", { class: "vnum" }, `v${v.v}`), h("div", { class: "vmeta" }, AGENT[v.agent] ?? v.agent), h("div", { class: "vmeta" }, ago(v.at ?? v.date)), v.ms ? h("div", { class: "vmeta" }, `${Math.round(v.ms / 1000)} s turn`) : null),
        h(
          "div",
          { class: "strip" },
          v.stills.length
            ? v.stills.map((st) => h("img", { src: st.url, title: `${st.t}s`, onclick: () => viewVersion(v.v, st.t) }))
            : Array.from({ length: 5 }, () => h("div", { class: "noimg" }, "stills…")),
        ),
        h(
          "div",
          { class: "acts" },
          isView ? null : h("button", { class: "btn", onclick: () => viewVersion(v.v) }, "View"),
          sc.versions.length > 1 ? h("button", { class: "btn ghost", onclick: () => openCompare(v.v) }, "Compare") : null,
          sc.approved === v.v ? h("div", { class: "ok" }, "Approved ✓") : h("button", { class: "btn ghost", onclick: () => approve(v.v) }, "Approve"),
          v.v !== latest(sc) ? h("button", { class: "btn ghost", title: "Bring this version back as a new version", onclick: () => restore(v.v) }, "Restore") : null,
        ),
        h("div", { class: "what" }, comments.length || v.note ? [...comments.map((c) => `“${c.text}”`), ...(v.note ? [`Note: ${v.note}`] : [])].join("  ") : v.v === 1 ? "First version." : v.from ? `Restored from v${v.from}.` : (v.subject ?? "").replace(/^[\w-]+ v\d+: /, "")),
      );
    }),
  );
  renderCompare();
}

function viewVersion(v, t) {
  const sc = scene();
  if (S.mode !== "scene") setMode("scene");
  if (v === latest(sc)) delete S.view[sc.id];
  else S.view[sc.id] = v;
  renderVersions();
  renderTrack();
  loadPlayer().then(() => t != null && player.seek(t));
}

function openCompare(b) {
  const sc = scene();
  const a = viewed(sc);
  S.compare = { a: a === b ? (sc.versions.find((x) => x.v !== b) ?? sc.versions[0]).v : a, b };
  renderCompare();
}

function renderCompare() {
  const el = $("#compare");
  const sc = scene();
  const on = S.compare && S.mode === "scene";
  el.hidden = $("#flipBtn").hidden = $("#closeCompare").hidden = !on;
  if (!on) return;
  const row = (v) => {
    const ver = sc.versions.find((x) => x.v === v);
    return h("div", { class: "row" }, h("b", {}, `v${v}`), ...(ver?.stills ?? []).map((st) => h("img", { src: st.url, onclick: () => viewVersion(v, st.t) })));
  };
  const times = sc.versions.find((x) => x.v === S.compare.a)?.stills.map((st) => `${st.t}s`) ?? [];
  el.replaceChildren(h("div", { class: "row" }, h("span"), ...times.map((t) => h("div", { class: "times" }, t))), row(S.compare.a), row(S.compare.b));
}

function flip() {
  if (!S.compare) return;
  const t = player.currentTime;
  const next = viewed() === S.compare.a ? S.compare.b : S.compare.a;
  viewVersion(next, t);
}

async function approve(v) {
  await api(`/api/scene/${S.sel}/approve`, { body: { v } });
}

async function restore(v) {
  if (!confirm(`Bring v${v} back as a new version of ${S.sel}?`)) return;
  delete S.view[S.sel];
  await api(`/api/scene/${S.sel}/restore`, { body: { v } });
}

// ---------- comments ----------
let draft = null;

function startComment() {
  player.pause();
  const ov = $("#overlay");
  ov.replaceChildren();
  ov.dataset.sig = "";
  ov.classList.add("drawing");
  toast("Drag a box around what should change, or click a spot. Esc cancels.");
}

function overlayPos(e) {
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

function openPop(region, ev) {
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
  $("#popWhere").textContent = `${sc.id} · v${v} · ${fmt(draft.t)}s`;
  $("#popText").value = "";
  $("#popText").focus();
}

function closePop() {
  draft = null;
  $("#pop").hidden = true;
  const ov = $("#overlay");
  ov.classList.remove("drawing");
  ov.replaceChildren();
  ov.dataset.sig = "";
}

async function savePop() {
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

// ---------- side panel ----------
const panelKey = () => (S.tab === "project" ? "_project" : S.sel);

async function loadChat() {
  const key = panelKey();
  const entries = await api(`/api/chat/${key}`);
  if (key !== panelKey()) return;
  S.chat = entries;
  renderChat();
}

function renderChat() {
  const box = $("#chat");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const out = [];
  let tools = null;
  for (const e of S.chat) {
    if (e.role === "tool" || e.role === "status") {
      if (!tools) out.push((tools = h("details", { class: "tools" }, h("summary", {}))));
      tools.append(h("div", { title: e.text }, e.text));
      tools.firstChild.textContent = `${tools.childElementCount - 1} steps`;
      continue;
    }
    tools = null;
    if (e.role === "system") out.push(h("div", { class: "sys" }, e.text));
    else out.push(h("div", { class: `msg ${e.role}` }, h("span", { class: "who" }, e.role === "user" ? `${S.reviewer} → ${AGENT[e.agent]}` : AGENT[e.agent]), e.text));
  }
  box.replaceChildren(...(out.length ? out : [h("div", { class: "empty" }, S.tab === "project" ? "Project chat: changes that span scenes." : "No conversation for this scene yet. Pin comments on the frame, then Send.")]));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderPanel() {
  const sc = scene();
  const proj = S.tab === "project";
  const info = proj ? S.data.project : sc;
  $("#sceneTab").textContent = `Scene ${S.data.scenes.indexOf(sc) + 1}`;
  $("#panelTitle").textContent = proj ? "Project" : `${S.data.scenes.indexOf(sc) + 1}. ${sc.title}`;
  $("#panelSub").textContent = proj
    ? `All scenes · sessions: ${info.sessions.map((a) => AGENT[a]).join(", ") || "none yet"}`
    : `${sc.id} · ${sc.duration.toFixed(2)} s · sessions: ${info.sessions.map((a) => AGENT[a]).join(", ") || "none yet"}`;
  document.querySelectorAll("#agentSeg button").forEach((b) => b.classList.toggle("on", b.dataset.agent === info.agent));
  const pending = proj ? [] : sc.comments.filter((c) => c.status === "pending");
  $("#pending").replaceChildren(
    ...(pending.length
      ? [
          h("h4", {}, `To send · ${pending.length}`),
          ...pending.map((c) =>
            h(
              "div",
              { class: "pin" },
              c.still ? h("img", { src: c.still, onclick: () => viewVersion(c.version, c.t) }) : h("div", { class: "noimg", onclick: () => viewVersion(c.version, c.t) }),
              h("div", {}, h("div", { class: "t" }, `v${c.version} · ${fmt(c.t)}s`), c.text),
              h("button", { class: "x", title: "Remove", onclick: () => api(`/api/scene/${sc.id}/comments/${c.id}`, { method: "DELETE" }) }, "×"),
            ),
          ),
        ]
      : []),
  );
  const run = info.running;
  $("#stopBtn").hidden = !run;
  $("#sendBtn").disabled = !!run || (!proj && S.data.project.running) || (proj && S.data.scenes.some((s) => s.running));
  $("#sendBtn").textContent = proj ? "Send" : pending.length ? `Send ${pending.length} comment${pending.length > 1 ? "s" : ""}` : "Send note";
  $("#note").placeholder = proj ? "A change across scenes, e.g. “make every headline 10% smaller”" : "Note for the agent (optional with comments)";
  updateRunState();
}

function updateRunState() {
  const info = S.tab === "project" ? S.data.project : scene();
  const run = info.running;
  $("#runState").textContent = run ? `${AGENT[run.agent]} working · ${Math.round((Date.now() - run.startedAt) / 1000)} s` : "";
}
setInterval(() => S.data && updateRunState(), 1000);

async function send() {
  const note = $("#note").value;
  try {
    if (S.tab === "project") await api("/api/project/send", { body: { text: note } });
    else await api(`/api/scene/${S.sel}/send`, { body: { note } });
    $("#note").value = "";
  } catch (e) {
    toast(e.message);
  }
}

$("#sendBtn").onclick = send;
$("#stopBtn").onclick = () => api(S.tab === "project" ? "/api/project/stop" : `/api/scene/${S.sel}/stop`, { body: {} });
$("#note").addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && send());
document.querySelectorAll("#agentSeg button").forEach((b) =>
  b.addEventListener("click", async () => {
    await api(S.tab === "project" ? "/api/project/agent" : `/api/scene/${S.sel}/agent`, { body: { agent: b.dataset.agent } });
    (S.tab === "project" ? S.data.project : scene()).agent = b.dataset.agent;
    renderPanel();
  }),
);
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    S.tab = b.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    renderPanel();
    loadChat();
  }),
);

// ---------- renders ----------
function renderRenders() {
  const list = $("#renderList");
  list.replaceChildren(...(S.data.renders.length ? S.data.renders.map((r) => h("a", { href: r.url, target: "_blank" }, `${r.file}`, h("div", { class: "muted small" }, `${r.mode} · ${ago(r.at)} · ${Math.round(r.ms / 1000)} s`))) : [h("div", { class: "muted small", style: "padding:8px" }, "No renders yet.")]));
  $("#renderBtn").disabled = S.data.rendering;
}

$("#renderBtn").onclick = async () => {
  try {
    await api("/api/render", { body: { mode: S.wholeMode } });
  } catch (e) {
    toast(e.message);
  }
};

// ---------- modes, transport, keys ----------
function setMode(mode) {
  S.mode = mode;
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  if (mode === "whole") S.pendingSeek = scene().start + 0.02;
  S.loadedKey = null;
  S.compare = null;
  renderVersions();
  loadPlayer();
}

document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
document.querySelectorAll("#wholeSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    S.wholeMode = b.dataset.whole;
    document.querySelectorAll("#wholeSeg button").forEach((x) => x.classList.toggle("on", x === b));
    if (S.mode === "whole") loadPlayer();
  }),
);
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

window.addEventListener("keydown", (e) => {
  if (/TEXTAREA|INPUT/.test(document.activeElement?.tagName) || e.repeat || e.metaKey || e.ctrlKey) return;
  if (e.key === "Escape") return closePop();
  if (e.key === " ") (e.preventDefault(), player.paused === false ? player.pause() : player.play());
  if (e.key === "c") startComment();
  if (e.key === "f") flip();
  if (e.key === "ArrowLeft") player.seek(Math.max(0, player.currentTime - (e.shiftKey ? 1 : 1 / 30)));
  if (e.key === "ArrowRight") player.seek(player.currentTime + (e.shiftKey ? 1 : 1 / 30));
  const i = S.data.scenes.indexOf(scene());
  if (e.key === "[" && i > 0) selectScene(S.data.scenes[i - 1].id, true);
  if (e.key === "]" && i < S.data.scenes.length - 1) selectScene(S.data.scenes[i + 1].id, true);
});

// ---------- live updates ----------
const es = new EventSource("/api/events");
let refreshT;
es.addEventListener("project", () => {
  clearTimeout(refreshT);
  refreshT = setTimeout(refresh, 150);
});
es.addEventListener("chat", (m) => {
  const { key, entry } = JSON.parse(m.data);
  if (key !== panelKey()) return;
  S.chat.push(entry);
  renderChat();
});
es.addEventListener("running", () => {
  clearTimeout(refreshT);
  refreshT = setTimeout(refresh, 150);
});
es.addEventListener("render", (m) => {
  const d = JSON.parse(m.data);
  $("#renderState").textContent = d.state === "progress" ? `Rendering ${d.pct}%` : d.state === "start" ? "Rendering…" : d.state === "done" ? "Render done" : d.state === "failed" ? "Render failed" : "";
  if (d.state === "done") toast("Render done. Open it under Renders.");
  if (d.state === "failed") toast(`Render failed: ${d.error?.slice(-200)}`);
});
es.addEventListener("toast", (m) => toast(JSON.parse(m.data).text));

S.reviewer = (await api("/api/whoami")).reviewer;
await refresh();
await loadChat();
requestAnimationFrame(tick);
