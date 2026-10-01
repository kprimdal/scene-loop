#!/usr/bin/env node
// Scene loop: a local review app over a HyperFrames project, in Caleb Porzio's shape.
// Scenes, one agent session per scene (Claude or Codex via their CLIs), versions,
// pinned comments sent in batches, whole-video playback and render.
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
import { runTurn } from "./lib/agents.mjs";

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
const stillBin = join(appDir, "bin", "still.mjs");
const stillCmd = () => `node ${stillBin} --port ${PORT}`;
mkdirSync(stateDir, { recursive: true });
mkdirSync(rendersDir, { recursive: true });

const storyboard = () => JSON.parse(readFileSync(join(projectDir, "storyboard.json"), "utf8"));
const history = createHistory(projectDir);
await history.init(storyboard().scenes.map((s) => s.id));

// ---------- state on disk (.state/) ----------
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const writeJson = (p, v) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, JSON.stringify(v, null, 2)));
const sceneStatePath = (id) => join(stateDir, "scenes", `${id}.json`);
const sceneState = (id) => readJson(sceneStatePath(id), { agent: "claude", sessions: {}, comments: [], versions: {} });
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
const projectState = () => readJson(join(stateDir, "project.json"), { agent: "claude", sessions: {}, renders: [] });
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

// ---------- the agent loop ----------
const running = new Map(); // key (scene id or "_project") -> { agent, startedAt, handle }

async function commitManualEdits() {
  for (const s of storyboard().scenes) {
    if (running.has(s.id) || running.has("_project")) continue;
    const v = await history.commitScene(s.id, "manual edit", REVIEWER);
    if (v) {
      const st = sceneState(s.id);
      st.versions[v] = { agent: "manual", at: new Date().toISOString() };
      saveSceneState(s.id, st);
      logChat(s.id, { role: "system", text: `Manual edit on disk saved as v${v}.` });
      makeVersionStills(s.id, v).then(() => emit("project", {}));
    }
  }
}

function scenePrompt(sb, sc, st, agent, pending, stills, note, latest) {
  const n = sb.scenes.indexOf(sc) + 1;
  const prev = sb.scenes[n - 2], next = sb.scenes[n];
  const head = `Scene ${n} of ${sb.scenes.length}, "${sc.id}" (${sc.title}). ${sc.duration}s long, at ${sc.start}–${(sc.start + sc.duration).toFixed(2)}s in the whole video. Transition in: ${sc.transitionIn ? sc.transitionIn.shader ?? "crossfade" : "none (first scene)"}.`;
  const intro = st.sessions[agent]
    ? ""
    : `You are the agent for one scene of a HyperFrames explainer video ("${sb.title}"${sb.language ? `, ${sb.language}` : ""}, ${sb.width}x${sb.height}). ${REVIEWER} reviews the video scene by scene in a review app and sends you feedback in batches. Each of your turns that changes files becomes a new version of this scene.

Rules:
- Your file is scene.html in this folder. It is a HyperFrames sub-composition: <template>, a root <div id="root" data-composition-id="${sc.id}">, and one paused GSAP timeline registered as window.__timelines["${sc.id}"]. The app inlines it into the whole video, so keep that structure. Keep data-duration="${sc.duration}"; the narration fixes it.
- Write only inside this folder. You may read anything in ${projectDir}: storyboard.json, assets/ (reference them as assets/...), frame.md (design rules) and transcript.json (word times in whole-video seconds; subtract ${sc.start} for scene time) if they exist, and the other scenes in scenes/ (read-only, for continuity at the cuts).
- No id or class may start with a digit.
${sc.narration ? `- Narration for this scene: "${sc.narration}"\n` : ""}- Previous scene: ${prev ? `scenes/${prev.id}/scene.html` : "none"}. Next scene: ${next ? `scenes/${next.id}/scene.html` : "none"}.
- Check your work before you reply: run \`${stillCmd()} --at <seconds,comma,separated>\` from this folder and look at the PNGs it prints.
- Reply in English, in 2–4 plain sentences: what you changed, and anything you could not do. ${REVIEWER} reads it in the chat panel.

`;
  const items = pending
    .map((c, i) => `${i + 1}. At ${c.t.toFixed(2)}s on v${c.version}${c.region ? " (the area is boxed in red on the still)" : ""}: "${c.text}"\n   Still: ${stills[c.id]}`)
    .join("\n");
  const versionNote = pending.some((c) => c.version !== latest) ? `\nThe scene on disk is v${latest}; some comments were made on an older version.` : "";
  return `${intro}${head}

Feedback from ${REVIEWER} (${pending.length} comment${pending.length === 1 ? "" : "s"}):
${items || "(no pinned comments)"}${note ? `\n\nNote: ${note}` : ""}${versionNote}
${agent === "claude" && pending.length ? "\nOpen the stills with Read before you start." : ""}`;
}

async function sendScene(id, { agent, note }) {
  if (running.has(id) || running.has("_project")) throw new Error(`${running.has(id) ? id : "The project session"} is already running`);
  await commitManualEdits();
  const sb = storyboard();
  const sc = sb.scenes.find((s) => s.id === id);
  const st = sceneState(id);
  agent = agent ?? st.agent;
  st.agent = agent;
  saveSceneState(id, st);
  const pending = st.comments.filter((c) => c.status === "pending");
  if (!pending.length && !note?.trim()) throw new Error("Nothing to send: add a comment or a note");
  const latest = (await history.versions(id)).at(-1).v;
  running.set(id, { agent, startedAt: Date.now() });
  emit("running", { key: id, agent, state: "start" });
  logChat(id, { role: "user", agent, text: [...pending.map((c) => `@${c.t.toFixed(2)}s v${c.version}: ${c.text}`), ...(note?.trim() ? [note.trim()] : [])].join("\n") });

  (async () => {
    const stills = {};
    try {
      for (const c of pending) stills[c.id] = await makeCommentStill(id, c);
    } catch (e) {
      logChat(id, { role: "system", text: `Could not make comment stills: ${e.message.slice(0, 200)}` });
    }
    const prompt = scenePrompt(sb, sc, st, agent, pending, stills, note?.trim(), latest);
    const sceneDir = join(projectDir, "scenes", id);
    const handle = runTurn({
      agent,
      cwd: sceneDir,
      prompt,
      sessionId: st.sessions[agent],
      readDir: projectDir,
      writeDir: sceneDir,
      images: Object.values(stills),
      bashAllow: [`node ${stillBin}`],
      onEvent: (ev) => logChat(id, { role: ev.kind === "text" ? "agent" : ev.kind, agent, text: ev.text.replaceAll(projectDir + "/", "") }),
    });
    running.get(id).handle = handle;
    const res = await handle.done;
    await finishTurn(id, agent, res, pending, latest, note?.trim());
  })().catch((e) => {
    logChat(id, { role: "system", text: `Turn failed: ${e.message}` });
    running.delete(id);
    emit("running", { key: id, state: "end" });
  });
}

async function finishTurn(id, agent, res, pending, latest, note) {
  const st = sceneState(id);
  if (res.sessionId) st.sessions[agent] = res.sessionId;
  const others = [...running.keys()].filter((k) => k !== id && k !== "_project").map((k) => `scenes/${k}/`);
  const outside = await history.revertOutside([`scenes/${id}/`, ...others]);
  if (outside.length) logChat(id, { role: "system", text: `Scope guard: undid changes outside the scene: ${outside.map((o) => o.path).join(", ")}` });
  const summary = pending[0]?.text ?? note ?? "note";
  const v = res.cancelled ? null : await history.commitScene(id, `${agent}: ${summary.slice(0, 60)}`, agent);
  for (const c of pending) if (res.ok || v) Object.assign(c, { status: "sent", sentAt: new Date().toISOString(), result: v ?? latest });
  st.comments = st.comments.map((c) => pending.find((p) => p.id === c.id) ?? c);
  if (v) st.versions[v] = { agent, ms: res.ms, comments: pending.map((c) => c.id), note, at: new Date().toISOString(), usage: res.usage };
  saveSceneState(id, st);
  metric({ kind: "scene-turn", scene: id, agent, ms: res.ms, ok: res.ok, cancelled: !!res.cancelled, comments: pending.length, fromVersion: latest, newVersion: v, outside: outside.map((o) => o.path) });
  logChat(id, { role: "system", text: res.cancelled ? "Stopped." : v ? `Saved as v${v} (${Math.round(res.ms / 1000)} s). Making stills…` : `No file changes (${Math.round(res.ms / 1000)} s).` });
  running.delete(id);
  emit("running", { key: id, state: "end", v });
  emit("project", {});
  if (v) await makeVersionStills(id, v);
  emit("project", {});
}

async function sendProject({ agent, text }) {
  if (running.size) throw new Error(`Wait for running scenes to finish: ${[...running.keys()].join(", ")}`);
  if (!text?.trim()) throw new Error("Empty message");
  await commitManualEdits();
  const ps = projectState();
  agent = agent ?? ps.agent;
  ps.agent = agent;
  saveProjectState(ps);
  const sb = storyboard();
  running.set("_project", { agent, startedAt: Date.now() });
  emit("running", { key: "_project", agent, state: "start" });
  logChat("_project", { role: "user", agent, text });
  const intro = ps.sessions[agent]
    ? ""
    : `You are the project agent for a HyperFrames explainer ("${sb.title}"${sb.language ? `, ${sb.language}` : ""}, ${sb.width}x${sb.height}) in a scene-by-scene review app. storyboard.json lists the scenes; each scene is scenes/<id>/scene.html (a sub-composition with a paused GSAP timeline registered as window.__timelines["<id>"]). Every scene you change becomes a new version of that scene. Keep each scene's data-duration (the narration fixes it). frame.md, if present, has the design rules. Check a scene with \`${stillCmd()} --at <seconds>\` run from its folder. Reply in English, in 2–4 plain sentences.\n\n`;
  (async () => {
    const handle = runTurn({
      agent, cwd: projectDir, prompt: intro + text.trim(), sessionId: ps.sessions[agent], readDir: projectDir, writeDir: projectDir,
      bashAllow: [`node ${stillBin}`],
      onEvent: (ev) => logChat("_project", { role: ev.kind === "text" ? "agent" : ev.kind, agent, text: ev.text.replaceAll(projectDir + "/", "") }),
    });
    running.get("_project").handle = handle;
    const res = await handle.done;
    const ps2 = projectState();
    if (res.sessionId) ps2.sessions[agent] = res.sessionId;
    saveProjectState(ps2);
    const made = [];
    for (const s of sb.scenes) {
      const v = await history.commitScene(s.id, `${agent} (project): ${text.trim().slice(0, 50)}`, agent);
      if (v) {
        const st = sceneState(s.id);
        st.versions[v] = { agent, project: true, ms: res.ms, at: new Date().toISOString() };
        saveSceneState(s.id, st);
        made.push([s.id, v]);
      }
    }
    metric({ kind: "project-turn", agent, ms: res.ms, ok: res.ok, versions: made });
    logChat("_project", { role: "system", text: made.length ? `New versions: ${made.map(([i, v]) => `${i} v${v}`).join(", ")} (${Math.round(res.ms / 1000)} s).` : `No scene changes (${Math.round(res.ms / 1000)} s).` });
    running.delete("_project");
    emit("running", { key: "_project", state: "end" });
    emit("project", {});
    for (const [i, v] of made) await makeVersionStills(i, v);
    emit("project", {});
  })().catch((e) => {
    logChat("_project", { role: "system", text: `Turn failed: ${e.message}` });
    running.delete("_project");
    emit("running", { key: "_project", state: "end" });
  });
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
    metric({ kind: "render", mode, ok, ms: Date.now() - started, picked });
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
      agent: st.agent,
      sessions: Object.keys(st.sessions),
      approved,
      running: running.get(s.id) ? { agent: running.get(s.id).agent, startedAt: running.get(s.id).startedAt } : null,
      comments: st.comments.map((c) => ({ ...c, still: existsSync(join(stateDir, "comments", s.id, `${c.id}.png`)) ? rel(join(stateDir, "comments", s.id, `${c.id}.png`)) : null })),
      versions: vs.map((x) => ({ ...x, ...(st.versions[x.v] ?? { agent: x.v === 1 ? "import" : "?" }), stills: listStills(s.id, x.v) })),
    });
  }
  const ps = projectState();
  return {
    title: sb.title, duration: sb.duration, soundtrack: sb.soundtrack, scenes,
    project: { agent: ps.agent, sessions: Object.keys(ps.sessions), running: running.get("_project") ? { agent: running.get("_project").agent, startedAt: running.get("_project").startedAt } : null },
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
  ["GET", /^\/api\/project$/, async () => projectView()],
  ["GET", /^\/api\/whoami$/, async () => ({ reviewer: REVIEWER })],
  // Browser-agent mode (WebMCP / window.sceneLoop): the chat agent next to the page reads
  // and writes scene.html itself; each write is a version, like a CLI agent's turn.
  ["GET", /^\/api\/scene\/([\w-]+)\/html$/, async (m, q) => {
    const v = q.get("v");
    return { id: m[1], version: v ? Number(v) : (await history.versions(m[1])).at(-1).v, html: v ? await history.fileAt(m[1], Number(v)) : readFileSync(join(projectDir, "scenes", m[1], "scene.html"), "utf8") };
  }],
  ["POST", /^\/api\/scene\/([\w-]+)\/html$/, async (m, q, b) => {
    const id = m[1];
    if (!storyboard().scenes.some((s) => s.id === id)) throw new Error(`${id} is not a scene`);
    if (running.has(id)) throw new Error(`${id} has a CLI agent running`);
    if (typeof b.html !== "string" || !b.html.includes(`data-composition-id="${id}"`)) throw new Error(`html must keep the root data-composition-id="${id}"`);
    writeFileSync(join(projectDir, "scenes", id, "scene.html"), b.html);
    const agent = b.agent || "browser agent";
    const st = sceneState(id);
    const pending = st.comments.filter((c) => c.status === "pending" && (!b.resolves || b.resolves.includes(c.id)));
    const v = await history.commitScene(id, `${agent}: ${(b.note || pending[0]?.text || "edit").slice(0, 60)}`, agent);
    if (v) {
      for (const c of pending) Object.assign(c, { status: "sent", sentAt: new Date().toISOString(), result: v });
      st.versions[v] = { agent, comments: pending.map((c) => c.id), note: b.note, at: new Date().toISOString() };
      saveSceneState(id, st);
      logChat(id, { role: "system", text: `${agent} saved v${v}${b.note ? `: ${b.note}` : ""}.` });
      metric({ kind: "browser-agent-write", scene: id, agent, newVersion: v, comments: pending.length });
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
    return { stills: await snapshot(build, b.times?.length ? b.times : versionTimes(sc.duration), out) };
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
  ["POST", /^\/api\/scene\/([\w-]+)\/agent$/, async (m, q, b) => {
    const st = sceneState(m[1]);
    st.agent = b.agent === "codex" ? "codex" : "claude";
    saveSceneState(m[1], st);
    return { ok: true };
  }],
  ["POST", /^\/api\/scene\/([\w-]+)\/send$/, async (m, q, b) => (await sendScene(m[1], b), { ok: true })],
  ["POST", /^\/api\/scene\/([\w-]+)\/stop$/, async (m) => (running.get(m[1])?.handle?.cancel(), { ok: true })],
  ["POST", /^\/api\/scene\/([\w-]+)\/approve$/, async (m, q, b) => {
    await history.approve(m[1], b.v);
    logChat(m[1], { role: "system", text: `Approved v${b.v}.` });
    metric({ kind: "approve", scene: m[1], v: b.v });
    emit("project", {});
    return { ok: true };
  }],
  ["POST", /^\/api\/scene\/([\w-]+)\/restore$/, async (m, q, b) => {
    if (running.has(m[1])) throw new Error("Scene agent is running");
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
  ["POST", /^\/api\/project\/agent$/, async (m, q, b) => {
    const ps = projectState();
    ps.agent = b.agent === "codex" ? "codex" : "claude";
    saveProjectState(ps);
    return { ok: true };
  }],
  ["POST", /^\/api\/project\/send$/, async (m, q, b) => (await sendProject(b), { ok: true })],
  ["POST", /^\/api\/project\/stop$/, async () => (running.get("_project")?.handle?.cancel(), { ok: true })],
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
