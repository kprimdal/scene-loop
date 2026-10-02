// Screen recordings are cut into scene-sized, muted clips under assets/clips/.
// ffmpeg and ffprobe are separate programs; scene-loop does not depend on an npm package.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const obj = (properties = {}, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const modelArg = { model: { type: "string", description: "Your model name, shown on the project version." } };

function run(program, args) {
  return new Promise((done, fail) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", fail);
    child.on("close", (code) => code === 0 ? done({ stdout, stderr }) : fail(new Error(`${program}: ${stderr.trim() || `exit ${code}`}`)));
  });
}

const number = (value, name, { min = -Infinity, integer = false } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new Error(`${name} must be ${integer ? "an integer" : "a number"}${Number.isFinite(min) ? ` >= ${min}` : ""}`);
  return n;
};

const decimal = (n) => String(Math.round(n * 1e9) / 1e9);
const rate = (s) => {
  if (!s || s === "0/0") return 0;
  const [a, b = "1"] = String(s).split("/").map(Number);
  return b ? a / b : 0;
};

export async function probeMedia(path) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,duration",
    "-of", "json",
    path,
  ]);
  const data = JSON.parse(stdout);
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const seconds = [data.format?.duration, video?.duration, ...streams.map((s) => s.duration)].map(Number).find(Number.isFinite);
  return {
    path,
    seconds: Number.isFinite(seconds) ? seconds : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: video ? rate(video.avg_frame_rate) || rate(video.r_frame_rate) : null,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

export async function cutClip({ source, from, to, out, duration, fit = "hold", fps = 30, width, height }) {
  if (typeof source !== "string" || !source) throw new Error("source is required");
  if (typeof out !== "string" || !out) throw new Error("out is required");
  from = number(from, "from", { min: 0 });
  to = number(to, "to", { min: 0 });
  duration = number(duration, "duration", { min: Number.EPSILON });
  fps = number(fps, "fps", { min: Number.EPSILON });
  width = number(width, "width", { min: 1, integer: true });
  height = number(height, "height", { min: 1, integer: true });
  if (to <= from) throw new Error("to must be greater than from");
  if (!["hold", "speed", "trim"].includes(fit)) throw new Error('fit must be "hold", "speed" or "trim"');

  const sourceSeconds = to - from;
  const speed = fit === "speed" && sourceSeconds > duration ? sourceSeconds / duration : 1;
  const wantedSeconds = fit === "trim" ? Math.min(sourceSeconds, duration) : duration;
  const frames = Math.max(1, Math.round(wantedSeconds * fps));
  const base = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  let filter;
  if (fit === "speed" && speed > 1) {
    filter = `${base},setpts=(PTS-STARTPTS)/${decimal(speed)},fps=${decimal(fps)},trim=duration=${decimal(duration)}`;
  } else {
    const used = Math.min(sourceSeconds, duration);
    filter = `${base},trim=duration=${decimal(used)},setpts=PTS-STARTPTS,fps=${decimal(fps)}`;
    if (fit !== "trim" && used < duration) filter += `,tpad=stop_mode=clone:stop_duration=${decimal(duration - used)}`;
    filter += `,trim=duration=${decimal(wantedSeconds)}`;
  }

  mkdirSync(dirname(out), { recursive: true });
  const temp = `${out}.part-${process.pid}-${Date.now()}.mp4`;
  try {
    await run("ffmpeg", [
      "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
      "-ss", decimal(from), "-t", decimal(sourceSeconds), "-i", source,
      "-vf", filter,
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-r", decimal(fps), "-frames:v", String(frames),
      "-movflags", "+faststart", temp,
    ]);
    renameSync(temp, out);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  const made = await probeMedia(out);
  return { out, sourceSeconds, clipSeconds: made.seconds, speed };
}

function mediaPath(videoDir, input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("path is required");
  if (isAbsolute(input)) return resolve(input);
  const root = resolve(videoDir, "assets");
  const local = input.replace(/^\.\//, "").replace(/^assets\//, "");
  const path = resolve(root, local);
  if (path !== root && !path.startsWith(root + sep)) throw new Error("relative media paths must stay under assets/");
  return path;
}

function mustFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Media file does not exist: ${path}`);
  return path;
}

function clipName(value) {
  const stem = String(value).replace(/\.mp4$/i, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(stem)) throw new Error("clip name must use letters, digits, ., _ or -");
  return `${stem}.mp4`;
}

const publicUrl = (ctx, rel) => `${ctx.origin}/p/${encodeURIComponent(ctx.video.project)}/${encodeURIComponent(ctx.video.video)}/${rel.split("/").map(encodeURIComponent).join("/")}`;

async function cutClipTool({ scene: sceneId, source, from, to, fit = "hold", name, model }, ctx) {
  const sb = ctx.video.storyboard();
  const scene = sb.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`${sceneId} is not a scene in ${ctx.video.video}`);
  const input = mustFile(mediaPath(ctx.video.dir, source));
  const filename = clipName(name ?? scene.id);
  const rel = `assets/clips/${filename}`;
  const out = join(ctx.video.dir, "assets", "clips", filename);
  const result = await cutClip({
    source: input,
    from,
    to,
    out,
    duration: scene.duration,
    fit,
    fps: sb.fps ?? 30,
    width: sb.width ?? 1920,
    height: sb.height ?? 1080,
  });
  const version = await ctx.video.history.commitProject([rel], `clip: ${scene.id}`, model);
  const html = readFileSync(join(ctx.video.dir, "scenes", scene.id, "scene.html"), "utf8");
  const note = html.includes(rel) ? null : `Add <video src="${rel}" data-start="0" data-duration="${scene.duration}" muted playsinline preload="auto"></video> to ${scene.id}/scene.html. Assets changed, so the scene clip cache key changed.`;
  return { ...result, scene: scene.id, duration: scene.duration, url: publicUrl(ctx, rel), version, note };
}

function filesUnder(root) {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

async function listClips(_args, ctx) {
  const root = join(ctx.video.dir, "assets", "clips");
  const scenes = ctx.video.storyboard().scenes.map((scene) => ({
    id: scene.id,
    html: readFileSync(join(ctx.video.dir, "scenes", scene.id, "scene.html"), "utf8"),
  }));
  const clips = [];
  for (const path of filesUnder(root)) {
    const name = relative(root, path).split(sep).join("/");
    const rel = `assets/clips/${name}`;
    let info, error;
    try {
      info = await probeMedia(path);
    } catch (e) {
      info = { seconds: null, width: null, height: null, fps: null };
      error = e.message;
    }
    clips.push({
      name,
      path,
      url: publicUrl(ctx, rel),
      seconds: info.seconds,
      size: statSync(path).size,
      width: info.width,
      height: info.height,
      fps: info.fps,
      scenes: scenes.filter((scene) => scene.html.includes(rel)).map((scene) => scene.id),
      ...(error ? { error } : {}),
    });
  }
  return { clips };
}

export const CLIP_TOOLS = [
  {
    name: "cut_clip", video: true,
    description: "Cut a source recording into a muted H.264 scene clip under assets/clips, scaled and padded to the video size. Does not edit scene HTML.",
    inputSchema: obj({
      scene: { type: "string", description: "Scene id." },
      source: { type: "string", description: "Absolute server path, or a path under this video's assets/." },
      from: { type: "number", description: "First source second, inclusive." },
      to: { type: "number", description: "Last source second, exclusive." },
      fit: { type: "string", enum: ["hold", "speed", "trim"], default: "hold" },
      name: { type: "string", description: "Optional output filename stem; defaults to the scene id." },
      ...modelArg,
    }, ["scene", "source", "from", "to", "model"]),
    handler: cutClipTool,
  },
  {
    name: "list_clips", video: true,
    description: "List files under assets/clips with duration, dimensions, frame rate, byte size and the scenes whose HTML references each clip.",
    inputSchema: obj(),
    handler: listClips,
  },
  {
    name: "probe_media", video: true,
    description: "Inspect a media file before cutting it: duration, dimensions, frame rate and whether it has audio.",
    inputSchema: obj({ path: { type: "string", description: "Absolute server path, or a path under this video's assets/." } }, ["path"]),
    handler: ({ path }, ctx) => probeMedia(mustFile(mediaPath(ctx.video.dir, path))),
  },
];
