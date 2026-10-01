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
// Every API call carries the current project (?project=), set from the URL or the switcher.
const api = async (path, opts = {}) => {
  if (S.project) path += (path.includes("?") ? "&" : "?") + "project=" + encodeURIComponent(S.project);
  const r = await fetch(path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers: { "Content-Type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); // the login ran out (self-hosted)
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
const AGENT = { claude: "Claude", codex: "Codex", chat: "Chat", manual: "Manual edit", restore: "Restore", import: "Import" };

const S = {
  project: new URLSearchParams(location.search).get("project"),
  projects: [],
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

// ---------- projects ----------
async function loadProjects() {
  const r = await fetch("/api/projects").then((x) => x.json());
  S.projects = r.projects;
  S.single = r.single;
  if (!S.projects.some((p) => p.name === S.project)) S.project = S.projects[0]?.name ?? null;
  const sel = $("#projectSel");
  sel.replaceChildren(...S.projects.map((p) => h("option", { value: p.name, selected: p.name === S.project }, p.title === p.name ? p.name : `${p.title} (${p.name})`)));
  $("#newProject").hidden = r.single;
  $("#empty").hidden = !!S.project;
  document.body.classList.toggle("no-project", !S.project);
  $("#empty").textContent = S.project ? "" : `No projects in ${r.root}. Click New project, or ask the chat to create_project.`;
  return !!S.project;
}

function switchProject(name) {
  const u = new URL(location.href);
  u.searchParams.set("project", name);
  location.href = u; // a fresh page: the player, versions and chat all belong to one project
}

$("#projectSel").onchange = (e) => switchProject(e.target.value);
$("#newProject").onclick = async () => {
  const name = prompt("Folder name for the new project (letters, digits, - _ .):");
  if (!name) return;
  try {
    const r = await api("/api/tools/create_project", { body: { args: { name }, via: "page-js" } });
    switchProject(r.name);
  } catch (e) {
    toast(e.message);
  }
};

// ---------- data ----------
async function refresh() {
  if (!S.project) return;
  S.data = await api("/api/project");
  S.sel ??= S.data.scenes[0].id;
  document.title = `${S.data.title} · Scene loop`;
  $("#meta").textContent = `${S.data.scenes.length} scenes · ${S.data.duration.toFixed(1)}s`;
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

function tick() {
  if (S.data) {
    const t = player.currentTime || 0;
    const D = duration();
    $("#time").replaceChildren(fmt(t), h("span", { class: "total" }, ` / ${fmt(D)}s`));
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
        { class: `card ${s.id === S.sel ? "on" : ""}`, "data-id": s.id, onclick: () => selectScene(s.id, true) },
        h(
          "div",
          { class: "thumb" },
          h("span", { class: "num" }, i + 1),
          poster ? h("img", { src: poster.url, alt: "" }) : h("div", { class: "noimg" }),
          h(
            "div",
            { class: "badges" },
            lv > 1 ? h("span", { class: "badge" }, `v${lv}`) : null,
            s.approved ? h("span", { class: "badge ok" }, s.approved === lv ? "✓" : `✓v${s.approved}`) : null,
            pins ? h("span", { class: "badge pins" }, pins) : null,
          ),
        ),
        h("div", { class: "cap" }, h("b", {}, s.title), h("span", { class: "muted" }, `${s.duration.toFixed(2)}s`)),
      );
    }),
  );
}

function selectScene(id, fromStrip) {
  S.sel = id;
  S.compare = null;
  if (S.mode === "whole" && fromStrip) player.seek(scene(id).start + 0.02);
  renderFilmstrip();
  $("#filmstrip").querySelector(".card.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  renderVersions();
  if (S.tab === "scene") loadChat();
  renderPanel();
  if (S.mode === "scene") loadPlayer();
}

// ---------- versions ----------
function renderVersions() {
  const sc = scene();
  const i = S.data.scenes.indexOf(sc);
  $("#sceneLabel").textContent = `Scene ${i + 1} of ${S.data.scenes.length} · ${sc.id}`;
  $("#title").textContent = `· ${S.data.title}`;
  $("#versionsTitle").textContent = `Versions · ${sc.id}`;
  $("#versionsBtn").textContent = `Versions (${sc.versions.length})`;
  $("#versionsBtn").classList.toggle("on", !!S.showVersions);
  $("#versionsSec").hidden = !S.showVersions;
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
        h("div", {}, h("div", { class: "vnum" }, `v${v.v}`), h("div", { class: "vmeta" }, AGENT[v.agent] ?? v.agent), v.via ? h("div", { class: "vmeta" }, `via ${v.via === "webmcp" ? "WebMCP" : v.via === "page-js" ? "page JS" : v.via}`) : null, h("div", { class: "vmeta" }, ago(v.at ?? v.date)), v.ms ? h("div", { class: "vmeta" }, `${Math.round(v.ms / 1000)} s turn`) : null),
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

function showVersions(on = !S.showVersions) {
  S.showVersions = on;
  renderVersions();
  if (on) $(".left").scrollTo({ top: $("#versionsSec").offsetTop - 12, behavior: "smooth" });
}
$("#versionsBtn").onclick = () => showVersions();

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
  S.showVersions = true;
  renderVersions();
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
    else out.push(h("div", { class: `msg ${e.role}` }, h("span", { class: "who" }, e.role === "user" ? S.reviewer : AGENT[e.agent]), e.text));
  }
  box.replaceChildren(...(out.length ? out : [h("div", { class: "empty" }, S.tab === "project" ? "Project changes show up here." : "Nothing yet. Pin a comment on the frame; the chat next to this page picks it up.")]));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// The right panel is the scene's activity and its open comments. The agent is the chat
// next to this page (left side), which picks comments up through get_pending_comments.
const CHAT_PROMPT = "Apply my pending comments in scene-loop (get_pending_comments), save each scene with write_scene_html, and show me the result.";

function renderPanel() {
  const sc = scene();
  const proj = S.tab === "project";
  $("#sceneTab").textContent = `Scene ${S.data.scenes.indexOf(sc) + 1}`;
  $("#panelTitle").textContent = proj ? "Project" : `${S.data.scenes.indexOf(sc) + 1}. ${sc.title}`;
  $("#panelSub").textContent = proj ? "Settings, scene list, theme and design spec" : `${sc.id} · ${sc.duration.toFixed(2)} s`;
  const pending = proj ? [] : sc.comments.filter((c) => c.status === "pending");
  const allPending = S.data.scenes.reduce((n, s) => n + s.comments.filter((c) => c.status === "pending").length, 0);
  $("#pending").replaceChildren(
    ...(pending.length
      ? [
          h("h4", {}, `Open comments · ${pending.length}`),
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
  $("#composer").hidden = proj;
  $("#handoff").textContent = allPending ? `${allPending} open comment${allPending > 1 ? "s" : ""} for the chat` : "⌘↵ to add";
  $("#copyPrompt").hidden = !allPending;
}

async function addNote() {
  const text = $("#note").value.trim();
  if (!text) return;
  let sc = scene(), t = player.currentTime || 0, v = viewed();
  if (S.mode === "whole") {
    sc = sceneAt(t);
    t -= sc.start;
    v = S.picked[sc.id] ?? latest(sc);
  }
  try {
    await api(`/api/scene/${sc.id}/comments`, { body: { version: v, t: Math.round(t * 100) / 100, region: null, text } });
    $("#note").value = "";
  } catch (e) {
    toast(e.message);
  }
}

$("#addNote").onclick = addNote;
$("#note").addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && addNote());
$("#copyPrompt").onclick = async () => {
  await navigator.clipboard.writeText(CHAT_PROMPT).catch(() => {});
  toast("Copied. Paste it in the chat next to this page.");
};
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
  if (e.key === "v") showVersions();
  if (e.key === "ArrowLeft") player.seek(Math.max(0, player.currentTime - (e.shiftKey ? 1 : 1 / 30)));
  if (e.key === "ArrowRight") player.seek(player.currentTime + (e.shiftKey ? 1 : 1 / 30));
  const i = S.data.scenes.indexOf(scene());
  if (e.key === "[" && i > 0) selectScene(S.data.scenes[i - 1].id, true);
  if (e.key === "]" && i < S.data.scenes.length - 1) selectScene(S.data.scenes[i + 1].id, true);
});

// ---------- live updates ----------
const es = new EventSource("/api/events");
let refreshT;
const mine = (m) => { const d = JSON.parse(m.data || "{}"); return !d.project || d.project === S.project; };
es.addEventListener("projects", () => loadProjects());
es.addEventListener("project", (m) => {
  if (!mine(m)) return;
  clearTimeout(refreshT);
  refreshT = setTimeout(refresh, 150);
});
es.addEventListener("chat", (m) => {
  if (!mine(m)) return;
  const { key, entry } = JSON.parse(m.data);
  if (key !== panelKey()) return;
  S.chat.push(entry);
  renderChat();
});
es.addEventListener("render", (m) => {
  if (!mine(m)) return;
  const d = JSON.parse(m.data);
  $("#renderState").textContent = d.state === "progress" ? `Rendering ${d.pct}%` : d.state === "start" ? "Rendering…" : d.state === "done" ? "Render done" : d.state === "failed" ? "Render failed" : "";
  if (d.state === "done") toast("Render done. Open it under Renders.");
  if (d.state === "failed") toast(`Render failed: ${d.error?.slice(-300)} (full log: renders/last-render-error.log)`);
});
es.addEventListener("toast", (m) => mine(m) && toast(JSON.parse(m.data).text));

// ---------- tools for a browser agent next to the page ----------
// The tool list comes from the server (lib/tools.mjs), the same one the MCP endpoint
// serves, and every call goes to POST /api/tools/<name> for the current project. Only
// show_scene, which drives this page's player, is defined here. Registered with WebMCP
// when the browser supports it (ChatGPT desktop "Site tools", Chrome origin trial), and
// always exposed as window.sceneLoop for agents that can run page JavaScript.
const serverTools = (await api("/api/tools")).map((t) => ({ ...t, execute: (args, via) => api(`/api/tools/${t.name}`, { body: { args, via } }) }));
const TOOLS = [
  ...serverTools,
  { name: "show_scene", description: "Show a scene in the preview at a time in seconds (scene time), so the reviewer sees it.", inputSchema: { type: "object", properties: { scene: { type: "string", description: "Scene id" }, t: { type: "number" } }, required: ["scene"] },
    execute: async ({ scene, t = 0 }) => { if (S.mode !== "scene") setMode("scene"); selectScene(scene); delete S.view[scene]; await loadPlayer(true); player.seek(t); return { shown: scene, t }; } },
];
window.sceneLoop = Object.fromEntries(TOOLS.map((t) => [t.name, (args = {}) => t.execute(args, "page-js")]));
window.sceneLoop.help = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const mc = document.modelContext ?? navigator.modelContext;
if (mc?.registerTool) {
  for (const t of TOOLS) {
    try {
      mc.registerTool({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: async (args) => ({ content: [{ type: "text", text: JSON.stringify(await t.execute(args ?? {}, "webmcp")) }] }) });
    } catch (e) {
      console.warn("WebMCP registerTool failed", t.name, e);
    }
  }
}
document.documentElement.dataset.webmcp = mc?.registerTool ? "registered" : "unavailable";

S.reviewer = (await api("/api/whoami")).reviewer;
if (await loadProjects()) {
  await refresh();
  await loadChat();
  requestAnimationFrame(tick);
}
