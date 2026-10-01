#!/usr/bin/env node
// Scene loop: a local review app over HTML video scenes, in Caleb Porzio's shape.
// The agent is the chat next to the page (Claude Code desktop or the ChatGPT desktop
// app's built-in browser), which works through the page's tools. This server holds the
// project, versions, comments, stills, previews and renders.
//
//   node server.mjs <projectDir> [--port 4300] [--reviewer Name]
import { createServer } from "node:http";
import { createReadStream, rmSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createHistory } from "./lib/history.mjs";
import { buildScene, buildWhole } from "./lib/assemble.mjs";
import { snapshot, versionTimes, annotate } from "./lib/stills.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const PORT = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 0) || 4300;
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const projectDir = resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? process.cwd());
const REVIEWER = flag("--reviewer") ?? process.env.SCENE_LOOP_REVIEWER ?? "The reviewer";
const rendersDir = join(projectDir, "renders");
if (!existsSync(join(projectDir, "storyboard.json"))) {
  console.error(`No storyboard.json in ${projectDir}. Usage: node server.mjs <projectDir> [--port 4300] [--reviewer Name]`);
  process.exit(1);
}
const stateDir = join(projectDir, ".state");
mkdirSync(stateDir, { recursive: true });
mkdirSync(rendersDir, { recursive: true });

const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const storyboard = () => ({ ...JSON.parse(readFileSync(join(projectDir, "storyboard.json"), "utf8")), themeCss: readIf(join(projectDir, "theme.css")) });

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
  writeFileSync(join(projectDir, "storyboard.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

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

async function commitProjectFiles(note, author) {
  const v = await history.commitProject(["storyboard.json", "theme.css", "frame.md"].filter((f) => existsSync(join(projectDir, f))), note, author);
  rmSync(join(projectDir, ".build"), { recursive: true, force: true }); // previews pick up the new storyboard/theme
  if (v) logChat("_project", { role: "system", text: `Project v${v}: ${note}` });
  emit("project", {});
  return v;
}
const history = createHistory(projectDir);
await history.init(storyboard().scenes.map((s) => s.id));

// ---------- state on disk (.state/) ----------
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const writeJson = (p, v) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, JSON.stringify(v, null, 2)));
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

// ---------- live events (SSE) ----------
const clients = new Set();
function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

// ---------- builds and stills ----------
const rel = (p) => "/p/" + p.slice(projectDir.length + 1);
const stillsDir = (id, v) => join(stateDir, "stills", id, `v${v}`);

async function sceneBuild(id, v) {
  const name = `${id}-v${v}`;
  const dir = join(projectDir, ".build", name);
  if (!existsSync(join(dir, "index.html"))) buildScene(projectDir, storyboard(), id, await history.fileAt(id, v), name);
  return dir;
}

async function makeVersionStills(id, v) {
  const sc = storyboard().scenes.find((s) => s.id === id);
  const out = stillsDir(id, v);
  if (existsSync(out) && readdirSync(out).some((f) => f.endsWith(".png"))) return;
  emit("stills", { id, v, state: "running" });
  try {
    await snapshot(await sceneBuild(id, v), versionTimes(sc.duration), out);
  } catch (e) {
    emit("toast", { text: `Stills for ${id} v${v} failed: ${e.message.slice(0, 200)}` });
  }
  emit("stills", { id, v, state: "done" });
}

function listStills(id, v) {
  const dir = stillsDir(id, v);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => ({ f, m: f.match(/^frame-\d+-at-([\d.]+)s\.png$/) }))
    .filter((x) => x.m)
    .map((x) => ({ t: Number(x.m[1]), url: rel(join(dir, x.f)) }))
    .sort((a, b) => a.t - b.t);
}

async function makeCommentStill(id, c) {
  const out = join(stateDir, "comments", id, `${c.id}.png`);
  if (existsSync(out)) return out;
  const tmp = join(stateDir, "comments", id, `${c.id}-raw`);
  const [shot] = await snapshot(await sceneBuild(id, c.version), [c.t], tmp);
  await annotate(shot.file, c.region, out, storyboard());
  return out;
}

// ---------- hand edits ----------
// Files changed on disk outside the app (an editor, a terminal agent) become a version
// before the next build, so nothing is lost or misattributed.
async function commitManualEdits() {
  for (const s of storyboard().scenes) {
    const v = await history.commitScene(s.id, "manual edit", REVIEWER);
    if (v) {
      const st = sceneState(s.id);
      st.versions[v] = { agent: "manual", at: new Date().toISOString() };
      saveSceneState(s.id, st);
      logChat(s.id, { role: "system", text: `Edit on disk saved as v${v}.` });
      makeVersionStills(s.id, v).then(() => emit("project", {}));
    }
  }
}

// ---------- whole video and render ----------
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

let rendering = null;
async function render(mode) {
  if (rendering) throw new Error("A render is already running");
  const { map, picked } = await wholeHtml(mode);
  const dir = buildWhole(projectDir, storyboard(), map, `render-${mode}`);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const file = join(rendersDir, `whole-${mode}-${stamp}.mp4`);
  const started = Date.now();
  rendering = spawn("npx", ["--yes", "hyperframes@0.8.103", "render", dir, "-o", file, "--quiet"], { cwd: dir });
  emit("render", { state: "start", mode, picked });
  let tail = "";
  const onData = (d) => {
    tail = (tail + d).slice(-4000);
    const m = String(d).match(/(\d{1,3})%/g);
    if (m) emit("render", { state: "progress", pct: Number(m.at(-1).slice(0, -1)) });
  };
  rendering.stdout.on("data", onData);
  rendering.stderr.on("data", onData);
  rendering.on("close", (code) => {
    rendering = null;
    const ok = code === 0 && existsSync(file);
    const ps = projectState();
    if (ok) ps.renders.unshift({ file: file.split("/").pop(), mode, picked, at: new Date().toISOString(), ms: Date.now() - started });
    saveProjectState(ps);
    metric({ kind: "render", mode, ok, ms: Date.now() - started, picked, ...(ok ? {} : { error: tail.slice(-1500) }) });
    if (!ok) writeFileSync(join(rendersDir, "last-render-error.log"), tail);
    emit("render", { state: ok ? "done" : "failed", file: ok ? `/renders/${file.split("/").pop()}` : null, error: ok ? null : tail.slice(-600) });
    emit("project", {});
  });
}

// ---------- project snapshot for the UI ----------
async function projectView() {
  const sb = storyboard();
  const scenes = [];
  for (const s of sb.scenes) {
    const st = sceneState(s.id);
    const vs = await history.versions(s.id);
    const approved = await history.approved(s.id);
    scenes.push({
      ...s,
      approved,
      comments: st.comments.map((c) => ({ ...c, still: existsSync(join(stateDir, "comments", s.id, `${c.id}.png`)) ? rel(join(stateDir, "comments", s.id, `${c.id}.png`)) : null })),
      versions: vs.map((x) => ({ ...x, ...(st.versions[x.v] ?? { agent: x.v === 1 ? "import" : "?" }), stills: listStills(s.id, x.v) })),
    });
  }
  const ps = projectState();
  return {
    title: sb.title, duration: sb.duration, soundtrack: sb.soundtrack, scenes,
    renders: ps.renders.map((r) => ({ ...r, url: `/renders/${r.file}` })),
    rendering: !!rendering,
  };
}

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm" };

function serveFile(req, res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: "not found" });
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Cache-Control": "no-cache" });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
  createReadStream(file).pipe(res);
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const body = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b ? JSON.parse(b) : {})); });

function inside(root, p) {
  const f = normalize(join(root, decodeURIComponent(p)));
  return f.startsWith(root) ? f : null;
}

const routes = [
  ["GET", /^\/api\/project$/, async (m, q) => (q.get("sync") ? await commitManualEdits() : null, projectView())],
  ["GET", /^\/api\/whoami$/, async () => ({ reviewer: REVIEWER })],
  // ---- project tools for the chat next to the page ----
  ["GET", /^\/api\/rules$/, async () => ({
    agents: readIf(join(projectDir, "AGENTS.md")), design: readIf(join(projectDir, "frame.md")), theme: readIf(join(projectDir, "theme.css")),
    sceneContract: "Each scene is scenes/<id>/scene.html: a <template> with a <style>, a root <div id=\"root\" data-composition-id=\"<id>\" data-width data-height data-duration>, and a script that builds ONE paused GSAP timeline and registers it as window.__timelines[\"<id>\"]. Times are seconds from the scene start. Ids and classes must not start with a digit. Prefix element ids with the scene id. Don't use HyperFrames skills or Studio; the app assembles and renders. theme.css is injected after every scene's styles, so project-wide changes (fonts, colours) go there; in the assembled page each scene's #root becomes a .scene element, so target .scene (with !important where a scene sets its own value).",
  })],
  ["GET", /^\/api\/pending$/, async () => {
    const origin = `http://localhost:${PORT}`;
    return storyboard().scenes.flatMap((s) => sceneState(s.id).comments.filter((c) => c.status === "pending").map((c) => ({
      scene: s.id, id: c.id, version: c.version, t: c.t, region: c.region, text: c.text,
      still: existsSync(join(stateDir, "comments", s.id, `${c.id}.png`)) ? origin + rel(join(stateDir, "comments", s.id, `${c.id}.png`)) : null,
    })));
  }],
  ["POST", /^\/api\/project\/meta$/, async (m, q, b) => {
    const sb = storyboard();
    for (const k of ["title", "language", "width", "height", "background", "accent", "soundtrack"]) if (b[k] !== undefined) sb[k] = b[k];
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? "project settings", b.model ?? "chat") };
  }],
  ["POST", /^\/api\/project\/scenes$/, async (m, q, b) => {
    const sb = storyboard();
    let id = b.id ?? `s${String(sb.scenes.length + 1).padStart(2, "0")}-${slug(b.title ?? "scene")}`;
    if (!/^[a-z][\w-]*$/.test(id)) throw new Error("scene id must start with a letter (a-z) and use a-z, 0-9, - or _");
    if (sb.scenes.some((s) => s.id === id) || existsSync(join(projectDir, "scenes", id))) throw new Error(`${id} already exists`);
    const scene = { id, title: b.title ?? id, start: 0, duration: Number(b.duration) || 4, transitionIn: b.transitionIn ?? null, narration: b.narration ?? "", picture: b.picture ?? "" };
    const at = b.after ? sb.scenes.findIndex((s) => s.id === b.after) + 1 : sb.scenes.length;
    sb.scenes.splice(at || sb.scenes.length, 0, scene);
    saveStoryboard(sb);
    mkdirSync(join(projectDir, "scenes", id), { recursive: true });
    writeFileSync(join(projectDir, "scenes", id, "scene.html"), b.html ?? starterScene(id, storyboard(), scene.title));
    const v = await history.commitScene(id, `created by ${b.model ?? "chat"}`, b.model ?? "chat");
    const st = sceneState(id);
    st.versions[v] = { agent: b.model ?? "chat", note: "created", at: new Date().toISOString() };
    saveSceneState(id, st);
    await commitProjectFiles(`add scene ${id}`, b.model ?? "chat");
    makeVersionStills(id, v).then(() => emit("project", {}));
    return { id, version: v, soundtrackWarning: sb.soundtrack ? "Scene starts moved; the soundtrack was not re-cut." : null };
  }],
  ["POST", /^\/api\/project\/scenes\/([\w-]+)$/, async (m, q, b) => {
    const sb = storyboard();
    const s = sb.scenes.find((x) => x.id === m[1]);
    if (!s) throw new Error(`${m[1]} is not a scene`);
    for (const k of ["title", "duration", "narration", "picture", "transitionIn"]) if (b[k] !== undefined) s[k] = k === "duration" ? Number(b[k]) : b[k];
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? `edit ${m[1]} details`, b.model ?? "chat"), note: b.duration !== undefined ? "Also update data-duration in the scene's html." : null };
  }],
  ["POST", /^\/api\/project\/order$/, async (m, q, b) => {
    const sb = storyboard();
    const ids = sb.scenes.map((s) => s.id);
    if (!Array.isArray(b.order) || b.order.length !== ids.length || !ids.every((i) => b.order.includes(i))) throw new Error(`order must list every scene once: ${ids.join(", ")}`);
    sb.scenes = b.order.map((i) => sb.scenes.find((s) => s.id === i));
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? "reorder scenes", b.model ?? "chat") };
  }],
  ["POST", /^\/api\/project\/remove$/, async (m, q, b) => {
    const sb = storyboard();
    if (!sb.scenes.some((s) => s.id === b.scene)) throw new Error(`${b.scene} is not a scene`);
    if (sb.scenes.length === 1) throw new Error("can't remove the last scene");
    sb.scenes = sb.scenes.filter((s) => s.id !== b.scene); // the folder and its versions stay on disk
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? `remove scene ${b.scene} (files kept)`, b.model ?? "chat") };
  }],
  ["POST", /^\/api\/project\/theme$/, async (m, q, b) => {
    if (typeof b.css !== "string") throw new Error("css is required");
    writeFileSync(join(projectDir, "theme.css"), b.css);
    return { version: await commitProjectFiles(b.note ?? "theme.css", b.model ?? "chat") };
  }],
  ["POST", /^\/api\/project\/design$/, async (m, q, b) => {
    if (typeof b.markdown !== "string") throw new Error("markdown is required");
    writeFileSync(join(projectDir, "frame.md"), b.markdown);
    return { version: await commitProjectFiles(b.note ?? "design spec", b.model ?? "chat") };
  }],
  ["GET", /^\/api\/project\/files$/, async () => ({ storyboard: readIf(join(projectDir, "storyboard.json")), theme: readIf(join(projectDir, "theme.css")), design: readIf(join(projectDir, "frame.md")) })],
  // Browser-agent mode (WebMCP / window.sceneLoop): the chat agent next to the page reads
  // and writes scene.html itself; each write is a version.
  ["GET", /^\/api\/scene\/([\w-]+)\/html$/, async (m, q) => {
    const v = q.get("v");
    return { id: m[1], version: v ? Number(v) : (await history.versions(m[1])).at(-1).v, html: v ? await history.fileAt(m[1], Number(v)) : readFileSync(join(projectDir, "scenes", m[1], "scene.html"), "utf8") };
  }],
  ["POST", /^\/api\/scene\/([\w-]+)\/html$/, async (m, q, b) => {
    const id = m[1];
    if (!storyboard().scenes.some((s) => s.id === id)) throw new Error(`${id} is not a scene`);
    if (typeof b.html !== "string" || !b.html.includes(`data-composition-id="${id}"`)) throw new Error(`html must keep the root data-composition-id="${id}"`);
    writeFileSync(join(projectDir, "scenes", id, "scene.html"), b.html);
    const agent = b.model || b.agent || "browser agent";
    const via = ["webmcp", "page-js"].includes(b.via) ? b.via : "api";
    const st = sceneState(id);
    const pending = st.comments.filter((c) => c.status === "pending" && (!b.resolves || b.resolves.includes(c.id)));
    const v = await history.commitScene(id, `${agent}: ${(b.note || pending[0]?.text || "edit").slice(0, 60)}`, agent);
    if (v) {
      for (const c of pending) Object.assign(c, { status: "sent", sentAt: new Date().toISOString(), result: v });
      st.versions[v] = { agent, via, comments: pending.map((c) => c.id), note: b.note, at: new Date().toISOString() };
      saveSceneState(id, st);
      logChat(id, { role: "system", text: `${agent} saved v${v}${b.note ? `: ${b.note}` : ""}.` });
      metric({ kind: "browser-agent-write", scene: id, agent, via, newVersion: v, comments: pending.length });
      emit("project", {});
      makeVersionStills(id, v).then(() => emit("project", {}));
    }
    return { version: v, unchanged: !v };
  }],
  ["POST", /^\/api\/agent\/still$/, async (m, q, b) => {
    const sc = storyboard().scenes.find((s) => s.id === b.scene);
    if (!sc) throw new Error(`${b.scene} is not a scene in storyboard.json`);
    const sceneDir = join(projectDir, "scenes", sc.id);
    const build = buildScene(projectDir, storyboard(), sc.id, readFileSync(join(sceneDir, "scene.html"), "utf8"), join(sceneDir, ".preview", "build"));
    const out = join(sceneDir, ".preview", "stills");
    rmSync(out, { recursive: true, force: true });
    return { stills: (await snapshot(build, b.times?.length ? b.times : versionTimes(sc.duration), out)).map((s) => ({ ...s, url: rel(s.file) })) };
  }],
  ["GET", /^\/api\/chat\/([\w-]+)$/, async (m) => chat(m[1])],
  ["GET", /^\/api\/build\/scene\/([\w-]+)$/, async (m, q) => {
    const v = q.get("v");
    if (v === "disk") {
      buildScene(projectDir, storyboard(), m[1], readFileSync(join(projectDir, "scenes", m[1], "scene.html"), "utf8"), `${m[1]}-disk`);
      return { url: `/p/.build/${m[1]}-disk/index.html?ts=${Date.now()}` };
    }
    await sceneBuild(m[1], Number(v));
    return { url: `/p/.build/${m[1]}-v${v}/index.html` };
  }],
  ["GET", /^\/api\/build\/whole$/, async (m, q) => {
    await commitManualEdits();
    const mode = q.get("mode") === "approved" ? "approved" : "latest";
    const { map, picked } = await wholeHtml(mode);
    buildWhole(projectDir, storyboard(), map, `whole-${mode}`);
    return { url: `/p/.build/whole-${mode}/index.html?ts=${Date.now()}`, picked };
  }],
  ["POST", /^\/api\/scene\/([\w-]+)\/comments$/, async (m, q, b) => {
    const st = sceneState(m[1]);
    const c = { id: randomUUID().slice(0, 8), version: b.version, t: b.t, region: b.region ?? null, text: String(b.text).trim(), status: "pending", createdAt: new Date().toISOString() };
    st.comments.push(c);
    saveSceneState(m[1], st);
    makeCommentStill(m[1], c).then(() => emit("project", {}), () => {});
    emit("project", {});
    return c;
  }],
  ["DELETE", /^\/api\/scene\/([\w-]+)\/comments\/(\w+)$/, async (m) => {
    const st = sceneState(m[1]);
    st.comments = st.comments.filter((c) => !(c.id === m[2] && c.status === "pending"));
    saveSceneState(m[1], st);
    emit("project", {});
    return { ok: true };
  }],
  ["POST", /^\/api\/scene\/([\w-]+)\/approve$/, async (m, q, b) => {
    await history.approve(m[1], b.v);
    logChat(m[1], { role: "system", text: `Approved v${b.v}.` });
    metric({ kind: "approve", scene: m[1], v: b.v });
    emit("project", {});
    return { ok: true };
  }],
  ["POST", /^\/api\/scene\/([\w-]+)\/restore$/, async (m, q, b) => {
    const v = await history.restore(m[1], b.v, REVIEWER);
    const st = sceneState(m[1]);
    if (v) st.versions[v] = { agent: "restore", from: b.v, at: new Date().toISOString() };
    saveSceneState(m[1], st);
    logChat(m[1], { role: "system", text: v ? `Restored v${b.v} as v${v}.` : `v${b.v} is already what is on disk.` });
    metric({ kind: "restore", scene: m[1], from: b.v, newVersion: v });
    if (v) makeVersionStills(m[1], v).then(() => emit("project", {}));
    emit("project", {});
    return { v };
  }],
  ["POST", /^\/api\/render$/, async (m, q, b) => (await render(b.mode === "approved" ? "approved" : "latest"), { ok: true })],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": hi\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return send(res, 200, await fn(m, url.searchParams, req.method === "GET" ? {} : await body(req)));
    }
    if (url.pathname.startsWith("/p/")) {
      const f = inside(projectDir, url.pathname.slice(3));
      return f ? serveFile(req, res, f) : send(res, 403, {});
    }
    if (url.pathname.startsWith("/renders/")) {
      const f = inside(rendersDir, url.pathname.slice(9));
      return f ? serveFile(req, res, f) : send(res, 403, {});
    }
    const f = inside(join(appDir, "public"), url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    return f ? serveFile(req, res, f) : send(res, 403, {});
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

// Stills for every scene's v1 on first start, so the filmstrip has posters.
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`scene-loop on http://localhost:${PORT}  (project ${projectDir})`);
  await commitManualEdits();
  for (const s of storyboard().scenes) {
    const vs = await history.versions(s.id);
    await makeVersionStills(s.id, vs.at(-1).v);
  }
  emit("project", {});
});
