#!/usr/bin/env node
// Scene loop: a local review app over HTML video scenes, in Caleb Porzio's shape.
// The agent is Claude (or another chat) on the user's own plan, connected over MCP at
// /mcp or through the page's tools. This server holds the projects, versions, comments,
// stills, previews and renders. It never calls a model and holds no keys.
//
//   node server.mjs <dir> [--port 4300] [--host 127.0.0.1] [--reviewer Name] [--password ...]
//   node server.mjs <dir> --invite-owner email Name [--url https://...]
//   <dir> is a projects root: one folder per project, each with project.md and
//   videos/<video>/ (create_project, create_video). A <dir> with a storyboard.json is one
//   video, and a root whose folders have one is one video per project; both still work.
//   The people who may log in are in <dir>/.people.json (lib/people.mjs, managed on /people);
//   --invite-owner adds the first owner and prints their invite link. See lib/auth.mjs.
import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, realpathSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, extname, join, resolve, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMotion, motionExample } from "./lib/motion.mjs";
import { inspectPattern, patternExample } from "./lib/patterns.mjs";
import { inspectStyle, styleExample } from "./lib/styles.mjs";
import { examplePage, demoPage } from "./lib/assemble.mjs";
import { getCard, setLibraryDir, libraryDir, loadLibrary, demoFile } from "./lib/cards.mjs";
import { serveReferenceMedia, readReferenceUpload, MAX_REFERENCE_BYTES } from "./lib/references.mjs";
import { createRegistry } from "./lib/projects.mjs";
import { toolList, callTool, withoutFiles } from "./lib/tools.mjs";
import { createMcp } from "./lib/mcp.mjs";
import { createAuth } from "./lib/auth.mjs";
import { createPeople } from "./lib/people.mjs";
import { createAdmin } from "./lib/admin.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.3.0";
const args = process.argv.slice(2);
const PORT = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 0) || 4300;
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const BOOLEAN_FLAGS = ["--no-login"];
const TWO_VALUE_FLAGS = ["--invite-owner"];
const takesValue = (i) => args[i - 1]?.startsWith("--") && !BOOLEAN_FLAGS.includes(args[i - 1]) || TWO_VALUE_FLAGS.includes(args[i - 2]);
const rootArg = resolve(args.find((a, i) => !a.startsWith("--") && !takesValue(i)) ?? process.cwd());
const REVIEWER = flag("--reviewer") ?? process.env.SCENE_LOOP_REVIEWER ?? "The reviewer";
const HOST = flag("--host") ?? process.env.SCENE_LOOP_HOST ?? "127.0.0.1";
const PUBLIC_URL = flag("--url") ?? process.env.SCENE_LOOP_URL;
// --library <dir>: the Library folder (cards, formats, sources, demos). Without it, the starter
// library in this repository. SCENE_LOOP_LIBRARY does the same.
if (flag("--library")) setLibraryDir(flag("--library"));
if (!existsSync(rootArg) || !statSync(rootArg).isDirectory()) {
  console.error(`${rootArg} is not a directory. Usage: node server.mjs <projectDir|projectsRoot> [--port 4300] [--host 127.0.0.1] [--reviewer Name]`);
  process.exit(1);
}

const people = createPeople(join(rootArg, ".people.json"));
const env = process.env;

// --invite-owner email Name: add an owner (or make the person with that email one) and print a
// fresh invite link. A running server picks the change up from the file.
if (args.includes("--invite-owner")) {
  const i = args.indexOf("--invite-owner");
  const [email, name] = [args[i + 1], args[i + 2]];
  try {
    if (!email?.includes("@") || !name || name.startsWith("--")) throw new Error("Usage: node server.mjs <dir> --invite-owner email Name [--url https://your.host]");
    const had = people.byEmail(email);
    if (had && had.role !== "owner") people.update(had.id, { role: "owner" });
    const invite = had ? people.invite(had.id) : people.add({ name, email, role: "owner" }).invite;
    const base = (PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
    console.log(`${had ? `${had.name} is an owner; new` : `Added ${name} <${email}> as an owner.`} Invite link, valid 7 days, works once:\n${base}/invite/${invite}`);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

// The older settings move into the people file once, the first time there is none.
try {
  if (!people.exists() && (env.SCENE_LOOP_TOKENS || env.SCENE_LOOP_SHARE_PEOPLE)) {
    const moved = people.importLegacy({ tokens: env.SCENE_LOOP_TOKENS, sharePeople: env.SCENE_LOOP_SHARE_PEOPLE, shareProjects: env.SCENE_LOOP_SHARE_PROJECTS });
    console.log(`Moved ${moved.length} people from SCENE_LOOP_TOKENS / SCENE_LOOP_SHARE_PEOPLE into ${people.file}: ${moved.map((p) => `${p.name} (${p.role}${p.email ? `, ${p.email}` : ""}${p.tokens ? `, ${p.tokens} token${p.tokens > 1 ? "s" : ""}` : ""})`).join(", ")}. Send them invite links from /people, and take those settings out.`);
  } else if (env.SCENE_LOOP_TOKENS || env.SCENE_LOOP_SHARE_PEOPLE || env.SCENE_LOOP_SHARE_PROJECTS) {
    console.warn(`SCENE_LOOP_TOKENS and SCENE_LOOP_SHARE_PEOPLE/PROJECTS are ignored: people and their tokens live in ${people.file} now (/people). Take them out.`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (env.SCENE_LOOP_SHARE_PORT) console.warn("SCENE_LOOP_SHARE_PORT is gone: there is no second listener. People log in on the main one; point the tunnel at it.");

// ---------- live events (SSE) ----------
// res -> { only: the projects it may hear about (null: all), id, gen, boot }. A comment line
// every 25 s keeps the stream open through proxies that drop idle connections (Cloudflare
// does after 100 s).
const clients = new Map();
function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [c, { only }] of clients) if (!only || only.has(data?.project)) c.write(msg);
}
setInterval(() => { for (const c of clients.keys()) c.write(": ping\n\n"); }, 25_000).unref();

let auth;
try {
  auth = createAuth({
    password: flag("--password") ?? env.SCENE_LOOP_PASSWORD,
    token: env.SCENE_LOOP_TOKEN,
    secret: env.SCENE_LOOP_SECRET,
    publicUrl: PUBLIC_URL,
    host: HOST,
    noLogin: args.includes("--no-login"),
    people,
    trustProxy: env.SCENE_LOOP_TRUST_PROXY,
    reviewer: REVIEWER,
  });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// Someone removed, logged out or given fewer projects: their open streams close or narrow
// at once. The file is also read again every few seconds for changes made outside.
function recheckStreams() {
  for (const [res, c] of clients) {
    if (c.boot) { if (!(env.SCENE_LOOP_PASSWORD || flag("--password")) || people.hasActiveOwner()) res.end(); continue; }
    if (!c.id) continue;
    const p = people.get(c.id);
    if (!p || p.gen !== c.gen) res.end();
    else if (c.only) c.only = people.projectsOf(p) ?? c.only;
  }
}
people.onChange(recheckStreams);
setInterval(people.reload, 5000).unref();

const registry = createRegistry(rootArg, { reviewer: REVIEWER, emit });
const admin = createAdmin({ people, auth, registry, onRemoved: recheckStreams });

const mcp = createMcp({
  registry,
  serverInfo: { name: "scene-loop", version: VERSION },
  instructions:
    "scene-loop makes videos scene by scene. Scenes are HTML files; every write becomes a version with stills, and a reviewer pins comments on frames in the web UI. " +
    "Projects hold videos. Call get_rules first: the project's instructions (how names are pronounced, voice, tone) come first and hold for every script and voiceover, then the video's format, its attached Library cards, the video's rules and the scene contract. " +
    "The Library (list_cards, get_card, list_formats) holds techniques for making a video good, each with when to use it and a prompt, and the styles, motion, transitions and patterns scene-loop can apply. " +
    "Use list_projects to see projects and their videos; pass `project` and `video` when there is more than one. " +
    "After write_scene_html, call get_stills to see the frames (sheet: true for the whole scene in one picture) and fix what its layoutWarnings name. Comments from the reviewer come through get_pending_comments with a still each; pass their ids in resolves when you apply them. " +
    "Pass your model name in `model` on writes. render starts a job; poll get_render.",
});

// ---------- http ----------
const MIME = { ".ogg": "audio/ogg", ".flac": "audio/flac", ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".webp": "image/webp", ".gif": "image/gif", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm" };

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

// A JSON body, at most max bytes. The page's tools may carry base64 audio, so they get more.
const body = (req, max = 65536) =>
  new Promise((ok, fail) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
      if (b.length > max) { fail(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } });
    req.on("error", fail);
  });

// The file under root that p names, or null when it would leave root (or is the people file).
function inside(root, p) {
  const f = normalize(join(root, decodeURIComponent(p)));
  if (f !== root && !f.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return f.startsWith(people.file) ? null : f;
}

// A commenter's comments: 60 a minute is more than a person writes.
const commentTimes = new Map();
function commentLimit(user) {
  const t = Date.now(), list = (commentTimes.get(user.id) ?? []).filter((x) => x > t - 60_000);
  if (list.length >= 60) throw new Error("That is a lot of comments in a minute. Wait a moment.");
  commentTimes.set(user.id, [...list, t]);
}

// UI routes. Each gets (match, query, body, ctx); ctx.p() is the video from ?project= and
// ?video= (or the only one), ctx.user the person asking, ctx.guest the same when they are a
// commenter (null for an owner). The page's agent tools go through /api/tools instead. Routes
// marked "guest" are the only ones a commenter reaches.
const routes = [
  ["GET", /^\/api\/projects$/, async (m, q, b, ctx) => (ctx.guest
    ? { projects: (await registry.list()).filter((p) => ctx.allows(p.name)).map(({ dir, ...p }) => p), single: false, root: null }
    : { projects: await registry.list(), single: registry.single, root: registry.root }), "guest"],
  ["DELETE", /^\/api\/videos\/([^/]+)\/([^/]+)$/, async (m) => registry.deleteVideo(decodeURIComponent(m[1]), decodeURIComponent(m[2]))],
  ["GET", /^\/api\/whoami$/, async (m, q, b, { user }) => ({ reviewer: user.name, guest: !user.owner, owner: user.owner, account: !user.boot, email: user.email ?? null, login: auth.enabled() }), "guest"],
  ["GET", /^\/api\/tools$/, async (m, q, b, ctx) => (ctx.guest ? [] : toolList()), "guest"],
  ["POST", /^\/api\/tools\/([\w-]+)$/, async (m, q, b, ctx) => withoutFiles(await callTool(m[1], b.args ?? {}, { registry, via: ["webmcp", "page-js"].includes(b.via) ? b.via : "api", origin: ctx.origin, defaults: { project: ctx.projectName, video: ctx.videoName } }))],
  ["GET", /^\/api\/project$/, async (m, q, b, ctx) => (q.get("sync") ? await ctx.p().then((p) => p.commitManualEdits()) : null, (await ctx.p()).view()), "guest"],
  ["GET", /^\/api\/chat\/([\w-]+)$/, async (m, q, b, ctx) => (await ctx.p()).chat(m[1]), "guest"],
  ["GET", /^\/api\/build\/scene\/([\w-]+)$/, async (m, q, b, ctx) => (await ctx.p()).sceneBuildUrl(m[1], q.get("v")), "guest"],
  ["GET", /^\/api\/build\/whole$/, async (m, q, b, ctx) => (await ctx.p()).wholeBuildUrl(), "guest"],
  ["POST", /^\/api\/scene\/([\w-]+)\/comments$/, async (m, q, b, { user, guest, p }) => (guest && commentLimit(user), (await p()).addComment(m[1], b, user.name, user.id)), "guest"],
  // A commenter removes only their own comments.
  ["DELETE", /^\/api\/scene\/([\w-]+)\/comments\/(\w+)$/, async (m, q, b, ctx) => (await ctx.p()).deleteComment(m[1], m[2], ctx.guest ? { id: ctx.user.id } : null), "guest"],
  ["POST", /^\/api\/scene\/([\w-]+)\/restore$/, async (m, q, b, ctx) => (await ctx.p()).restore(m[1], b.v)],
  ["POST", /^\/api\/render$/, async (m, q, b, ctx) => (await ctx.p()).render()],
];

// One handler for every request after the gate. An owner reaches everything; a commenter only
// "guest" routes and the files, events and listings of the projects they were given.
async function handle(req, res, user) {
  const url = new URL(req.url, "http://x");
  const origin = auth.baseUrl(req);
  const guest = user.owner ? null : user;
  const allows = (name) => !guest || guest.projects.has(name);
  if (url.pathname === "/mcp") return guest ? send(res, 404, { error: "not found" }) : await mcp(req, res, { origin });
  if (await admin(req, res, url.pathname, user)) return;
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": hi\n\n");
    clients.set(res, { only: guest ? new Set(guest.projects) : null, id: user.id, gen: user.gen, boot: user.boot && req.auth?.kind === "session" });
    req.on("close", () => clients.delete(res));
    return;
  }
  let projectName = url.searchParams.get("project") || null;
  const videoName = url.searchParams.get("video") || null;
  if (guest) {
    if (!projectName && guest.projects.size === 1) projectName = [...guest.projects][0];
    if (projectName && !allows(projectName)) {
      if (url.pathname !== "/") return send(res, 404, { error: "not found" });
      res.writeHead(302, { Location: "/" }); // a link to a project they don't have: their own
      return res.end();
    }
  }
  const ctx = { origin, user, guest, allows, projectName, videoName, p: () => (guest && !projectName ? Promise.reject(new Error("pass project")) : registry.resolve(projectName, videoName)) };
  // A take from the Record view: the recording itself as the body, video/mp4 or video/webm
  // (a type no form or simple cross-site request can send, like the JSON the other writes want).
  // References are owner-only, including metadata and media, within one explicit project.
  if (url.pathname === '/api/references/upload' && req.method === 'POST') {
    if (guest) return send(res,403,{error:'References are private to project owners.'});
    const project=url.searchParams.get('project');
    if (!project) return send(res,400,{error:'Name the project explicitly.'});
    if (Number(req.headers['content-length'])>MAX_REFERENCE_BYTES+96001) {req.resume();return send(res,413,{error:'Reference upload limit is 100 MiB.'});}
    if(req.headers['content-type']!=='application/x-scene-loop-reference') return send(res,415,{error:'Send application/x-scene-loop-reference: a JSON header line, then media bytes.'});
    const {metadata,mime,stream}=await readReferenceUpload(req);
    return send(res,200,await registry.references.change(project,'create',metadata,{stream,mime}));
  }
  const referenceMedia=url.pathname.match(/^\/api\/references\/([^/]+)\/media\/([^/]+)$/);
  if(referenceMedia && ['GET','HEAD'].includes(req.method)) {
    if(guest)return send(res,404,{error:'not found'});
    res.setHeader('Cache-Control','private, no-store');
    try {return serveReferenceMedia(req,res,registry.references.mediaFile(decodeURIComponent(referenceMedia[1]),decodeURIComponent(referenceMedia[2])));}
    catch {return send(res,404,{error:'not found'});}
  }
  const take = url.pathname.match(/^\/api\/takes\/([\w-]+)$/);
  if (take && req.method === "POST") {
    if (guest) return send(res, 403, { error: "Your account can watch and comment only." });
    const type = req.headers["content-type"] ?? "";
    if (!/^(video|audio)\/(mp4|webm)\b/.test(type)) return send(res, 415, { error: "send the recording as video/mp4 or video/webm" });
    // The camera and microphone it was recorded with, by their labels (which of three mics was it?).
    const devices = { camera: url.searchParams.get("camera")?.slice(0, 200) || null, mic: url.searchParams.get("mic")?.slice(0, 200) || null };
    return send(res, 200, await (await ctx.p()).addTake(take[1], { stream: req, mime: type, model: user.name, devices }));
  }
  // A card's moving example: its demo scene from the library, or the example its
  // implementation makes (style, motion, transition, pattern). Owners only, like the Library.
  const cardPreview = url.pathname.match(/^\/api\/cards\/([a-z0-9-]+)\/preview$/);
  if (cardPreview && req.method === "GET") {
    if (guest) return send(res, 403, { error: "Your account can watch and comment only." });
    let c;
    try { c = getCard(cardPreview[1]); } catch (e) { return send(res, 404, { error: e.message }); }
    if (url.searchParams.has("contentHash") && url.searchParams.get("contentHash") !== c.contentHash) return send(res, 409, { error: "This card changed. Refresh the Library." });
    let html;
    if (c.demo) html = demoPage(readFileSync(demoFile(c), "utf8"), `/api/cards/${c.id}/files/`);
    else if (c.kind === "style") html = examplePage(styleExample(inspectStyle(c.id)));
    else if (c.kind === "pattern") html = examplePage(patternExample(inspectPattern(c.id)));
    else if (c.kind === "motion" || c.kind === "transition") { const p = inspectMotion(c.id); html = examplePage(motionExample(p), p.kind === "transition" ? { type: p.id, duration: p.duration } : null); }
    else return send(res, 404, { error: `${c.title} has no demo yet.` });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(html);
  }
  // The files next to a demo (images, clips), for its preview page.
  const cardFile = url.pathname.match(/^\/api\/cards\/([a-z0-9-]+)\/files\/(.+)$/);
  if (cardFile && req.method === "GET") {
    if (guest) return send(res, 404, { error: "not found" });
    let f = null;
    try { f = demoFile(getCard(cardFile[1]), decodeURIComponent(cardFile[2])); } catch {}
    return f ? serveFile(req, res, f) : send(res, 404, { error: "not found" });
  }
  // A project's brand files (lib/brand.mjs), for its page. Owners only, like project.md;
  // scenes reach the same files as assets/brand/... under /p/.
  const brandUrl = url.pathname.match(/^\/brand\/([^/]+)\/(.+)$/);
  if (brandUrl && req.method === "GET") {
    let f = null;
    try { f = guest ? null : registry.brandPath(decodeURIComponent(brandUrl[1]), decodeURIComponent(brandUrl[2])); } catch {}
    return f ? serveFile(req, res, f) : send(res, 404, { error: "not found" });
  }
  // The shared library (lib/library.mjs) is for owners: it spans every project.
  const lib = url.pathname.match(/^\/library\/([a-z]+)\/([^/]+)$/);
  if (lib && req.method === "GET") {
    const f = guest ? null : registry.library.file(lib[1], decodeURIComponent(lib[2]));
    return f ? serveFile(req, res, f) : send(res, 404, { error: "not found" });
  }
  // A file for the library from the page: the file itself as the body, typed audio/* (like a
  // take, a type no form can send cross-site), its metadata as JSON in ?meta=.
  if (url.pathname === "/api/library/upload" && req.method === "POST") {
    if (guest) return send(res, 403, { error: "Your account can watch and comment only." });
    const type = req.headers["content-type"] ?? "";
    const ext = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a", "audio/ogg": "ogg", "audio/flac": "flac", "audio/x-flac": "flac" }[type.split(";")[0].trim()];
    if (!ext) return send(res, 415, { error: "send the file as audio/mpeg, audio/wav, audio/mp4, audio/ogg or audio/flac" });
    if (Number(req.headers["content-length"]) > 500 * 1024 * 1024) return send(res, 413, { error: "at most 500 MB" });
    let meta;
    try { meta = JSON.parse(url.searchParams.get("meta") || "{}"); } catch { return send(res, 400, { error: "meta must be JSON" }); }
    const dir = join(registry.library.dir, "music");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.upload-${process.pid}-${Date.now()}.${ext}`);
    try {
      let n = 0;
      req.on("data", (d) => { if ((n += d.length) > 500 * 1024 * 1024) req.destroy(new Error("at most 500 MB")); });
      await pipeline(req, createWriteStream(tmp));
      const { path, base64, ...fields } = meta;
      return send(res, 200, await registry.library.add({ ...fields, kind: "music", path: tmp, ext, name: url.searchParams.get("name") }, { by: user.name, upload: true }));
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  for (const [method, re, fn, open] of routes) {
    const m = url.pathname.match(re);
    if (m && req.method === method) {
      if (guest && open !== "guest") return send(res, 403, { error: "Your account can watch and comment only." });
      // The page always sends JSON; a form or a text/plain post from elsewhere does not get in.
      if (req.method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json")) return send(res, 415, { error: "send JSON" });
      const b = req.method === "GET" ? {} : await body(req, url.pathname.startsWith("/api/tools/") ? 200 * 1024 * 1024 : 65536);
      return send(res, 200, await fn(m, url.searchParams, b, ctx));
    }
  }
  // /p/<project>/<video>/... video files (builds, stills, assets); /renders/<project>/<video>/<file> renders
  const pm = url.pathname.match(/^\/(p|renders)\/([^/]+)\/([^/]+)\/(.*)$/);
  if (pm) {
    if (!allows(decodeURIComponent(pm[2]))) return send(res, 404, { error: "not found" });
    const d = registry.dirOfVideo(decodeURIComponent(pm[2]), decodeURIComponent(pm[3]));
    const top = pm[1] === "p" ? d : join(d, "renders");
    const f = inside(top, pm[4]);
    if (!f) return send(res, 403, {});
    // Nobody gets the version history over HTTP. A commenter gets only what the page shows
    // them: the builds (which link assets/ and scenes/), stills, comment stills and assets/;
    // not project.md, AGENTS.md, the storyboard or the app's state.
    const parts = f.slice(top.length + 1).split(sep);
    // Trusted project/video roots may themselves be aliases. Inspect resolved components
    // below that boundary, including links from assets/builds into private storage.
    const actualParts = existsSync(f) ? relative(realpathSync(top), realpathSync(f)).split(sep) : [];
    if (parts.includes('.references') || parts.includes('references.json') || actualParts.includes('.references') || actualParts.includes('references.json')) return send(res,404,{error:'not found'});
    if (parts.includes(".history") || actualParts.includes('.history')) return send(res, 404, { error: "not found" });
    const shown = pm[1] === "renders" || ["assets", ".build"].includes(parts[0]) || (parts[0] === ".state" && ["stills", "comments"].includes(parts[1]));
    if (guest && !shown) return send(res, 404, { error: "not found" });
    return serveFile(req, res, f);
  }
  const f = inside(join(appDir, "public"), url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  return f ? serveFile(req, res, f) : send(res, 403, {});
}

const server = createServer(async (req, res) => {
  try {
    if (await auth.gate(req, res)) return;
    await handle(req, res, req.user);
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, async () => {
  const names = registry.names();
  const videos = names.flatMap((n) => registry.videoNames(n).map((v) => [n, v]));
  const shown = `http://${["0.0.0.0", "::", "127.0.0.1"].includes(HOST) ? "localhost" : HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`;
  console.log(`scene-loop ${VERSION} on ${shown}${HOST === "127.0.0.1" ? "" : ` (listening on ${HOST})`}  (${registry.single ? `one video in ${rootArg}` : `${names.length} project(s), ${videos.length} video(s) in ${rootArg}`})`);
  const library = loadLibrary();
  console.log(`Library: ${library.title}, ${library.cards.length} cards, ${library.formats.length} formats, ${library.sources.length} sources (${libraryDir()})`);
  for (const e of library.errors) console.warn(`Library: ${e.file} left out: ${e.problems.join("; ")}`);
  if (auth.enabled()) console.log(`Login on (${people.list().filter((p) => p.email).length} people). MCP needs a bearer token or the OAuth flow; see docs/self-host.md.`);
  else console.log(`MCP: claude mcp add --transport http scene-loop ${shown}/mcp`);
  if (args.includes("--no-login") && people.loginsOn()) console.warn("--no-login is ignored: there are people on the list, so everyone logs in.");
  if ((env.SCENE_LOOP_PASSWORD || flag("--password")) && people.hasActiveOwner()) console.warn("SCENE_LOOP_PASSWORD no longer logs anyone in: an owner has an account. Take it out.");
  if (auth.enabled() && auth.generated) console.log("No SCENE_LOOP_SECRET set and no people file: sessions and tokens end when the server restarts.");
  for (const [n, v] of videos) registry.get(n, v).catch((e) => console.error(`${n}/${v}: ${e.message}`)); // opens and warms posters in the background
});
