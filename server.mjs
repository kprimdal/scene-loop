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
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
    "Projects hold videos. Call get_rules first: the project's instructions (how names are pronounced, voice, tone) come first and hold for every script and voiceover, then the video's rules and the scene contract. " +
    "Use list_projects to see projects and their videos; pass `project` and `video` when there is more than one. " +
    "After write_scene_html, call get_stills to see the frames. Comments from the reviewer come through get_pending_comments with a still each; pass their ids in resolves when you apply them. " +
    "Pass your model name in `model` on writes. render starts a job; poll get_render.",
});

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm" };

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
  ["DELETE", /^\/api\/scene\/([\w-]+)\/comments\/(\w+)$/, async (m, q, b, ctx) => (await ctx.p()).deleteComment(m[1], m[2], ctx.guest ? { id: ctx.user.id, name: ctx.user.name } : null), "guest"],
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
    const f = inside(pm[1] === "p" ? d : join(d, "renders"), pm[4]);
    return f ? serveFile(req, res, f) : send(res, 403, {});
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
  if (auth.enabled()) console.log(`Login on (${people.list().filter((p) => p.email).length} people). MCP needs a bearer token or the OAuth flow; see docs/self-host.md.`);
  else console.log(`MCP: claude mcp add --transport http scene-loop ${shown}/mcp`);
  if (args.includes("--no-login") && people.loginsOn()) console.warn("--no-login is ignored: there are people on the list, so everyone logs in.");
  if ((env.SCENE_LOOP_PASSWORD || flag("--password")) && people.hasActiveOwner()) console.warn("SCENE_LOOP_PASSWORD no longer logs anyone in: an owner has an account. Take it out.");
  if (auth.enabled() && auth.generated) console.log("No SCENE_LOOP_SECRET set and no people file: sessions and tokens end when the server restarts.");
  for (const [n, v] of videos) registry.get(n, v).catch((e) => console.error(`${n}/${v}: ${e.message}`)); // opens and warms posters in the background
});
