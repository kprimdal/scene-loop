#!/usr/bin/env node
// Scene loop: a local review app over HTML video scenes, in Caleb Porzio's shape.
// The agent is Claude (or another chat) on the user's own plan, connected over MCP at
// /mcp or through the page's tools. This server holds the projects, versions, comments,
// stills, previews and renders. It never calls a model and holds no keys.
//
//   node server.mjs <dir> [--port 4300] [--host 127.0.0.1] [--reviewer Name] [--password ...]
//   <dir> is a projects root: one folder per project, each with project.md and
//   videos/<video>/ (create_project, create_video). A <dir> with a storyboard.json is one
//   video, and a root whose folders have one is one video per project; both still work.
//   A --host beyond loopback needs a login (SCENE_LOOP_PASSWORD); see lib/auth.mjs.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "./lib/projects.mjs";
import { toolList, callTool, withoutFiles } from "./lib/tools.mjs";
import { createMcp } from "./lib/mcp.mjs";
import { createAuth } from "./lib/auth.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.2.0";
const args = process.argv.slice(2);
const PORT = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 0) || 4300;
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const BOOLEAN_FLAGS = ["--no-login"];
const rootArg = resolve(args.find((a, i) => !a.startsWith("--") && !(args[i - 1]?.startsWith("--") && !BOOLEAN_FLAGS.includes(args[i - 1]))) ?? process.cwd());
const REVIEWER = flag("--reviewer") ?? process.env.SCENE_LOOP_REVIEWER ?? "The reviewer";
const HOST = flag("--host") ?? process.env.SCENE_LOOP_HOST ?? "127.0.0.1";
if (!existsSync(rootArg) || !statSync(rootArg).isDirectory()) {
  console.error(`${rootArg} is not a directory. Usage: node server.mjs <projectDir|projectsRoot> [--port 4300] [--host 127.0.0.1] [--reviewer Name]`);
  process.exit(1);
}

// ---------- live events (SSE) ----------
const clients = new Set();
function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

let auth;
try {
  auth = createAuth({
    password: flag("--password") ?? process.env.SCENE_LOOP_PASSWORD,
    token: process.env.SCENE_LOOP_TOKEN,
    secret: process.env.SCENE_LOOP_SECRET,
    publicUrl: flag("--url") ?? process.env.SCENE_LOOP_URL,
    host: HOST,
    noLogin: args.includes("--no-login"),
  });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const registry = createRegistry(rootArg, { reviewer: REVIEWER, emit });

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

const body = (req) => new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b ? JSON.parse(b) : {})); });

function inside(root, p) {
  const f = normalize(join(root, decodeURIComponent(p)));
  return f.startsWith(root) ? f : null;
}

// UI routes. Each gets (match, query, body, ctx); ctx.p() is the video from ?project= and
// ?video= (or the only one). The page's agent tools go through /api/tools instead.
const routes = [
  ["GET", /^\/api\/projects$/, async () => ({ projects: await registry.list(), single: registry.single, root: registry.root })],
  ["GET", /^\/api\/whoami$/, async () => ({ reviewer: REVIEWER })],
  ["GET", /^\/api\/tools$/, async () => toolList()],
  ["POST", /^\/api\/tools\/([\w-]+)$/, async (m, q, b, ctx) => withoutFiles(await callTool(m[1], b.args ?? {}, { registry, via: ["webmcp", "page-js"].includes(b.via) ? b.via : "api", origin: ctx.origin, defaults: { project: ctx.projectName, video: ctx.videoName } }))],
  ["GET", /^\/api\/project$/, async (m, q, b, ctx) => (q.get("sync") ? await ctx.p().then((p) => p.commitManualEdits()) : null, (await ctx.p()).view())],
  ["GET", /^\/api\/chat\/([\w-]+)$/, async (m, q, b, ctx) => (await ctx.p()).chat(m[1])],
  ["GET", /^\/api\/build\/scene\/([\w-]+)$/, async (m, q, b, ctx) => (await ctx.p()).sceneBuildUrl(m[1], q.get("v"))],
  ["GET", /^\/api\/build\/whole$/, async (m, q, b, ctx) => (await ctx.p()).wholeBuildUrl()],
  ["POST", /^\/api\/scene\/([\w-]+)\/comments$/, async (m, q, b, ctx) => (await ctx.p()).addComment(m[1], b)],
  ["DELETE", /^\/api\/scene\/([\w-]+)\/comments\/(\w+)$/, async (m, q, b, ctx) => (await ctx.p()).deleteComment(m[1], m[2])],
  ["POST", /^\/api\/scene\/([\w-]+)\/restore$/, async (m, q, b, ctx) => (await ctx.p()).restore(m[1], b.v)],
  ["POST", /^\/api\/render$/, async (m, q, b, ctx) => (await ctx.p()).render()],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const origin = auth.baseUrl(req);
  try {
    if (await auth.gate(req, res)) return;
    if (url.pathname === "/mcp") return await mcp(req, res, { origin });
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": hi\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const projectName = url.searchParams.get("project") || null;
    const videoName = url.searchParams.get("video") || null;
    const ctx = { origin, projectName, videoName, p: () => registry.resolve(projectName, videoName) };
    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return send(res, 200, await fn(m, url.searchParams, req.method === "GET" ? {} : await body(req), ctx));
    }
    // /p/<project>/<video>/... video files (builds, stills, assets); /renders/<project>/<video>/<file> renders
    const pm = url.pathname.match(/^\/(p|renders)\/([^/]+)\/([^/]+)\/(.*)$/);
    if (pm) {
      const d = registry.dirOfVideo(decodeURIComponent(pm[2]), decodeURIComponent(pm[3]));
      const f = inside(pm[1] === "p" ? d : join(d, "renders"), pm[4]);
      return f ? serveFile(req, res, f) : send(res, 403, {});
    }
    const f = inside(join(appDir, "public"), url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    return f ? serveFile(req, res, f) : send(res, 403, {});
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, async () => {
  const names = registry.names();
  const videos = names.flatMap((n) => registry.videoNames(n).map((v) => [n, v]));
  const shown = `http://${["0.0.0.0", "::", "127.0.0.1"].includes(HOST) ? "localhost" : HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`;
  console.log(`scene-loop ${VERSION} on ${shown}${HOST === "127.0.0.1" ? "" : ` (listening on ${HOST})`}  (${registry.single ? `one video in ${rootArg}` : `${names.length} project(s), ${videos.length} video(s) in ${rootArg}`})`);
  console.log(auth.enabled ? `Login on. MCP needs a bearer token or the OAuth flow; see docs/self-host.md.` : `MCP: claude mcp add --transport http scene-loop ${shown}/mcp`);
  if (auth.generated) console.log("No SCENE_LOOP_SECRET set: sessions and tokens end when the server restarts.");
  for (const [n, v] of videos) registry.get(n, v).catch((e) => console.error(`${n}/${v}: ${e.message}`)); // opens and warms posters in the background
});
