// Stills via HyperFrames' own snapshot (same runtime as the render), one Chrome at a
// time. Comment stills get the commented region drawn on with ffmpeg.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HF = "hyperframes@0.8.103";
let queue = Promise.resolve();

const run = (cmd, args, cwd) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`${cmd}: ${stderr || err.message}`)) : resolve(stdout))),
  );

// Returns [{ t, file }] sorted by time. outDir is absolute.
export function snapshot(buildDir, times, outDir) {
  const job = async () => {
    mkdirSync(outDir, { recursive: true });
    await run("npx", ["--yes", HF, "snapshot", buildDir, "--at", times.map((t) => t.toFixed(2)).join(","), "--no-end", "--describe", "false", "-o", outDir], buildDir);
    return readdirSync(outDir)
      .map((f) => ({ f, m: f.match(/^frame-\d+-at-([\d.]+)s\.png$/) }))
      .filter((x) => x.m)
      .map((x) => ({ t: Number(x.m[1]), file: join(outDir, x.f) }))
      .sort((a, b) => a.t - b.t);
  };
  return (queue = queue.then(job, job));
}

export const versionTimes = (duration) => [0.1, 0.3, 0.5, 0.7, 0.92].map((f) => Math.round(duration * f * 100) / 100);

// region is { x, y, w, h } as fractions of the frame; null means a point-less comment.
export async function annotate(src, region, dest, size = { width: 1920, height: 1080 }) {
  if (!region) return run("cp", [src, dest]);
  const W = size.width, H = size.height;
  const box = [region.x * W, region.y * H, Math.max(region.w * W, 24), Math.max(region.h * H, 24)].map(Math.round);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", `drawbox=x=${box[0]}:y=${box[1]}:w=${box[2]}:h=${box[3]}:color=0xE5484D@0.95:t=8`, dest]);
}

// A downscaled JPEG of a still for tool results, cached next to the PNG.
export async function thumb(src, width = 960) {
  const dest = src.replace(/\.png$/, "") + `.${width}.jpg`;
  if (!existsSync(dest)) await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", `scale=${width}:-2`, "-q:v", "4", dest]);
  return dest;
}
