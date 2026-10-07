// Our renderer: an assembled page (lib/assemble.mjs) in headless Chrome (lib/chrome.mjs),
// stepped frame by frame through the page clock, each frame a screenshot piped into
// ffmpeg. Stills are the same thing at a few times. A whole video is per-scene clips,
// crossfaded with ffmpeg's xfade, with the soundtrack mixed in. Stretches of a scene in
// which only <video> elements move are captured once and composited by ffmpeg instead
// (lib/composite.mjs).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { availableParallelism } from "node:os";
import { withPage } from "./chrome.mjs";
import { analyze, blacken, captureStatic, compositeArgs, stretches } from "./composite.mjs";

// How many pages render at once. Measured on an M4 Pro (video-lab 004): pages scale well
// past the core count's share because a page mostly waits for Chrome's frame. Half the
// cores by default: each page also runs an ffmpeg encoder, and a box with as many pages as
// cores (agent-server, 8 of 8, 2026-10-07) starved the page loads until they timed out.
export const PARALLEL = Number(process.env.SCENE_LOOP_PARALLEL) || Math.max(2, Math.min(8, Math.ceil(availableParallelism() / 2)));

// Static stretches through ffmpeg (lib/composite.mjs); SCENE_LOOP_COMPOSITE=0 renders every
// frame in Chrome as before.
export const COMPOSITE = process.env.SCENE_LOOP_COMPOSITE !== "0";

// A tiny semaphore so stills, comment stills and render clips share the Chrome fairly.
let active = 0;
const waiting = [];
async function slot(fn) {
  if (active >= PARALLEL) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// Opens a build and waits for the page clock (fonts, images, videos loaded). A page with
// videos gets longer: Chrome fetches their metadata before the clock is ready. One retry
// with twice the time, because a load that times out on a busy box usually makes it the
// second time; rebuild() (optional) recreates the build first if its index.html is gone
// (another request wiped .build under a running render).
export const LOAD_TIMEOUT = Number(process.env.SCENE_LOOP_LOAD_TIMEOUT) || 60000;
async function open(page, buildDir, { rebuild } = {}) {
  const index = join(buildDir, "index.html");
  const hasVideo = () => existsSync(index) && /<video[\s>]/.test(readFileSync(index, "utf8"));
  let ms = hasVideo() ? LOAD_TIMEOUT * 2 : LOAD_TIMEOUT;
  for (let attempt = 1; ; attempt++) {
    try {
      if (!existsSync(index) && rebuild) await rebuild();
      await page.goto(pathToFileURL(index).href, ms);
      const info = await page.evaluate("window.__sl ? window.__sl.ready.then(a => ({ duration: a.duration, width: a.width, height: a.height, fps: a.fps })) : null");
      if (!info) throw new Error(`${buildDir}: the page has no clock (window.__sl)`);
      if (page.errors.length) throw new Error(`scene script error: ${page.errors[0]}`);
      return info;
    } catch (e) {
      if (attempt > 1 || !/timed out|no answer from Chrome|ERR_FILE_NOT_FOUND|no clock/.test(e.message)) throw e;
      ms *= 2;
    }
  }
}

const seek = (page, t) => page.evaluate(`window.__sl.seek(${t})`);

// Stills at the given times (seconds), as frame-NN-at-T.TTs.png in outDir. Returns
// [{ t, file }] sorted by time.
export function stills(buildDir, times, outDir, { width = 1920, height = 1080 } = {}) {
  return slot(() =>
    withPage({ width, height }, async (page) => {
      await open(page, buildDir);
      mkdirSync(outDir, { recursive: true });
      const out = [];
      for (const [i, t] of [...times].sort((a, b) => a - b).entries()) {
        await seek(page, t);
        const file = join(outDir, `frame-${String(i + 1).padStart(2, "0")}-at-${t.toFixed(2)}s.png`);
        writeFileSync(file, await page.screenshot());
        out.push({ t: Number(t.toFixed(2)), file });
      }
      return out;
    }),
  );
}

function ffmpeg(args, { onProgress } = {}) {
  const proc = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...(onProgress ? ["-progress", "pipe:1", "-nostats"] : []), ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
  if (onProgress) proc.stdout.on("data", (d) => {
    const m = String(d).match(/out_time_us=(\d+)/g);
    if (m) onProgress(Number(m.at(-1).split("=")[1]) / 1e6);
  });
  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err.trim() || `exit ${code}`}`))));
  });
  done.catch(() => {}); // a caller that kills ffmpeg after a frame failed may never await this
  return { proc, done };
}

// The same x264 settings for every segment, so the parts concatenate without re-encoding.
const X264 = (fps, file) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-color_range", "pc", "-colorspace", "bt470bg", "-r", String(fps), file];

// A scene's frames on the video's frame grid: from round(start * fps) to round(end * fps),
// so the clips add up to exactly round(total * fps) frames and nothing drifts. phase is
// the scene time of the clip's first frame (within half a frame of 0).
export function frameSpan(start, duration, fps) {
  const f0 = Math.round(start * fps), f1 = Math.round((start + duration) * fps);
  return { frames: Math.max(1, f1 - f0), phase: Math.round((f0 / fps - start) * 1e6) / 1e6 };
}
export const frameCount = (duration, fps, start = 0) => frameSpan(start, duration, fps).frames;

// Frames [from, to) screenshot one by one in a page, piped into ffmpeg as JPEGs.
async function renderLive(page, { from, to, frameTime, fps, format, quality, file, onFrame }) {
  const ff = ffmpeg(["-f", "image2pipe", "-framerate", String(fps), "-c:v", format === "png" ? "png" : "mjpeg", "-i", "-", ...X264(fps, file)]);
  try {
    for (let i = from; i < to; i++) {
      await seek(page, frameTime(i));
      const img = await page.screenshot({ format, quality: format === "png" ? undefined : quality });
      if (!ff.proc.stdin.write(img)) await new Promise((r) => ff.proc.stdin.once("drain", r));
      onFrame?.();
    }
    ff.proc.stdin.end();
    await ff.done;
  } catch (e) {
    ff.proc.kill("SIGKILL");
    throw e;
  }
}

// Looks at the scene once and captures every static stretch (lib/composite.mjs). Returns
// { runs, videos, captures } or null when the scene has to render frame by frame.
async function planStatic(buildDir, { n, frameTime, fps, width, height, workDir, rebuild }) {
  return slot(() =>
    withPage({ width, height }, async (page) => {
      await open(page, buildDir, { rebuild });
      const a = await analyze(page);
      if (a.reason) return { reason: a.reason };
      const runs = stretches(n, frameTime, a.windows, fps);
      if (!runs.some((r) => !r.live)) return { reason: "no static stretch" };
      await blacken(page);
      const captures = new Map();
      for (const r of runs) {
        if (r.live) continue;
        const c = await captureStatic(page, (t) => seek(page, t), r, frameTime, a.videos, workDir);
        if (c) captures.set(r.from, c);
        else r.live = true;
      }
      return { runs, videos: a.videos, captures };
    }),
  );
}

// One scene build to an mp4 clip, video only. Live frames are split into chunks of at most
// a second that render in parallel pages, each into its own segment; static stretches are
// one ffmpeg job each; the segments are joined without re-encoding. Per-frame latency in
// headless Chrome is mostly waiting for a frame, so pages in parallel scale well beyond the
// core count's share (video-lab 004). onFrame() after every frame (static frames count when
// their segment is done). The file appears only when the clip is complete, so a cache never
// holds half a clip. Returns { file, frames, live, static }: how many frames went each way.
export const CHUNK = Number(process.env.SCENE_LOOP_CHUNK) || 30;
export async function renderClip(buildDir, out, { duration, start = 0, fps = 30, width = 1920, height = 1080, onFrame, format = "jpeg", quality = 95, rebuild } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const { frames: n, phase } = frameSpan(start, duration, fps);
  const frameTime = (i) => Math.max(0, phase + i / fps);
  const work = out.replace(/\.mp4$/, ".work");
  mkdirSync(work, { recursive: true });
  try {
    const plan = COMPOSITE ? await planStatic(buildDir, { n, frameTime, fps, width, height, workDir: work, rebuild }) : { reason: "SCENE_LOOP_COMPOSITE=0" };
    const runs = plan.reason ? [{ from: 0, to: n, live: true }] : plan.runs;
    // Live runs in chunks of at most CHUNK frames; a short scene is still split across the pages.
    const segments = [];
    for (const r of runs) {
      if (!r.live) {
        segments.push(r);
        continue;
      }
      const len = r.to - r.from;
      const k = Math.max(Math.ceil(len / CHUNK), runs.length === 1 ? Math.min(PARALLEL, Math.floor(len / 15)) : 1) || 1;
      for (let c = 0; c < k; c++) segments.push({ from: r.from + Math.floor((c * len) / k), to: r.from + Math.floor(((c + 1) * len) / k), live: true });
    }
    segments.forEach((s, i) => (s.file = join(work, `seg${String(i).padStart(3, "0")}.mp4`)));
    await Promise.all(
      segments.map((seg) =>
        seg.live
          ? slot(() =>
              withPage({ width, height }, async (page) => {
                await open(page, buildDir, { rebuild });
                await renderLive(page, { ...seg, frameTime, fps, format, quality, onFrame });
              }),
            )
          : (async () => {
              const c = compositeArgs(plan.captures.get(seg.from), plan.videos, { t0: frameTime(seg.from), frames: seg.to - seg.from, fps, width, height });
              await ffmpeg([...c.inputs, "-filter_complex", c.filter, "-map", c.map, "-frames:v", String(c.frames), ...X264(fps, seg.file)]).done;
              for (let i = seg.from; i < seg.to; i++) onFrame?.();
            })(),
      ),
    );
    const list = join(work, "parts.txt");
    writeFileSync(list, segments.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const tmp = out.replace(/\.mp4$/, ".part.mp4");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", tmp]).done;
    renameSync(tmp, out);
    const live = segments.filter((s) => s.live).reduce((a, s) => a + s.to - s.from, 0);
    return { file: out, frames: n, live, static: n - live, reason: plan.reason ?? null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Clips [{ file, frames, fade }] (fade: crossfade seconds into that clip) to one mp4 with the
// soundtrack. Each clip's last frame is held under the next clip's fade, so every scene
// starts exactly at its storyboard time and the total length is the sum of the clips.
export async function joinClips(clips, out, { fps = 30, soundtrack = null, onProgress } = {}) {
  const total = clips.reduce((a, c) => a + c.frames / fps, 0);
  const inputs = clips.flatMap((c) => ["-i", c.file]);
  const filters = [];
  let cur = "[0:v]", at = clips[0].frames / fps;
  for (let k = 1; k < clips.length; k++) {
    const d = Math.min(clips[k].fade ?? 0, clips[k].frames / fps);
    if (d > 0) {
      filters.push(`${cur}tpad=stop_mode=clone:stop_duration=${d}[p${k}]`, `[p${k}][${k}:v]xfade=transition=fade:duration=${d}:offset=${at.toFixed(4)}[x${k}]`);
    } else filters.push(`${cur}[${k}:v]concat=n=2:v=1:a=0[x${k}]`);
    cur = `[x${k}]`;
    at += clips[k].frames / fps;
  }
  const map = clips.length > 1 ? ["-filter_complex", filters.join(";"), "-map", cur] : ["-map", "0:v"];
  const audio = soundtrack ? ["-i", soundtrack] : [];
  const audioMap = soundtrack ? ["-map", `${clips.length}:a`, "-c:a", "aac", "-b:a", "192k"] : [];
  mkdirSync(dirname(out), { recursive: true });
  const tmp = out.replace(/\.mp4$/, ".part.mp4");
  const ff = ffmpeg([...inputs, ...audio, ...map, ...audioMap, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), "-frames:v", String(clips.reduce((a, c) => a + c.frames, 0)), "-movflags", "+faststart", tmp], { onProgress: onProgress && ((s) => onProgress(Math.min(1, s / total))) });
  ff.proc.stdin.end();
  try {
    await ff.done;
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, out);
  return { file: out, duration: total };
}
