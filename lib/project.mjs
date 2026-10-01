// One open project: its storyboard, version history (.history), state (.state), builds
// (.build), stills and renders. Everything a tool or a UI route does to a project goes
// through the object returned by openProject, so the MCP endpoint and the page share it.
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createHistory } from "./history.mjs";
import { buildScene, buildWhole } from "./assemble.mjs";
import { snapshot, versionTimes, annotate } from "./stills.mjs";

export const SCENE_CONTRACT =
  "Each scene is scenes/<id>/scene.html: a <template> with a <style>, a root <div id=\"root\" data-composition-id=\"<id>\" data-width data-height data-duration>, and a script that builds ONE paused GSAP timeline and registers it as window.__timelines[\"<id>\"]. Times are seconds from the scene start. Ids and classes must not start with a digit. Prefix element ids with the scene id. Don't use HyperFrames skills or Studio; the app assembles and renders. theme.css is injected after every scene's styles, so project-wide changes (fonts, colours) go there; in the assembled page each scene's #root becomes a .scene element, so target .scene (with !important where a scene sets its own value).";

const starterScene = (id, sb, title) => `<template>
<style>
#root{position:absolute;inset:0;width:${sb.width ?? 1920}px;height:${sb.height ?? 1080}px;background-color:${sb.background ?? "#FFFFFF"};color:#111111;font-family:system-ui,sans-serif;overflow:hidden}
#${id}-title{position:absolute;left:0;right:0;top:46%;text-align:center;font-size:96px;font-weight:700;letter-spacing:-0.03em}
</style>
<div id="root" data-composition-id="${id}" data-width="${sb.width ?? 1920}" data-height="${sb.height ?? 1080}" data-duration="${sb.scenes.find((s) => s.id === id).duration}">
  <div id="${id}-title">${String(title).replace(/</g, "&lt;")}</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script>
(function () {
  window.__timelines = window.__timelines || {};
  var tl = gsap.timeline({ paused: true });
  tl.fromTo("#${id}-title", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out" }, 0.3);
  window.__timelines["${id}"] = tl;
})();
</script>
</template>
`;

const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40) || "scene";

const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const writeJson = (p, v) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, JSON.stringify(v, null, 2)));

// emit(type, data) is the server's SSE broadcast; every event from a project carries its name.
export async function openProject(dir, { name, reviewer, emit: emitAll }) {
  const emit = (type, data = {}) => emitAll(type, { project: name, ...data });
  const stateDir = join(dir, ".state");
  const rendersDir = join(dir, "renders");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(rendersDir, { recursive: true });

  const storyboard = () => ({ ...JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")), themeCss: readIf(join(dir, "theme.css")) });

  // Scene starts follow from order and durations, so adding, removing or reordering
  // scenes never leaves gaps. A soundtrack laid to the old cuts won't follow; callers warn.
  function saveStoryboard(sb) {
    const { themeCss, ...out } = sb;
    let t = 0;
    for (const s of out.scenes) {
      s.start = Math.round(t * 1000) / 1000;
      t += s.duration;
    }
    out.duration = Math.round(t * 1000) / 1000;
    writeFileSync(join(dir, "storyboard.json"), JSON.stringify(out, null, 2) + "\n");
    return out;
  }

  const history = createHistory(dir);
  await history.init(storyboard().scenes.map((s) => s.id));

  // ---------- state on disk (.state/) ----------
  const sceneStatePath = (id) => join(stateDir, "scenes", `${id}.json`);
  const sceneState = (id) => readJson(sceneStatePath(id), { comments: [], versions: {} });
  const saveSceneState = (id, s) => writeJson(sceneStatePath(id), s);
  const chatPath = (key) => join(stateDir, "chat", `${key}.jsonl`);
  const chat = (key) => (existsSync(chatPath(key)) ? readFileSync(chatPath(key), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  function logChat(key, entry) {
    const e = { at: new Date().toISOString(), ...entry };
    mkdirSync(dirname(chatPath(key)), { recursive: true });
    appendFileSync(chatPath(key), JSON.stringify(e) + "\n");
    emit("chat", { key, entry: e });
  }
  const metric = (m) => appendFileSync(join(stateDir, "metrics.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...m }) + "\n");
  const projectState = () => readJson(join(stateDir, "project.json"), { renders: [] });
  const saveProjectState = (s) => writeJson(join(stateDir, "project.json"), s);

  const mustScene = (id) => {
    const s = storyboard().scenes.find((x) => x.id === id);
    if (!s) throw new Error(`${id} is not a scene in ${name}`);
    return s;
  };

  async function commitProjectFiles(note, author) {
    const v = await history.commitProject(["storyboard.json", "theme.css", "frame.md"].filter((f) => existsSync(join(dir, f))), note, author);
    rmSync(join(dir, ".build"), { recursive: true, force: true }); // previews pick up the new storyboard/theme
    if (v) logChat("_project", { role: "system", text: `Project v${v}: ${note}` });
    emit("project");
    return v;
  }

  // ---------- builds and stills ----------
  // Project files are served under /p/<project>/...
  const rel = (p) => `/p/${encodeURIComponent(name)}/` + p.slice(dir.length + 1);
  const stillsDir = (id, v) => join(stateDir, "stills", id, `v${v}`);

  async function sceneBuild(id, v) {
    const bn = `${id}-v${v}`;
    const out = join(dir, ".build", bn);
    if (!existsSync(join(out, "index.html"))) buildScene(dir, storyboard(), id, await history.fileAt(id, v), bn);
    return out;
  }

  const stillJobs = new Map(); // "id:v" -> promise, so two callers don't snapshot the same version twice
  function makeVersionStills(id, v) {
    const key = `${id}:${v}`;
    if (stillJobs.has(key)) return stillJobs.get(key);
    const job = (async () => {
      const sc = storyboard().scenes.find((s) => s.id === id);
      const out = stillsDir(id, v);
      if (!sc || (existsSync(out) && readdirSync(out).some((f) => f.endsWith(".png")))) return;
      emit("stills", { id, v, state: "running" });
      try {
        await snapshot(await sceneBuild(id, v), versionTimes(sc.duration), out);
      } catch (e) {
        emit("toast", { text: `Stills for ${id} v${v} failed: ${e.message.slice(0, 200)}` });
      }
      emit("stills", { id, v, state: "done" });
    })().finally(() => stillJobs.delete(key));
    stillJobs.set(key, job);
    return job;
  }

  function listStills(id, v) {
    const d = stillsDir(id, v);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .map((f) => ({ f, m: f.match(/^frame-\d+-at-([\d.]+)s\.png$/) }))
      .filter((x) => x.m)
      .map((x) => ({ t: Number(x.m[1]), file: join(d, x.f), url: rel(join(d, x.f)) }))
      .sort((a, b) => a.t - b.t);
  }

  const commentStillPath = (id, cid) => join(stateDir, "comments", id, `${cid}.png`);
  async function makeCommentStill(id, c) {
    const out = commentStillPath(id, c.id);
    if (existsSync(out)) return out;
    const tmp = join(stateDir, "comments", id, `${c.id}-raw`);
    const [shot] = await snapshot(await sceneBuild(id, c.version), [c.t], tmp);
    await annotate(shot.file, c.region, out, storyboard());
    return out;
  }

  // ---------- hand edits ----------
  // Files changed on disk outside the app (an editor, a terminal agent) become a version
  // before the next build, so nothing is lost or misattributed.
  async function commitManualEdits(only) {
    for (const s of storyboard().scenes) {
      if (only && s.id !== only) continue;
      const v = await history.commitScene(s.id, "manual edit", reviewer);
      if (v) {
        const st = sceneState(s.id);
        st.versions[v] = { agent: "manual", at: new Date().toISOString() };
        saveSceneState(s.id, st);
        logChat(s.id, { role: "system", text: `Edit on disk saved as v${v}.` });
        makeVersionStills(s.id, v).then(() => emit("project"));
      }
    }
  }

  // ---------- whole video and render jobs ----------
  async function wholeHtml(mode) {
    const sb = storyboard();
    const map = {};
    const picked = {};
    for (const s of sb.scenes) {
      const vs = await history.versions(s.id);
      const v = (mode === "approved" && (await history.approved(s.id))) || vs.at(-1).v;
      picked[s.id] = v;
      map[s.id] = await history.fileAt(s.id, v);
    }
    return { map, picked };
  }

  const jobs = new Map(); // render jobs for this process; finished renders also land in .state/project.json
  let running = null;
  const jobView = (j) => j && { job: j.id, state: j.state, pct: j.pct, mode: j.mode, picked: j.picked, startedAt: j.startedAt, ms: j.ms, file: j.file ? j.file.split("/").pop() : null, path: j.file, url: j.state === "done" ? `/renders/${encodeURIComponent(name)}/${j.file.split("/").pop()}` : null, error: j.error };

  async function render(mode) {
    if (running) throw new Error(`A render is already running (job ${running.id})`);
    const { map, picked } = await wholeHtml(mode);
    const buildDir = buildWhole(dir, storyboard(), map, `render-${mode}`);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const file = join(rendersDir, `whole-${mode}-${stamp}.mp4`);
    const job = { id: randomUUID().slice(0, 8), state: "running", pct: 0, mode, picked, file, startedAt: new Date().toISOString(), ms: null, error: null };
    jobs.set(job.id, job);
    running = job;
    const started = Date.now();
    const proc = spawn("npx", ["--yes", "hyperframes@0.8.103", "render", buildDir, "-o", file, "--quiet"], { cwd: buildDir });
    emit("render", { state: "start", job: job.id, mode, picked });
    let tail = "";
    const onData = (d) => {
      tail = (tail + d).slice(-4000);
      const m = String(d).match(/(\d{1,3})%/g);
      if (m) {
        job.pct = Number(m.at(-1).slice(0, -1));
        emit("render", { state: "progress", job: job.id, pct: job.pct });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (e) => (tail += `\n${e.message}`));
    proc.on("close", (code) => {
      running = null;
      const ok = code === 0 && existsSync(file);
      job.ms = Date.now() - started;
      job.state = ok ? "done" : "failed";
      job.pct = ok ? 100 : job.pct;
      job.error = ok ? null : tail.slice(-600);
      const ps = projectState();
      if (ok) ps.renders.unshift({ file: file.split("/").pop(), mode, picked, at: new Date().toISOString(), ms: job.ms });
      saveProjectState(ps);
      metric({ kind: "render", mode, ok, ms: job.ms, picked, ...(ok ? {} : { error: tail.slice(-1500) }) });
      if (!ok) writeFileSync(join(rendersDir, "last-render-error.log"), tail);
      emit("render", { state: job.state, job: job.id, file: ok ? jobView(job).url : null, error: job.error });
      emit("project");
    });
    return jobView(job);
  }

  const getRender = (id) => {
    if (id) {
      if (!jobs.has(id)) throw new Error(`No render job ${id} in this server process`);
      return jobView(jobs.get(id));
    }
    const last = [...jobs.values()].at(-1);
    return { latest: jobView(last) ?? null, renders: projectState().renders.map((r) => ({ ...r, url: `/renders/${encodeURIComponent(name)}/${r.file}`, path: join(rendersDir, r.file) })) };
  };

  // ---------- views ----------
  async function view() {
    const sb = storyboard();
    const scenes = [];
    for (const s of sb.scenes) {
      const st = sceneState(s.id);
      const vs = await history.versions(s.id);
      const approved = await history.approved(s.id);
      scenes.push({
        ...s,
        approved,
        comments: st.comments.map((c) => ({ ...c, still: existsSync(commentStillPath(s.id, c.id)) ? rel(commentStillPath(s.id, c.id)) : null })),
        versions: vs.map((x) => ({ ...x, ...(st.versions[x.v] ?? { agent: x.v === 1 ? "import" : "?" }), stills: listStills(s.id, x.v).map(({ t, url }) => ({ t, url })) })),
      });
    }
    const ps = projectState();
    return {
      name, title: sb.title, duration: sb.duration, soundtrack: sb.soundtrack, scenes,
      renders: ps.renders.map((r) => ({ ...r, url: `/renders/${encodeURIComponent(name)}/${r.file}` })),
      rendering: !!running,
    };
  }

  const rules = () => ({ agents: readIf(join(dir, "AGENTS.md")), design: readIf(join(dir, "frame.md")), theme: readIf(join(dir, "theme.css")), sceneContract: SCENE_CONTRACT });
  const files = () => ({ storyboard: readIf(join(dir, "storyboard.json")), theme: readIf(join(dir, "theme.css")), design: readIf(join(dir, "frame.md")) });

  async function listScenes() {
    return (await view()).scenes.map((s) => ({ id: s.id, title: s.title, start: s.start, duration: s.duration, narration: s.narration, picture: s.picture, latest: s.versions.at(-1)?.v, approved: s.approved, pendingComments: s.comments.filter((c) => c.status === "pending").map(({ id, version, t, region, text }) => ({ id, version, t, region, text })) }));
  }

  // Pending comments with their annotated still. Missing stills are made on the spot.
  async function pending() {
    const out = [];
    for (const s of storyboard().scenes) {
      for (const c of sceneState(s.id).comments.filter((c) => c.status === "pending")) {
        let file = null;
        try {
          file = await makeCommentStill(s.id, c);
        } catch {}
        out.push({ scene: s.id, id: c.id, version: c.version, t: c.t, region: c.region, text: c.text, still: file ? rel(file) : null, file });
      }
    }
    return out;
  }

  // ---------- mutations ----------
  async function setMeta(b) {
    const sb = storyboard();
    for (const k of ["title", "language", "width", "height", "background", "accent", "soundtrack"]) if (b[k] !== undefined) sb[k] = b[k];
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? "project settings", b.model ?? "chat") };
  }

  async function createScene(b) {
    const sb = storyboard();
    const id = b.id ?? `s${String(sb.scenes.length + 1).padStart(2, "0")}-${slug(b.title ?? "scene")}`;
    if (!/^[a-z][\w-]*$/.test(id)) throw new Error("scene id must start with a letter (a-z) and use a-z, 0-9, - or _");
    if (sb.scenes.some((s) => s.id === id) || existsSync(join(dir, "scenes", id))) throw new Error(`${id} already exists`);
    const scene = { id, title: b.title ?? id, start: 0, duration: Number(b.duration) || 4, transitionIn: b.transitionIn ?? null, narration: b.narration ?? "", picture: b.picture ?? "" };
    const at = b.after ? sb.scenes.findIndex((s) => s.id === b.after) + 1 : sb.scenes.length;
    sb.scenes.splice(at || sb.scenes.length, 0, scene);
    saveStoryboard(sb);
    mkdirSync(join(dir, "scenes", id), { recursive: true });
    writeFileSync(join(dir, "scenes", id, "scene.html"), b.html ?? starterScene(id, storyboard(), scene.title));
    const v = await history.commitScene(id, `created by ${b.model ?? "chat"}`, b.model ?? "chat");
    const st = sceneState(id);
    st.versions[v] = { agent: b.model ?? "chat", via: b.via, note: "created", at: new Date().toISOString() };
    saveSceneState(id, st);
    await commitProjectFiles(`add scene ${id}`, b.model ?? "chat");
    makeVersionStills(id, v).then(() => emit("project"));
    return { id, version: v, soundtrackWarning: sb.soundtrack ? "Scene starts moved; the soundtrack was not re-cut." : null };
  }

  async function updateScene(id, b) {
    const sb = storyboard();
    const s = sb.scenes.find((x) => x.id === id);
    if (!s) throw new Error(`${id} is not a scene`);
    for (const k of ["title", "duration", "narration", "picture", "transitionIn"]) if (b[k] !== undefined) s[k] = k === "duration" ? Number(b[k]) : b[k];
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? `edit ${id} details`, b.model ?? "chat"), note: b.duration !== undefined ? "Also update data-duration in the scene's html." : null };
  }

  async function reorder(order, b = {}) {
    const sb = storyboard();
    const ids = sb.scenes.map((s) => s.id);
    if (!Array.isArray(order) || order.length !== ids.length || !ids.every((i) => order.includes(i))) throw new Error(`order must list every scene once: ${ids.join(", ")}`);
    sb.scenes = order.map((i) => sb.scenes.find((s) => s.id === i));
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? "reorder scenes", b.model ?? "chat") };
  }

  async function removeScene(id, b = {}) {
    const sb = storyboard();
    if (!sb.scenes.some((s) => s.id === id)) throw new Error(`${id} is not a scene`);
    if (sb.scenes.length === 1) throw new Error("can't remove the last scene");
    sb.scenes = sb.scenes.filter((s) => s.id !== id); // the folder and its versions stay on disk
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? `remove scene ${id} (files kept)`, b.model ?? "chat") };
  }

  async function setTheme(css, b = {}) {
    if (typeof css !== "string") throw new Error("css is required");
    writeFileSync(join(dir, "theme.css"), css);
    return { version: await commitProjectFiles(b.note ?? "theme.css", b.model ?? "chat") };
  }

  async function setDesign(markdown, b = {}) {
    if (typeof markdown !== "string") throw new Error("markdown is required");
    writeFileSync(join(dir, "frame.md"), markdown);
    return { version: await commitProjectFiles(b.note ?? "design spec", b.model ?? "chat") };
  }

  async function sceneHtml(id, v) {
    mustScene(id);
    return { id, version: v ? Number(v) : (await history.versions(id)).at(-1).v, html: v ? await history.fileAt(id, Number(v)) : readFileSync(join(dir, "scenes", id, "scene.html"), "utf8") };
  }

  // Every write is a version. via records the channel: webmcp, page-js, mcp or api.
  async function writeSceneHtml(id, b, via) {
    mustScene(id);
    if (typeof b.html !== "string" || !b.html.includes(`data-composition-id="${id}"`)) throw new Error(`html must keep the root data-composition-id="${id}"`);
    writeFileSync(join(dir, "scenes", id, "scene.html"), b.html);
    const agent = b.model || b.agent || "browser agent";
    const st = sceneState(id);
    const pend = st.comments.filter((c) => c.status === "pending" && (!b.resolves || b.resolves.includes(c.id)));
    const v = await history.commitScene(id, `${agent}: ${(b.note || pend[0]?.text || "edit").slice(0, 60)}`, agent);
    if (v) {
      for (const c of pend) Object.assign(c, { status: "sent", sentAt: new Date().toISOString(), result: v });
      st.versions[v] = { agent, via, comments: pend.map((c) => c.id), note: b.note, at: new Date().toISOString() };
      saveSceneState(id, st);
      logChat(id, { role: "system", text: `${agent} saved v${v}${b.note ? `: ${b.note}` : ""}.` });
      metric({ kind: "agent-write", scene: id, agent, via, newVersion: v, comments: pend.length });
      emit("project");
      makeVersionStills(id, v).then(() => emit("project"));
    }
    return { version: v, unchanged: !v, resolved: v ? pend.map((c) => c.id) : [] };
  }

  // Stills of a scene. With times: a fresh snapshot of what is on disk, into .preview.
  // Without: the latest version's five stills (a disk edit becomes a version first).
  async function stills(id, times, version) {
    const sc = mustScene(id);
    if (!times?.length) {
      if (!version) await commitManualEdits(id);
      const v = version ?? (await history.versions(id)).at(-1).v;
      await makeVersionStills(id, v);
      return { scene: id, version: v, stills: listStills(id, v) };
    }
    const sceneDir = join(dir, "scenes", sc.id);
    const build = buildScene(dir, storyboard(), sc.id, readFileSync(join(sceneDir, "scene.html"), "utf8"), join(sceneDir, ".preview", "build"));
    const out = join(sceneDir, ".preview", "stills");
    rmSync(out, { recursive: true, force: true });
    return { scene: id, version: null, stills: (await snapshot(build, times, out)).map((s) => ({ t: s.t, file: s.file, url: rel(s.file) })) };
  }

  async function addComment(id, b) {
    mustScene(id);
    const version = b.version ?? (await history.versions(id)).at(-1).v;
    const st = sceneState(id);
    const c = { id: randomUUID().slice(0, 8), version, t: Number(b.t) || 0, region: b.region ?? null, text: String(b.text ?? "").trim(), status: "pending", createdAt: new Date().toISOString() };
    if (!c.text) throw new Error("text is required");
    st.comments.push(c);
    saveSceneState(id, st);
    makeCommentStill(id, c).then(() => emit("project"), () => {});
    emit("project");
    return c;
  }

  function deleteComment(id, cid) {
    const st = sceneState(id);
    st.comments = st.comments.filter((c) => !(c.id === cid && c.status === "pending"));
    saveSceneState(id, st);
    emit("project");
    return { ok: true };
  }

  async function approve(id, v) {
    mustScene(id);
    await history.approve(id, v);
    logChat(id, { role: "system", text: `Approved v${v}.` });
    metric({ kind: "approve", scene: id, v });
    emit("project");
    return { ok: true, scene: id, approved: v };
  }

  async function restore(id, from) {
    mustScene(id);
    const v = await history.restore(id, from, reviewer);
    const st = sceneState(id);
    if (v) st.versions[v] = { agent: "restore", from, at: new Date().toISOString() };
    saveSceneState(id, st);
    logChat(id, { role: "system", text: v ? `Restored v${from} as v${v}.` : `v${from} is already what is on disk.` });
    metric({ kind: "restore", scene: id, from, newVersion: v });
    if (v) makeVersionStills(id, v).then(() => emit("project"));
    emit("project");
    return { v };
  }

  // ---------- previews for the page ----------
  async function sceneBuildUrl(id, v) {
    if (v === "disk") {
      buildScene(dir, storyboard(), id, readFileSync(join(dir, "scenes", id, "scene.html"), "utf8"), `${id}-disk`);
      return { url: rel(join(dir, ".build", `${id}-disk`, "index.html")) + `?ts=${Date.now()}` };
    }
    await sceneBuild(id, Number(v));
    return { url: rel(join(dir, ".build", `${id}-v${v}`, "index.html")) };
  }

  async function wholeBuildUrl(mode) {
    await commitManualEdits();
    const { map, picked } = await wholeHtml(mode);
    buildWhole(dir, storyboard(), map, `whole-${mode}`);
    return { url: rel(join(dir, ".build", `whole-${mode}`, "index.html")) + `?ts=${Date.now()}`, picked };
  }

  // Posters for the filmstrip: stills for every scene's latest version. Runs in the
  // background after open; cached stills make it a no-op.
  async function warm() {
    await commitManualEdits();
    for (const s of storyboard().scenes) {
      const vs = await history.versions(s.id);
      await makeVersionStills(s.id, vs.at(-1).v);
    }
    emit("project");
  }

  return {
    name, dir, rendersDir, storyboard, history, chat, view, rules, files, listScenes, pending,
    setMeta, createScene, updateScene, reorder, removeScene, setTheme, setDesign,
    sceneHtml, writeSceneHtml, stills, addComment, deleteComment, approve, restore,
    render, getRender, sceneBuildUrl, wholeBuildUrl, commitManualEdits, warm,
  };
}
