// Our renderer: an assembled page (lib/assemble.mjs) in headless Chrome (lib/chrome.mjs),
// stepped frame by frame through the page clock, each frame a screenshot piped into
// ffmpeg. Stills are the same thing at a few times. A whole video is per-scene clips,
// crossfaded with ffmpeg's xfade, with the soundtrack mixed in.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { availableParallelism } from "node:os";
import { withPage } from "./chrome.mjs";

// How many pages render at once. Measured on an M4 Pro (video-lab 004): see findings.md.
export const PARALLEL = Number(process.env.SCENE_LOOP_PARALLEL) || Math.max(2, Math.min(8, availableParallelism()));

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

// Opens a build and waits for the page clock (fonts, images, videos loaded).
async function open(page, buildDir) {
  await page.goto(pathToFileURL(join(buildDir, "index.html")).href);
  const info = await page.evaluate("window.__sl ? window.__sl.ready.then(a => ({ duration: a.duration, width: a.width, height: a.height, fps: a.fps })) : null");
  if (!info) throw new Error(`${buildDir}: the page has no clock (window.__sl)`);
  if (page.errors.length) throw new Error(`scene script error: ${page.errors[0]}`);
  return info;
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
  return { proc, done };
}

// A scene's frames on the video's frame grid: from round(start * fps) to round(end * fps),
// so the clips add up to exactly round(total * fps) frames and nothing drifts. phase is
// the scene time of the clip's first frame (within half a frame of 0).
export function frameSpan(start, duration, fps) {
  const f0 = Math.round(start * fps), f1 = Math.round((start + duration) * fps);
  return { frames: Math.max(1, f1 - f0), phase: Math.round((f0 / fps - start) * 1e6) / 1e6 };
}
export const frameCount = (duration, fps, start = 0) => frameSpan(start, duration, fps).frames;

// One scene build to an mp4 clip, video only. The frames are split into chunks of at most a
// second that render in parallel pages, each into its own segment, joined without
// re-encoding. Per-frame latency in headless Chrome is mostly waiting for a frame, so
// pages in parallel scale well beyond the core count's share (video-lab 004).
// onFrame() after every frame. The file appears only when the clip is complete, so a
// cache never holds half a clip.
export const CHUNK = Number(process.env.SCENE_LOOP_CHUNK) || 30;
export async function renderClip(buildDir, out, { duration, start = 0, fps = 30, width = 1920, height = 1080, onFrame, format = "jpeg", quality = 95 } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const { frames: n, phase } = frameSpan(start, duration, fps);
  const k = Math.max(Math.ceil(n / CHUNK), Math.min(PARALLEL, Math.floor(n / 15))) || 1; // a short scene still uses every page
  const parts = Array.from({ length: k }, (_, c) => ({ from: Math.floor((c * n) / k), to: Math.floor(((c + 1) * n) / k), file: out.replace(/\.mp4$/, `.part${c}.mp4`) }));
  const list = out.replace(/\.mp4$/, ".parts.txt");
  try {
    await Promise.all(
      parts.map((part) =>
        slot(() =>
          withPage({ width, height }, async (page) => {
            await open(page, buildDir);
            const ff = ffmpeg(["-f", "image2pipe", "-framerate", String(fps), "-c:v", format === "png" ? "png" : "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(fps), part.file]);
            try {
              for (let i = part.from; i < part.to; i++) {
                await seek(page, Math.max(0, phase + i / fps));
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
          }),
        ),
      ),
    );
    writeFileSync(list, parts.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const tmp = out.replace(/\.mp4$/, ".part.mp4");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", tmp]).done;
    renameSync(tmp, out);
  } finally {
    for (const p of parts) rmSync(p.file, { force: true });
    rmSync(list, { force: true });
  }
  return { file: out, frames: n };
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
