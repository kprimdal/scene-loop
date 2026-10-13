#!/usr/bin/env node
// A render worker: renders scene clips for a scene-loop server on another machine, so a
// faster computer can take the frames when it is awake. The server finds it through
// SCENE_LOOP_WORKERS, copies the files the scenes use into a mirror here, and sends one
// assembled scene page per clip; the clip comes back as an mp4. Same Chrome and ffmpeg
// code as the server (lib/render.mjs). See lib/remote.mjs for the server side.
//
//   SCENE_LOOP_TOKEN=... node worker.mjs [--port 4310] [--host 0.0.0.0] [--dir ~/.cache/scene-loop/worker]
//
// Routes, all behind the bearer token except /health:
//   GET  /health                 { ok, version, parallel, active, platform, chrome }
//   POST /sync/<key>             { files: [{ path, size, mtime }] } -> { missing: [path] }
//   PUT  /file/<key>?path=...    the file's bytes; size and mtime in the query
//   POST /clip/<key>             { html, duration, start, fps, width, height } -> NDJSON
//                                lines { frames } while it renders, then { ok, id } or { error }
//   GET  /out/<id>               the finished mp4, deleted once sent
import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join, normalize, resolve } from "node:path";
import { homedir, platform, arch } from "node:os";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { renderClip, PARALLEL } from "./lib/render.mjs";
import { findChrome } from "./lib/chrome.mjs";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const PORT = Number(flag("--port")) || 4310;
const HOST = flag("--host") ?? process.env.SCENE_LOOP_WORKER_HOST ?? "0.0.0.0";
const ROOT = resolve(flag("--dir") ?? process.env.SCENE_LOOP_WORKER_DIR ?? join(homedir(), ".cache", "scene-loop", "worker"));
const TOKEN = process.env.SCENE_LOOP_WORKER_TOKEN ?? process.env.SCENE_LOOP_TOKEN ?? null;
const VERSION = createHash("sha1").update(readFileSync(new URL("./lib/render.mjs", import.meta.url))).digest("hex").slice(0, 8);
if (!TOKEN && !["127.0.0.1", "::1", "localhost"].includes(HOST)) {
  console.error(`--host ${HOST} reaches beyond this machine: set SCENE_LOOP_TOKEN (the same token the server has).`);
  process.exit(1);
}
const OUT = join(ROOT, ".out");
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { force: true }); // clips nobody fetched before a restart

let chrome = null;
try {
  chrome = basename(findChrome());
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const authed = (req) => !TOKEN || same(req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1].trim() ?? "", TOKEN);
const send = (res, code, body) => (res.writeHead(code, { "Content-Type": "application/json" }), res.end(JSON.stringify(body)));
const json = async (req) => {
  let b = "";
  for await (const d of req) b += d;
  return b ? JSON.parse(b) : {};
};

// One mirror per server video: <ROOT>/<key>/assets/..., scenes/..., and .files.json with
// the size and mtime each file had on the server, so a render only uploads what changed.
const mirror = (key) => {
  if (!/^[\w-]{6,64}$/.test(key)) throw new Error("bad key");
  return join(ROOT, key);
};
const filesOf = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, ".files.json"), "utf8"));
  } catch {
    return {};
  }
};
// A file path from the server: relative, under assets/ or scenes/, no way out of the mirror.
function inMirror(dir, path) {
  const p = normalize(String(path));
  if (!/^(assets|scenes)\//.test(p) || p.split("/").includes("..")) throw new Error(`bad path ${path}`);
  return join(dir, p);
}

// On a Mac, caffeinate -i while a clip renders, so the machine does not idle-sleep under it,
// and nothing when idle, so it still sleeps the rest of the time.
let active = 0, awake = null;
const busy = (d) => {
  active += d;
  if (platform() !== "darwin") return;
  if (active > 0 && !awake) (awake = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })).on("error", () => {});
  if (active === 0 && awake) (awake.kill(), (awake = null));
};
const done = new Map(); // id -> { file, timer }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, version: VERSION, parallel: PARALLEL, active, platform: platform(), arch: arch(), chrome });
    if (!authed(req)) return send(res, 401, { error: "a bearer token is required" });

    let m;
    if (req.method === "POST" && (m = url.pathname.match(/^\/sync\/([\w-]+)$/))) {
      const dir = mirror(m[1]);
      mkdirSync(dir, { recursive: true });
      const { files = [] } = await json(req);
      const have = filesOf(dir);
      const want = new Map(files.map((f) => [normalize(f.path), `${f.size}:${f.mtime}`]));
      for (const p of Object.keys(have)) if (!want.has(p)) (rmSync(inMirror(dir, p), { force: true }), delete have[p]);
      writeFileSync(join(dir, ".files.json"), JSON.stringify(have));
      return send(res, 200, { missing: [...want].filter(([p, v]) => have[p] !== v || !existsSync(inMirror(dir, p))).map(([p]) => p) });
    }

    if (req.method === "PUT" && (m = url.pathname.match(/^\/file\/([\w-]+)$/))) {
      const dir = mirror(m[1]);
      const path = normalize(url.searchParams.get("path") ?? "");
      const file = inMirror(dir, path);
      mkdirSync(join(file, ".."), { recursive: true });
      const tmp = `${file}.part-${randomUUID().slice(0, 6)}`;
      try {
        await pipeline(req, createWriteStream(tmp));
        renameSync(tmp, file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
      const have = filesOf(dir);
      have[path] = `${url.searchParams.get("size")}:${url.searchParams.get("mtime")}`;
      writeFileSync(join(dir, ".files.json"), JSON.stringify(have));
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && (m = url.pathname.match(/^\/clip\/([\w-]+)$/))) {
      const dir = mirror(m[1]);
      const b = await json(req);
      if (typeof b.html !== "string") throw new Error("html is required");
      const id = randomUUID().slice(0, 12);
      // The page sits in its own folder next to the mirror's assets/ and scenes/, like a
      // build on the server, so its relative URLs resolve the same way.
      const build = join(dir, `.clip-${id}`);
      mkdirSync(build, { recursive: true });
      for (const l of ["assets", "scenes"]) symlinkSync(join("..", l), join(build, l));
      writeFileSync(join(build, "index.html"), b.html);
      const out = join(OUT, `${id}.mp4`);
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      let frames = 0;
      const line = (o) => res.write(JSON.stringify(o) + "\n");
      // The frame count once a second, also while Chrome is still loading the page, so the
      // server can tell a slow clip from a machine that went to sleep.
      const beat = setInterval(() => line({ frames }), 1000);
      busy(1);
      const started = Date.now();
      try {
        const r = await renderClip(build, out, { duration: b.duration, start: b.start ?? 0, fps: b.fps ?? 30, width: b.width ?? 1920, height: b.height ?? 1080, onFrame: () => frames++ });
        const timer = setTimeout(() => (rmSync(out, { force: true }), done.delete(id)), 10 * 60000);
        timer.unref();
        done.set(id, { file: out, timer });
        line({ frames: r.frames });
        line({ ok: true, id, frames: r.frames, live: r.live, static: r.static, ms: Date.now() - started });
        console.log(`${new Date().toISOString()} clip ${id}: ${r.frames} frames in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      } catch (e) {
        line({ error: String(e?.message ?? e).slice(-600) });
        console.error(`${new Date().toISOString()} clip ${id} failed: ${e?.message ?? e}`);
      } finally {
        busy(-1);
        clearInterval(beat);
        rmSync(build, { recursive: true, force: true });
        res.end();
      }
      return;
    }

    if (req.method === "GET" && (m = url.pathname.match(/^\/out\/([\w-]+)$/))) {
      const d = done.get(m[1]);
      if (!d || !existsSync(d.file)) return send(res, 404, { error: "no such clip" });
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": statSync(d.file).size });
      createReadStream(d.file).pipe(res).on("finish", () => (clearTimeout(d.timer), done.delete(m[1]), rmSync(d.file, { force: true })));
      return;
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (res.headersSent) return res.end();
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`scene-loop worker ${VERSION} on ${HOST}:${PORT}: ${PARALLEL} pages, ${chrome}, mirror in ${ROOT}${TOKEN ? "" : " (no token)"}`);
});
