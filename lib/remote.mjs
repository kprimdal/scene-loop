// Render workers on other machines (worker.mjs), for when a faster computer is awake.
// SCENE_LOOP_WORKERS lists their URLs; a render asks each for /health with a short timeout
// and uses the first that answers, or renders everything here as before. The worker gets
// the files the scenes use (only what changed since the last render) and one assembled
// page per clip, and sends the mp4 back. A clip that fails remotely is rendered here.
import { createReadStream, createWriteStream, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const WORKERS = (process.env.SCENE_LOOP_WORKERS ?? "").split(/[\s,]+/).filter(Boolean).map((u) => u.replace(/\/+$/, ""));
const TOKEN = process.env.SCENE_LOOP_WORKER_TOKEN ?? process.env.SCENE_LOOP_TOKEN ?? null;
const auth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
const HEALTH_MS = 1500;
const IDLE_MS = 20000; // the worker writes a line every second; this long without one, the machine is asleep or gone

// The first worker that answers /health, or null.
export async function findWorker() {
  for (const url of WORKERS) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_MS) });
      if (r.ok) return { url, ...(await r.json()) };
    } catch {}
  }
  return null;
}

// The files a render needs on the worker: everything under assets/ and scenes/ except the
// narration (the page is muted), but a large file only when a page names it, so a raw
// screen recording that was only cut into clips is not uploaded.
const LARGE = 25 * 1024 * 1024;
export function filesFor(dir, htmls) {
  const named = new Set(htmls.flatMap((h) => h.match(/\b(?:assets|scenes)\/[^\s"'()<>?#\\]+/g) ?? []).map(decodeURI));
  const out = [];
  const walk = (rel) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (p === "assets/narration" || p === "assets/narration.m4a") continue;
      const st = statSync(join(dir, p), { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && (st.size <= LARGE || named.has(p))) out.push({ path: p, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }
  };
  walk("assets");
  walk("scenes");
  return out;
}

// One mirror on the worker per video on this server.
export const mirrorKey = (dir) => createHash("sha1").update(`${hostname()}:${dir}`).digest("hex").slice(0, 16);

async function call(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...auth, ...opts.headers } });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}

// Brings the worker's mirror up to date. Returns how many files and bytes went over.
export async function syncFiles(worker, key, dir, files) {
  const { missing } = await (await call(`${worker.url}/sync/${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files }) })).json();
  const byPath = new Map(files.map((f) => [f.path, f]));
  let bytes = 0;
  for (const p of missing) {
    const f = byPath.get(p);
    const q = new URLSearchParams({ path: p, size: f.size, mtime: f.mtime });
    await call(`${worker.url}/file/${key}?${q}`, { method: "PUT", body: Readable.toWeb(createReadStream(join(dir, p))), duplex: "half", headers: { "Content-Length": String(f.size) } });
    bytes += f.size;
  }
  return { files: missing.length, bytes };
}

// One clip on the worker. onFrames(n) with the frame count so far. The mp4 lands in out
// only when it is complete, like renderClip.
export async function remoteClip(worker, key, html, out, opts, onFrames) {
  const ac = new AbortController();
  let idle;
  const touch = () => (clearTimeout(idle), (idle = setTimeout(() => ac.abort(new Error(`${worker.url}: no word for ${IDLE_MS / 1000} s`)), IDLE_MS)));
  touch();
  try {
    const r = await call(`${worker.url}/clip/${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html, ...opts }), signal: ac.signal });
    let buf = "", result = null;
    for await (const chunk of r.body) {
      touch();
      buf += Buffer.from(chunk).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.error) throw new Error(`${worker.url}: ${msg.error}`);
        if (msg.ok) result = msg;
        else if (typeof msg.frames === "number") onFrames?.(msg.frames);
      }
    }
    if (!result) throw new Error(`${worker.url}: the clip stream ended without a result`);
    const tmp = out.replace(/\.mp4$/, ".remote.mp4");
    try {
      const got = await call(`${worker.url}/out/${result.id}`, { signal: ac.signal });
      await pipeline(Readable.fromWeb(got.body), createWriteStream(tmp));
      renameSync(tmp, out);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return { file: out, frames: result.frames, ms: result.ms };
  } finally {
    clearTimeout(idle);
  }
}
