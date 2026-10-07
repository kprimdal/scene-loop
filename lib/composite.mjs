// Static stretches of a scene without Chrome per frame. Most of a talking-slides video is a
// still (slide, title, box) with a small <video> moving in a corner: between the CSS
// animations nothing but the video pixels changes, yet the renderer screenshots every frame
// at 100 to 200 ms each. Here such a stretch is captured once, with every video blacked out
// (a black poster in place of its frames), plus one mask per video (the same capture with
// that video's poster white, minus the black one), and ffmpeg lays the real video frames in:
//
//   frame(t) = capture_black + sum over videos of mask_v * videoframe_v(t)
//
// which is exact, because Chrome's output is linear in the video's pixels: whatever sits on
// top of the video (a badge at half opacity, a rounded clip, a group opacity) is already in
// the black capture, and the mask holds exactly the share of each video pixel that reaches
// the screen. What breaks linearity, or moves the video off its rectangle, disqualifies the
// scene and it renders frame by frame as before: CSS filters or blend modes on the video or
// an ancestor, transforms beyond a translation, object-position, a <source> child instead of
// src, a GSAP timeline or a window.__seek drawing function, an animation without an end.
// Every static stretch is verified: its last frame is captured too and must equal its first.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs in the page. Returns { reason } when the scene can't be composited, else the
// animation windows (seconds of scene time in which something other than a video changes)
// and the videos with what ffmpeg needs to place them.
const ANALYZE = `(() => {
  const sl = window.__sl;
  if (!sl || sl.scenes.length !== 1) return { reason: "not a single-scene build" };
  const id = sl.scenes[0].id;
  if (window.__timelines && window.__timelines[id]) return { reason: "GSAP timeline" };
  if (window.__seek && typeof window.__seek[id] === "function") return { reason: "window.__seek drawing function" };
  const slot = document.querySelector("[data-slot]");
  const windows = [];
  for (const a of document.getAnimations()) {
    const tm = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming();
    if (!tm) return { reason: "animation without timing" };
    if (!isFinite(tm.endTime)) return { reason: "animation that never ends" };
    if (a.playbackRate !== 1) return { reason: "animation playbackRate" };
    windows.push([Math.min(tm.delay, tm.endTime) / 1000, tm.endTime / 1000]);
  }
  const videos = [];
  for (const v of slot.querySelectorAll("video")) {
    const cs = getComputedStyle(v);
    if (!v.getAttribute("src")) return { reason: "video without a src attribute" };
    if (v.readyState < 1 || !(v.duration > 0)) return { reason: "video without metadata: " + v.getAttribute("src") };
    if (cs.transform !== "none" && !/^matrix\\(1, 0, 0, 1, /.test(cs.transform)) return { reason: "video with a transform" };
    if (cs.objectPosition !== "50% 50%") return { reason: "video with object-position" };
    if (!["contain", "cover", "fill"].includes(cs.objectFit)) return { reason: "video with object-fit " + cs.objectFit };
    if (v.playbackRate !== 1) return { reason: "video playbackRate" };
    for (let e = v; e && e !== slot; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.filter !== "none" || c.backdropFilter !== "none" || c.mixBlendMode !== "normal") return { reason: "filter or blend mode on a video or its ancestor" };
    }
    videos.push({ src: v.currentSrc, mediaStart: Number(v.getAttribute("data-media-start") || 0), loop: v.loop, fit: cs.objectFit, duration: v.duration });
  }
  return { windows, videos };
})()`;

// Also in the page: the videos' rectangles at the current seek time, in page pixels.
const RECTS = `[...document.querySelector("[data-slot]").querySelectorAll("video")].map((v) => { const r = v.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })`;

// Swap every video's frames for a poster: a canvas of the video's own size (object-fit
// places a poster by its aspect ratio, as it does the frames), black and white, kept on the
// element. The clock skips a video without metadata, so the seeks keep working. The posters
// are decoded up front so the first capture is already right.
const settle = `await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;
const BLACKEN = `(async () => {
  for (const v of document.querySelectorAll("video")) {
    v.__slPosters = ["black", "white"].map((c) => { const k = document.createElement("canvas"); k.width = v.videoWidth || 2; k.height = v.videoHeight || 2; const g = k.getContext("2d"); g.fillStyle = c; g.fillRect(0, 0, k.width, k.height); return k.toDataURL("image/png"); });
    for (const u of v.__slPosters) { const i = new Image(); i.src = u; await i.decode(); }
    v.poster = v.__slPosters[0]; v.removeAttribute("src"); v.load();
  }
  ${settle};
})()`;
const poster = (k, color) => `(async () => { const v = document.querySelectorAll("video")[${k}]; v.poster = v.__slPosters[${color === "white" ? 1 : 0}]; ${settle}; })()`;

export const analyze = (page) => page.evaluate(ANALYZE);

// Frames [0, n) split into runs: { from, to, live }. A live run has an animation window in
// it (with a frame of margin either side); a static run has none and is long enough to pay
// for its captures. frameTime(i) is the scene time of frame i.
export function stretches(n, frameTime, windows, fps, minStatic = 8) {
  const margin = 1 / fps;
  const live = Array.from({ length: n }, (_, i) => windows.some(([s, e]) => frameTime(i) >= s - margin && frameTime(i) <= e + margin));
  const runs = [];
  for (let i = 0; i < n; i++) {
    const last = runs.at(-1);
    if (last && last.live === live[i]) last.to = i + 1;
    else runs.push({ from: i, to: i + 1, live: live[i] });
  }
  for (const r of runs) if (!r.live && r.to - r.from < minStatic) r.live = true;
  return runs.reduce((acc, r) => {
    const last = acc.at(-1);
    if (last && last.live && r.live) last.to = r.to;
    else acc.push({ ...r });
    return acc;
  }, []);
}

// Captures for one static run: the black capture (bg.png), the capture with each video's
// poster white (its mask is white minus black, taken in ffmpeg), the videos' rectangles, and
// a check that the last frame of the run equals the first. Returns null when
// the check fails (something moved that the analysis didn't see): the run renders live.
// The page must already be blackened (BLACKEN) and seeked by the caller's seek(t).
export async function captureStatic(page, seek, run, frameTime, videos, dir) {
  await seek(frameTime(run.from));
  const bg = await page.screenshot({ format: "png" });
  const rects = await page.evaluate(RECTS);
  const masks = [];
  for (let k = 0; k < videos.length; k++) {
    await page.evaluate(poster(k, "white"));
    masks.push(await page.screenshot({ format: "png" }));
    await page.evaluate(poster(k, "black"));
  }
  await seek(frameTime(run.to - 1));
  const end = await page.screenshot({ format: "png" });
  if (!end.equals(bg)) return null;
  const files = { bg: join(dir, `static-${run.from}-bg.png`), whites: masks.map((_, k) => join(dir, `static-${run.from}-white${k}.png`)) };
  writeFileSync(files.bg, bg);
  masks.forEach((m, k) => writeFileSync(files.whites[k], m));
  return { ...files, rects };
}

export const blacken = (page) => page.evaluate(BLACKEN);

// ffmpeg arguments for one static run: the still, each video trimmed to the run's window,
// scaled and cropped as object-fit does, held on its last frame when it ends, multiplied by
// its mask (the white capture minus the black one) and added onto the still. Compositing
// happens on the video's rectangle only, then overlays back onto the still, so the per-frame
// work is the size of the webcam box, not the frame. t0 is the scene time of the run's first
// frame; frames is its length.
export function compositeArgs({ bg, whites, rects }, videos, { t0, frames, fps, width, height }) {
  const D = frames / fps;
  const R = (v) => Math.round(v);
  // The still and the white captures are decoded once and repeated by the loop filter: -loop 1
  // on the input would decode the PNG again for every frame (4 s per 1000 frames at 1080p).
  const once = `loop=loop=-1:size=1:start=0`;
  const args = ["-framerate", String(fps), "-i", bg];
  const shown = videos.map((v, k) => {
    const r = rects[k];
    const w = Math.max(1, R(r.w)), h = Math.max(1, R(r.h)), x = R(r.x), y = R(r.y);
    return x < width && y < height && x + w > 0 && y + h > 0 ? { v, k, w, h, x, y } : null; // off screen: nothing to add
  }).filter(Boolean);
  const filters = [`[0:v]${once},format=gbrp,split=${shown.length + 1}[bg0]${shown.map(({ k }) => `[d${k}]`).join("")}`];
  let cur = "bg0", inputs = 1;
  for (const { v, k, w, h, x, y } of shown) {
    let start = v.mediaStart + t0;
    // A looping video wraps (as the clock does); one that has ended holds its last frame.
    start = v.loop ? start % v.duration : Math.min(start, Math.max(0, v.duration - 1.5 / fps));
    // Chrome shows the frame at or before the time; -ss keeps frames at or after it, so aim half
    // a frame early (and the time is rounded for the command line).
    start = Math.max(0, start - 0.5 / fps);
    const wi = inputs++, vi = inputs++;
    args.push("-framerate", String(fps), "-i", whites[k]);
    args.push(...(v.loop ? ["-stream_loop", "-1"] : []), "-ss", start.toFixed(4), "-i", fileURLToPath(v.src));
    const fit = v.fit === "cover" ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}` : v.fit === "contain" ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black` : `scale=${w}:${h}`;
    const box = `crop=${w}:${h}:${x}:${y}`;
    filters.push(
      `[${vi}:v]setpts=PTS-STARTPTS,fps=${fps},${fit},tpad=stop_mode=clone:stop_duration=${D.toFixed(4)},format=gbrp[v${k}]`,
      `[${wi}:v]${box},${once},format=gbrp[w${k}]`,
      `[d${k}]${box}[k${k}]`,
      `[w${k}][k${k}]blend=all_mode=difference:shortest=1[m${k}]`,
      `[${cur}]split[a${k}][b${k}]`,
      `[a${k}]${box}[c${k}]`,
      `[v${k}][m${k}]blend=all_mode=multiply:shortest=1[vm${k}]`,
      `[c${k}][vm${k}]blend=all_mode=addition:shortest=1[cm${k}]`,
      `[b${k}][cm${k}]overlay=${x}:${y}:format=gbrp:shortest=1[bg${k + 1}]`,
    );
    cur = `bg${k + 1}`;
  }
  // The live segments come from JPEG: full-range YCbCr with the bt470bg (601) matrix. The still
  // goes the same way, so every segment of a clip carries the same colour signalling (a change
  // mid-stream makes the join's filter graph reconfigure and drop the rest of the clip).
  filters.push(`[${cur}]scale=out_range=pc:out_color_matrix=bt601,format=yuv420p[out]`);
  return { inputs: args, filter: filters.join(";"), map: "[out]", frames };
}
