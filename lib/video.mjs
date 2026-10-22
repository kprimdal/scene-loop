// One open video: its storyboard, version history (.history), state (.state), builds
// (.build), stills and renders. Everything a tool or a UI route does to a video goes
// through the object returned by openVideo, so the MCP endpoint and the page share it.
// (A video is what earlier versions called a project; names on disk stay as they were:
// project/vN tags for storyboard and theme versions, .state/project.json.)
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, renameSync, copyFileSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { dirname, extname, isAbsolute, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createHistory } from "./history.mjs";
import { buildScene, buildWhole, fadeIn, FPS } from "./assemble.mjs";
import { snapshot, versionTimes, annotate } from "./stills.mjs";
import { renderClip, joinClips, frameCount, frameSpan, systemFonts, camVisible, RENDER_ID } from "./render.mjs";
import { findWorker, filesFor, mirrorKey, syncFiles, remoteClip } from "./remote.mjs";
import { narrationWords as convertNarrationWords } from "./words.mjs";
import { videoCues, kitNames, momentaryMax, SFX_LEVEL } from "./sfx.mjs";
import { analyzeTake, cutNarration, cutCam, cutRange, samplesOf, windowsDb, levels, threshold, hums, mergedFalseStart, cutPoint, keepRanges, toTake, fromTake as fromTakeTime, WINDOW } from "./takes.mjs";

// Whether a script change is only spelling against the words the take was timed with: null when
// it is, otherwise the reason.
const normWord = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function spellingOnly(taken, script) {
  if (!taken) return "the take has no timed words to compare with.";
  const a = taken.map(normWord).filter(Boolean), b = String(script).split(/\s+/).map(normWord).filter(Boolean);
  if (a.length !== b.length) return `the take has ${a.length} words and the line now has ${b.length}.`;
  const off = a.map((w, i) => [w, b[i]]).filter(([x, y]) => x !== y && editDistance(x, y) > Math.max(1, Math.floor(Math.max(x.length, y.length) / 3)));
  return off.length ? `the take says ${off.slice(0, 3).map(([x, y]) => `"${x}" where the line has "${y}"`).join(", ")}.` : null;
}

export const SCENE_CONTRACT =
  "Each scene is scenes/<id>/scene.html: a <template> with a <style> and a root <div id=\"root\" data-composition-id=\"<id>\" data-width data-height data-duration>. Motion is CSS animations (or Web Animations from a <script> with el.animate()); times are seconds from the scene start, so an element that comes in at 1.2 s gets animation-delay: 1.2s. Use fill-mode both so the before and after states hold. When narration words exist, anchor to words instead of seconds: data-at=\"word:brush\", word:brush#2, sentence:2, offsets such as word:brush+0.3, alternatives such as word:noon|sentence:6+0.4, and one space-separated anchor per CSS animation. Code using el.animate() gets a scene-local second from window.__at[\"<id>\"](spec, fallback). A new narration take re-times these anchors; run fit_scenes_to_narration again if the audio length changed. The reviewer records first and fixes the script after: a take's words are adopted into the narration (set_narration_words), so a rephrased line can lose the word an anchor names. After every adoption, new take or script change, read anchorWarnings and sfxWarnings (in the result and in list_scenes) and re-anchor those elements to words that were said. The app's clock pauses every animation and seeks it to the frame being shown, so never rely on wall time: no setTimeout, setInterval, requestAnimationFrame loops, Date.now() or CSS transitions for motion. Something you draw yourself (canvas, a counter) registers window.__seek[\"<id>\"] = function (t) { ... } and draws the state at scene time t. Fonts come from files: put them in assets/fonts, declare them with @font-face in theme.css and name them in font-family. A font that is only installed (system-ui, sans-serif, Arial, or Inter without @font-face) is drawn differently on every machine, so the reviewer's preview, the stills and the render disagree; get_stills and list_scenes report such text as systemFonts. Prefix element ids and @keyframes names with the scene id; ids and classes must not start with a digit. Scenes written for the old contract (one paused GSAP timeline in window.__timelines[\"<id>\"]) still play: the app loads GSAP for them and seeks the timeline, but write new scenes in CSS. Don't use HyperFrames skills or Studio; the app assembles and renders. theme.css is injected after every scene's styles, so project-wide changes (fonts, colours) go there; in the assembled page each scene's #root becomes a .scene element, so target .scene (with !important where a scene sets its own value). " +
  "Camera: when the reviewer records the narration to camera (the Record view), each scene with a chosen take gets assets/cam/<id>.mp4, muted, at the video's size, and its t=0 is the scene's t=0 (it starts narrationLead before the first word and covers the whole scene). Place it with <video class=\"cam\" src=\"assets/cam/<id>.mp4\" muted playsinline></video> (no data-media-start needed) and frame it with CSS anchored to words like any element: full frame (inset 0, object-fit cover), a picture-in-picture box in a corner (width, height, border-radius, overflow hidden on a wrapper), a side split, or off (opacity 0). Moving it with left/top/width/height or opacity is cheapest; a CSS transform, filter or object-position on the video makes the scene render frame by frame (slower, fine). A missing cam file leaves the box empty, so write the scene before the recording. Restarts and filler sounds in a take are cut out only where the camera is not on screen at that moment (the jump would show); where it is, the scene is flagged to record again. " +
  "Sound effects: data-sfx on any element, space-separated cues name@spec[:gainDb], e.g. data-sfx=\"pop@word:fyrre whoosh@sentence:2-0.2 tick@1.25 thud@word:nu:-4\". spec is a data-at anchor (word:, sentence:, offsets, | alternatives, which may end in plain seconds: word:fyrre|1.2) or plain scene seconds; an anchor that is not heard falls back like data-at (near spelling, alternatives, the element's CSS animation delay). build_soundtrack mixes them at gain 0 = 11 dB under the voice, gainDb on top; list_scenes shows each cue's resolved time and warnings. Kit: " + kitNames().join(", ") + " (riser is 1.2 s long: anchor it 1.2 s before the word it leads into, word:x-1.2; typing is a 1.5 s keyboard burst for a fake chat window). assets/sfx/<name>.wav adds or replaces a sound for this video (brought to the kit's level). Keep effects few and quiet: an explainer, not a game.";

const starterScene = (id, sb, title) => `<template>
<style>
#root{position:absolute;inset:0;width:${sb.width ?? 1920}px;height:${sb.height ?? 1080}px;background-color:${sb.background ?? "#FFFFFF"};color:#111111;font-family:system-ui,sans-serif;overflow:hidden}
#${id}-title{position:absolute;left:0;right:0;top:46%;text-align:center;font-size:96px;font-weight:700;letter-spacing:-0.03em;animation:${id}-rise 0.8s cubic-bezier(0.165,0.84,0.44,1) 0.3s both}
@keyframes ${id}-rise{from{opacity:0;transform:translateY(40px)}}
</style>
<div id="root" data-composition-id="${id}" data-width="${sb.width ?? 1920}" data-height="${sb.height ?? 1080}" data-duration="${sb.scenes.find((s) => s.id === id).duration}">
  <div id="${id}-title">${String(title).replace(/</g, "&lt;")}</div>
</div>
</template>
`;

const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40) || "scene";

const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const writeJson = (p, v) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, JSON.stringify(v, null, 2)));

// The page's anchor matching, for list_scenes (anchor-core.js is plain script, not a module).
const anchorCore = new Function(`${readFileSync(new URL("./anchor-core.js", import.meta.url), "utf8")}; return __slAnchorCore;`)();

const exec = (command, args) =>
  new Promise((resolve, reject) =>
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(`${command}: ${String(stderr).trim() || error.message}`)) : resolve(String(stdout)),
    ),
  );

// emit(type, data) is the server's SSE broadcast; every event from a video carries its
// project and video names.
export async function openVideo(dir, { project, video, reviewer, emit: emitAll }) {
  const name = video;
  const emit = (type, data = {}) => emitAll(type, { project, video, ...data });
  const stateDir = join(dir, ".state");
  const rendersDir = join(dir, "renders");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(rendersDir, { recursive: true });

  // Builds a running render has pages on. A storyboard or theme change wipes .build so the
  // previews pick it up, but a build dir replaced under a navigating page made that page's
  // load fail (agent-server, 2026-10-07); these stay until the render is over.
  const busyBuilds = new Set();
  function clearGeneratedBuilds() {
    if (!existsSync(join(dir, ".build"))) return;
    for (const f of readdirSync(join(dir, ".build"))) if (f !== "clips" && !busyBuilds.has(join(dir, ".build", f))) rmSync(join(dir, ".build", f), { recursive: true, force: true });
  }

  const storyboard = () => ({ ...JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")), themeCss: readIf(join(dir, "theme.css")) });

  // Scene starts follow from order and durations, so adding, removing or reordering
  // scenes never leaves gaps. A soundtrack laid to the old cuts won't follow; callers warn.
  function saveStoryboard(sb) {
    const { themeCss, ...out } = sb;
    let t = 0;
    for (const s of out.scenes) {
      s.start = Math.round(t * 1000) / 1000;
      t += s.duration;
    }
    out.duration = Math.round(t * 1000) / 1000;
    writeFileSync(join(dir, "storyboard.json"), JSON.stringify(out, null, 2) + "\n");
    return out;
  }

  const history = createHistory(dir);
  await history.init(storyboard().scenes.map((s) => s.id));

  // Builds are cheap and tied to this version of the app (the player wants its clock in the
  // page), so a fresh process starts without the old ones. Render clips stay: their key covers
  // what matters.
  clearGeneratedBuilds();

  // ---------- state on disk (.state/) ----------
  const sceneStatePath = (id) => join(stateDir, "scenes", `${id}.json`);
  const sceneState = (id) => readJson(sceneStatePath(id), { comments: [], versions: {} });
  const saveSceneState = (id, s) => writeJson(sceneStatePath(id), s);
  const chatPath = (key) => join(stateDir, "chat", `${key}.jsonl`);
  const chat = (key) => (existsSync(chatPath(key)) ? readFileSync(chatPath(key), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  function logChat(key, entry) {
    const e = { at: new Date().toISOString(), ...entry };
    mkdirSync(dirname(chatPath(key)), { recursive: true });
    appendFileSync(chatPath(key), JSON.stringify(e) + "\n");
    emit("chat", { key, entry: e });
  }
  const metric = (m) => appendFileSync(join(stateDir, "metrics.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...m }) + "\n");
  const projectState = () => readJson(join(stateDir, "project.json"), { renders: [] });
  const saveProjectState = (s) => writeJson(join(stateDir, "project.json"), s);

  const mustScene = (id) => {
    const s = storyboard().scenes.find((x) => x.id === id);
    if (!s) throw new Error(`${id} is not a scene in ${name}`);
    return s;
  };

  async function commitProjectFiles(note, author) {
    const v = await history.commitProject(["storyboard.json", "theme.css", "frame.md"].filter((f) => existsSync(join(dir, f))), note, author);
    // Previews pick up the new storyboard/theme. Render clips stay: their names carry a hash
    // of everything that changes a scene's pixels.
    clearGeneratedBuilds();
    if (v) logChat("_project", { role: "system", text: `Project v${v}: ${note}` });
    emit("project");
    return v;
  }

  // ---------- builds and stills ----------
  // Video files are served under /p/<project>/<video>/...
  const base = `${encodeURIComponent(project)}/${encodeURIComponent(video)}`;
  const size = () => ({ width: storyboard().width ?? 1920, height: storyboard().height ?? 1080 });
  const rel = (p) => `/p/${base}/` + p.slice(dir.length + 1);
  const stillsDir = (id, v) => join(stateDir, "stills", id, `v${v}`);

  const narrationDir = join(dir, "assets", "narration");
  const narrationExts = ["mp3", "wav", "m4a"];
  const narrationFiles = (id) => narrationExts.map((ext) => join(narrationDir, `${id}.${ext}`));
  const narrationWordsFile = (id) => join(narrationDir, `${id}.words.json`);
  async function probeSeconds(file) {
    const output = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
    const seconds = Number(output.trim());
    if (!Number.isFinite(seconds)) throw new Error(`ffprobe returned no duration for ${file}`);
    return seconds; // as ffprobe prints it (microseconds): rounding to the millisecond here pushed 65.36667 s over a frame boundary
  }
  // Next to the audio, <id>.take.json records the narration text the take was made from, so a
  // later script edit marks the audio stale (re-voice the changed scenes in one look at
  // list_scenes). Audio set before this existed has stale: null.
  const takeFile = (id) => join(narrationDir, `${id}.take.json`);
  const narrationHash = (text) => createHash("sha1").update(String(text ?? "")).digest("hex");
  async function narrationAudio(id) {
    const scene = mustScene(id);
    const file = narrationFiles(id).find((candidate) => existsSync(candidate));
    if (!file) return null;
    const take = readJson(takeFile(id), null);
    const stale = take?.narrationHash ? take.narrationHash !== narrationHash(scene.narration) : null;
    return { file, url: rel(file), seconds: await probeSeconds(file), stale, takenAt: take?.at ?? null };
  }
  function narrationWordsInfo(id) {
    mustScene(id);
    const file = narrationWordsFile(id);
    if (!existsSync(file)) return null;
    const words = JSON.parse(readFileSync(file, "utf8"));
    return { count: words.length, lastEnd: words.length ? words.at(-1).end : null };
  }

  async function sceneBuild(id, v) {
    const bn = `${id}-v${v}`;
    const out = join(dir, ".build", bn);
    if (!existsSync(join(out, "index.html"))) buildScene(dir, storyboard(), id, await history.fileAt(id, v), bn);
    return out;
  }

  const stillJobs = new Map(); // "id:v" -> promise, so two callers don't snapshot the same version twice
  function makeVersionStills(id, v) {
    const key = `${id}:${v}`;
    if (stillJobs.has(key)) return stillJobs.get(key);
    const job = (async () => {
      const sc = storyboard().scenes.find((s) => s.id === id);
      const out = stillsDir(id, v);
      if (!sc || (existsSync(out) && readdirSync(out).some((f) => f.endsWith(".png")))) return;
      emit("stills", { id, v, state: "running" });
      try {
        await snapshot(await sceneBuild(id, v), versionTimes(sc.duration), out, size());
      } catch (e) {
        emit("toast", { text: `Stills for ${id} v${v} failed: ${e.message.slice(0, 200)}` });
      }
      emit("stills", { id, v, state: "done" });
    })().finally(() => stillJobs.delete(key));
    stillJobs.set(key, job);
    return job;
  }

  // Installed fonts the version's text is drawn in (see fontProbe in lib/render.mjs), from
  // its stills; null when they predate the check. fontsFor() runs the check when needed.
  const fontsOf = (id, v) => readJson(join(stillsDir(id, v), "fonts.json"), null)?.system ?? null;
  async function fontsFor(id, v) {
    const known = fontsOf(id, v);
    if (known) return known;
    const sc = storyboard().scenes.find((s) => s.id === id);
    const system = await systemFonts(await sceneBuild(id, v), versionTimes(sc.duration), size());
    mkdirSync(stillsDir(id, v), { recursive: true });
    writeFileSync(join(stillsDir(id, v), "fonts.json"), JSON.stringify({ system }, null, 1));
    return system;
  }

  function listStills(id, v) {
    const d = stillsDir(id, v);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .map((f) => ({ f, m: f.match(/^frame-\d+-at-([\d.]+)s\.png$/) }))
      .filter((x) => x.m)
      .map((x) => ({ t: Number(x.m[1]), file: join(d, x.f), url: rel(join(d, x.f)) }))
      .sort((a, b) => a.t - b.t);
  }

  const commentStillPath = (id, cid) => join(stateDir, "comments", id, `${cid}.png`);
  async function makeCommentStill(id, c) {
    const out = commentStillPath(id, c.id);
    if (existsSync(out)) return out;
    const tmp = join(stateDir, "comments", id, `${c.id}-raw`);
    const [shot] = await snapshot(await sceneBuild(id, c.version), [c.t], tmp, size());
    await annotate(shot.file, c.region, out, storyboard());
    return out;
  }

  // ---------- hand edits ----------
  // Files changed on disk outside the app (an editor, a terminal agent) become a version
  // before the next build, so nothing is lost or misattributed.
  async function commitManualEdits(only) {
    for (const s of storyboard().scenes) {
      if (only && s.id !== only) continue;
      const v = await history.commitScene(s.id, "manual edit", reviewer);
      if (v) {
        const st = sceneState(s.id);
        st.versions[v] = { agent: "manual", at: new Date().toISOString() };
        saveSceneState(s.id, st);
        logChat(s.id, { role: "system", text: `Edit on disk saved as v${v}.` });
        makeVersionStills(s.id, v).then(() => emit("project"));
      }
    }
  }

  // ---------- whole video and render jobs ----------
  // Every scene's latest version: that is what the whole video and the render use.
  async function wholeHtml() {
    const sb = storyboard();
    const map = {};
    const picked = {};
    for (const s of sb.scenes) {
      const vs = await history.versions(s.id);
      const v = vs.at(-1).v;
      picked[s.id] = v;
      map[s.id] = await history.fileAt(s.id, v);
    }
    return { map, picked };
  }

  const jobs = new Map(); // render jobs for this process; finished renders also land in .state/project.json
  let running = null;
  const jobView = (j) => j && { job: j.id, state: j.state, pct: j.pct, picked: j.picked, clips: j.clips, worker: j.worker ?? null, startedAt: j.startedAt, ms: j.ms, file: j.file ? j.file.split("/").pop() : null, path: j.file, url: j.state === "done" ? `/renders/${base}/${j.file.split("/").pop()}` : null, error: j.error };

  // A scene's clip is cached under .build/clips/<id>-v<version>-<key>.mp4. The key hashes
  // what else changes its pixels (theme, size, background, fps, length and where its frames
  // fall on the video's frame grid, the clock, and the assets the scene or the theme refers
  // to), so an unchanged scene is never rendered twice, a theme change re-renders every scene,
  // and a replaced asset re-renders the scenes that use it (not all 17, as hashing the whole
  // assets/ folder did).
  const CLOCK_ID = createHash("sha1").update(readFileSync(new URL("./clock.js", import.meta.url))).update(readFileSync(new URL("./anchor-core.js", import.meta.url))).update(readFileSync(new URL("./anchors.js", import.meta.url))).digest("hex");
  const ASSET_REF = /\bassets\/[^\s"'()<>?#]+/g;
  const referencedAssets = (...texts) => [...new Set(texts.flatMap((t) => (t ?? "").match(ASSET_REF) ?? []))].sort();
  function assetsId(refs) {
    const out = refs.map((p) => {
      const f = join(dir, p);
      if (!existsSync(f) || !statSync(f).isFile()) return [p, null];
      const st = statSync(f);
      return [p, st.size, Math.floor(st.mtimeMs)];
    });
    return createHash("sha1").update(JSON.stringify(out)).digest("hex");
  }
  function clipFile(s, v, html, sb, fps) {
    const words = readIf(narrationWordsFile(s.id));
    const wordsId = words == null ? null : createHash("sha1").update(words).digest("hex");
    const assets = assetsId(referencedAssets(html, sb.themeCss));
    const key = createHash("sha1").update(JSON.stringify([html, sb.themeCss, sb.width, sb.height, sb.background, fps, frameSpan(s.start, s.duration, fps), s.duration, CLOCK_ID, assets, wordsId, s.narrationLead ?? 0.35, RENDER_ID])).digest("hex").slice(0, 8);
    return join(dir, ".build", "clips", `${s.id}-v${v}-${key}.mp4`);
  }
  const clipKey = (...a) => clipFile(...a).split("/").pop();

  async function render() {
    if (running) throw new Error(`A render is already running (job ${running.id})`);
    const { map, picked } = await wholeHtml();
    const sb = storyboard();
    if (!sb.scenes.length) throw new Error("the video has no scenes");
    const fps = sb.fps ?? FPS;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const file = join(rendersDir, `whole-${stamp}.mp4`);
    const job = { id: randomUUID().slice(0, 8), state: "running", pct: 0, picked, file, startedAt: new Date().toISOString(), ms: null, error: null, clips: null };
    jobs.set(job.id, job);
    running = job;
    const started = Date.now();
    emit("render", { state: "start", job: job.id, picked });
    const progress = (pct) => {
      pct = Math.floor(pct);
      if (pct === job.pct) return;
      job.pct = pct;
      emit("render", { state: "progress", job: job.id, pct });
    };
    // Frames are 90% of the bar, the join with crossfades and soundtrack the last 10%.
    const plan = sb.scenes.map((s, i) => ({ s, v: picked[s.id], frames: frameCount(s.duration, fps, s.start), fade: fadeIn(s, i), file: clipFile(s, picked[s.id], map[s.id], sb, fps) }));
    const todo = plan.filter((p) => !existsSync(p.file));
    const total = todo.reduce((a, p) => a + p.frames, 0);
    job.clips = { scenes: plan.length, rendered: todo.length, cached: plan.length - todo.length, remote: 0 };
    let done = 0, liveFrames = 0, staticFrames = 0;
    for (const p of todo) busyBuilds.add(join(dir, ".build", `${p.s.id}-v${p.v}`));
    // Frames done per clip, so a clip that fails on the worker and starts over here does
    // not count twice.
    const tick = (p, n) => {
      done += n - (p.done ?? 0);
      p.done = n;
      progress((done / total) * 90);
    };
    const opts = (p) => ({ duration: p.s.duration, start: p.s.start, fps, width: sb.width ?? 1920, height: sb.height ?? 1080 });
    const settle = (p) => { for (const f of readdirSync(dirname(p.file))) if (f.startsWith(`${p.s.id}-v${p.v}-`) && join(dirname(p.file), f) !== p.file) rmSync(join(dirname(p.file), f), { force: true }); };
    const here = async (p) => {
      let n = 0;
      tick(p, 0);
      const r = await renderClip(await sceneBuild(p.s.id, p.v), p.file, { ...opts(p), onFrame: () => tick(p, ++n), rebuild: () => sceneBuild(p.s.id, p.v) });
      liveFrames += r.live;
      staticFrames += r.static;
      settle(p);
    };
    (async () => {
      // One queue, longest clip first. Scenes with text in installed fonts never leave this
      // machine; with a worker awake, it takes all the others.
      const queue = [...todo].sort((a, b) => b.frames - a.frames);
      const worker = queue.length ? await findWorker() : null;
      const runners = [];
      if (worker) {
        job.worker = { url: worker.url, platform: worker.platform, parallel: worker.parallel };
        // Text in an installed font would come out in another font over there: those scenes
        // render here. A scene whose check fails counts as one.
        await Promise.all(queue.map(async (p) => (p.here = (await fontsFor(p.s.id, p.v).catch(() => [{ family: "?" }])).length > 0)));
        if (queue.some((p) => p.here)) job.worker.systemFonts = queue.filter((p) => p.here).map((p) => p.s.id);
        const key = mirrorKey(dir);
        const html = async (p) => readFileSync(join(await sceneBuild(p.s.id, p.v), "index.html"), "utf8");
        const synced = Promise.all(queue.map(html)).then((htmls) => syncFiles(worker, key, dir, filesFor(dir, htmls))).then((r) => (job.worker.synced = r));
        const remote = async () => {
          try {
            await synced;
          } catch (e) {
            worker.dead ??= String(e.message ?? e);
            return;
          }
          for (let i; !worker.dead && (i = queue.findIndex((p) => !p.here)) >= 0; ) {
            const p = queue.splice(i, 1)[0];
            try {
              const r = await remoteClip(worker, key, await html(p), p.file, opts(p), (n) => tick(p, n));
              liveFrames += r.live ?? r.frames;
              staticFrames += r.static ?? 0;
              job.clips.remote++;
              settle(p);
            } catch (e) {
              worker.dead ??= String(e.message ?? e);
              await here(p);
            }
          }
        };
        for (let i = 0; i < Math.max(2, Math.ceil((worker.parallel ?? 8) / 4)); i++) runners.push(remote());
      }
      // With a worker awake, this machine renders only the scenes that may not leave it: the
      // worker is several times faster, and frames here compete with everything else on the
      // server (WebGL scenes timed out under load). What the worker leaves when it drops out
      // is rendered here afterwards.
      const take = (all) => {
        if (!worker || all) return queue.shift();
        const i = queue.findIndex((p) => p.here);
        return i >= 0 ? queue.splice(i, 1)[0] : undefined;
      };
      const local = async (all) => { for (let p; (p = take(all)); ) await here(p); };
      runners.push(local(), local());
      await Promise.all(runners);
      if (queue.length) await Promise.all([local(true), local(true)]);
      if (worker?.dead) job.worker.error = worker.dead.slice(-300);
      const joinStart = Date.now();
      await joinClips(plan, file, { fps, soundtrack: sb.soundtrack ? join(dir, sb.soundtrack) : null, onProgress: (f) => progress(90 + f * 10) });
      job.joinMs = Date.now() - joinStart;
    })().then(
      () => finish(null),
      (e) => finish(e),
    );
    function finish(err) {
      running = null;
      for (const p of todo) busyBuilds.delete(join(dir, ".build", `${p.s.id}-v${p.v}`));
      const ok = !err && existsSync(file);
      job.ms = Date.now() - started;
      job.state = ok ? "done" : "failed";
      job.pct = ok ? 100 : job.pct;
      job.error = ok ? null : String(err?.message ?? err).slice(-600);
      const ps = projectState();
      if (ok) ps.renders.unshift({ file: file.split("/").pop(), picked, at: new Date().toISOString(), ms: job.ms });
      saveProjectState(ps);
      metric({ kind: "render", renderer: "own", ok, ms: job.ms, joinMs: job.joinMs, frames: plan.reduce((a, p) => a + p.frames, 0), renderedFrames: total, liveFrames, staticFrames, clips: job.clips, worker: job.worker ?? null, picked, ...(ok ? {} : { error: job.error }) });
      if (!ok) writeFileSync(join(rendersDir, "last-render-error.log"), String(err?.stack ?? err));
      emit("render", { state: job.state, job: job.id, file: ok ? jobView(job).url : null, error: job.error });
      emit("project");
    }
    return jobView(job);
  }

  const getRender = (id) => {
    if (id) {
      if (!jobs.has(id)) throw new Error(`No render job ${id} in this server process`);
      return jobView(jobs.get(id));
    }
    const last = [...jobs.values()].at(-1);
    return { latest: jobView(last) ?? null, renders: projectState().renders.map((r) => ({ ...r, url: `/renders/${base}/${r.file}`, path: join(rendersDir, r.file) })) };
  };

  // Delete finished renders: the named files, or with keep: n every render but the newest n.
  // The mp4 of a running job is never in the list, so it cannot be named. Files go, nothing is
  // versioned.
  function deleteRenders({ files, keep, model } = {}) {
    const ps = projectState();
    const wanted = keep != null ? ps.renders.slice(Math.max(0, Number(keep))).map((r) => r.file) : (files ?? []).map((f) => String(f).split("/").pop());
    if (!wanted.length) return { deleted: [], freedBytes: 0 };
    const missing = wanted.filter((f) => !ps.renders.some((r) => r.file === f));
    if (missing.length) throw new Error(`no render ${missing.join(", ")}`);
    let freedBytes = 0;
    for (const f of wanted) {
      const file = join(rendersDir, f);
      if (existsSync(file)) (freedBytes += statSync(file).size), rmSync(file, { force: true });
    }
    ps.renders = ps.renders.filter((r) => !wanted.includes(r.file));
    saveProjectState(ps);
    metric({ kind: "render-deleted", files: wanted, bytes: freedBytes });
    logChat("_project", { role: "system", text: `${model ?? "Renders menu"} deleted ${wanted.length === 1 ? wanted[0] : `${wanted.length} renders`} (${(freedBytes / 1e6).toFixed(0)} MB).` });
    emit("project");
    return { deleted: wanted, freedBytes };
  }

  // ---------- views ----------
  async function view() {
    const sb = storyboard();
    const scenes = [];
    for (const s of sb.scenes) {
      const st = sceneState(s.id);
      const vs = await history.versions(s.id);
      const audio = await narrationAudio(s.id);
      const words = narrationWordsInfo(s.id);
      scenes.push({
        ...s,
        audio: audio ? { seconds: audio.seconds, url: audio.url, stale: audio.stale, takenAt: audio.takenAt } : null,
        words,
        recordAgain: recordAgain(s),
        comments: st.comments.map((c) => ({ ...c, still: existsSync(commentStillPath(s.id, c.id)) ? rel(commentStillPath(s.id, c.id)) : null })),
        versions: vs.map((x) => ({ ...x, ...(st.versions[x.v] ?? { agent: x.v === 1 ? "import" : "?" }), stills: listStills(s.id, x.v).map(({ t, url }) => ({ t, url })) })),
      });
    }
    const ps = projectState();
    return {
      project, video, name, title: sb.title, duration: sb.duration, fps: sb.fps ?? FPS, soundtrack: sb.soundtrack, music: sb.music ?? null, musicLibrary: sb.musicLibrary ?? null, scenes,
      // changes whenever storyboard.json or theme.css does; the page keys its preview on it
      stamp: createHash("sha1").update(JSON.stringify(sb)).digest("hex").slice(0, 8),
      renders: ps.renders.map((r) => ({ ...r, url: `/renders/${base}/${r.file}` })),
      rendering: !!running,
    };
  }

  const rules = () => ({ agents: readIf(join(dir, "AGENTS.md")), design: readIf(join(dir, "frame.md")), theme: readIf(join(dir, "theme.css")), sceneContract: SCENE_CONTRACT });
  const files = () => ({ storyboard: readIf(join(dir, "storyboard.json")), theme: readIf(join(dir, "theme.css")), design: readIf(join(dir, "frame.md")) });

  // The data-at anchors in a scene's html that do not land on a heard word: not found (the
  // CSS time is used), heard only as a near spelling, or an alternative used. Without
  // narration words every anchor is a fallback. The same matching as the page (anchor-core.js).
  function anchorWarnings(s) {
    const html = readIf(join(dir, "scenes", s.id, "scene.html")) ?? "";
    const specs = [...html.matchAll(/\bdata-at="([^"]+)"/g)].flatMap((m) => m[1].trim().split(/\s+/));
    if (!specs.length) return [];
    const words = readJson(narrationWordsFile(s.id), null);
    if (!words) return [{ spec: specs.join(" "), warning: "no narration words for this scene: every anchor keeps its CSS time" }];
    return specs.flatMap((spec) => {
      const r = anchorCore.at(words, s.narrationLead ?? 0.35, spec, null);
      return r.warnings.length ? [{ spec, t: r.t, resolved: r.resolved, warning: r.warnings.join("; ") }] : [];
    });
  }

  async function listScenes() {
    const cues = cuesOf(storyboard().scenes);
    const sceneCues = (id) => cues.filter((c) => c.scene === id).map(({ scene, file, own, ...c }) => c);
    const missingAssets = (id) => [...new Set(readFileSync(join(dir, "scenes", id, "scene.html"), "utf8").match(/\bassets\/clips\/[^\s"'()<>?#]+/g) ?? [])].filter((path) => !existsSync(join(dir, path)));
    return (await view()).scenes.map((s) => ({ id: s.id, title: s.title, start: s.start, duration: s.duration, narration: s.narration, ...(s.narrationWritten != null ? { narrationWritten: s.narrationWritten } : {}), audio: s.audio, recordAgain: s.recordAgain, words: s.words, picture: s.picture, latest: s.versions.at(-1)?.v, pendingComments: s.comments.filter((c) => c.status === "pending").map(({ id, version, t, region, text, by }) => ({ id, version, t, region, text, by })), missingAssets: missingAssets(s.id), anchorWarnings: anchorWarnings(s), sfx: sceneCues(s.id), sfxWarnings: sceneCues(s.id).filter((c) => c.warning).map(({ cue, t, warning }) => ({ cue, t, warning })), systemFonts: s.versions.length ? fontsOf(s.id, s.versions.at(-1).v) : null }));
  }

  // Pending comments with their annotated still. Missing stills are made on the spot.
  async function pending() {
    const out = [];
    for (const s of storyboard().scenes) {
      for (const c of sceneState(s.id).comments.filter((c) => c.status === "pending")) {
        let file = null;
        try {
          file = await makeCommentStill(s.id, c);
        } catch {}
        out.push({ scene: s.id, id: c.id, version: c.version, t: c.t, region: c.region, text: c.text, by: c.by, still: file ? rel(file) : null, file });
      }
    }
    return out;
  }

  // ---------- mutations ----------
  async function setMeta(b) {
    const sb = storyboard();
    for (const k of ["title", "language", "width", "height", "background", "accent", "soundtrack", "music"]) if (b[k] !== undefined) sb[k] = b[k];
    // musicDb: how far under the voice the bed sits, in dB (default 15.5). Kristian found 15.5
    // too loud under his own voice on 2026-10-22; the level is a per-video choice from then on.
    if (b.musicDb !== undefined) {
      if (b.musicDb === null) delete sb.musicDb;
      else if (!(Number(b.musicDb) >= 0 && Number(b.musicDb) <= 60)) throw new Error("musicDb: dB under the voice, 0 to 60 (default 15.5), or null for the default");
      else sb.musicDb = Number(b.musicDb);
    }
    // musicLibrary: the library item storyboard.music was copied from (use_library_music). A
    // plain path from set_video is not from the library, so the record goes with it.
    if (b.musicLibrary !== undefined) sb.musicLibrary = b.musicLibrary;
    else if (b.music !== undefined) delete sb.musicLibrary;
    if (!sb.music) delete sb.musicLibrary;
    saveStoryboard(sb);
    const version = await commitProjectFiles(b.note ?? "project settings", b.model ?? "chat");
    const camClips = b.width !== undefined || b.height !== undefined ? await recutCams() : [];
    return { version, ...(camClips.length ? { camClips } : {}) };
  }

  async function createScene(b) {
    const sb = storyboard();
    const id = b.id ?? `s${String(sb.scenes.length + 1).padStart(2, "0")}-${slug(b.title ?? "scene")}`;
    if (!/^[a-z][\w-]*$/.test(id)) throw new Error("scene id must start with a letter (a-z) and use a-z, 0-9, - or _");
    if (sb.scenes.some((s) => s.id === id) || existsSync(join(dir, "scenes", id))) throw new Error(`${id} already exists`);
    const scene = { id, title: b.title ?? id, start: 0, duration: Number(b.duration) || 4, transitionIn: b.transitionIn ?? null, narration: b.narration ?? "", picture: b.picture ?? "" };
    const at = b.after ? sb.scenes.findIndex((s) => s.id === b.after) + 1 : sb.scenes.length;
    sb.scenes.splice(at || sb.scenes.length, 0, scene);
    saveStoryboard(sb);
    mkdirSync(join(dir, "scenes", id), { recursive: true });
    writeFileSync(join(dir, "scenes", id, "scene.html"), b.html ?? starterScene(id, storyboard(), scene.title));
    const v = await history.commitScene(id, `created by ${b.model ?? "chat"}`, b.model ?? "chat");
    const st = sceneState(id);
    st.versions[v] = { agent: b.model ?? "chat", via: b.via, note: "created", at: new Date().toISOString() };
    saveSceneState(id, st);
    await commitProjectFiles(`add scene ${id}`, b.model ?? "chat");
    makeVersionStills(id, v).then(() => emit("project"));
    return { id, version: v, soundtrackWarning: sb.soundtrack ? "Scene starts moved; the soundtrack was not re-cut." : null };
  }

  async function updateScene(id, b) {
    const sb = storyboard();
    const s = sb.scenes.find((x) => x.id === id);
    if (!s) throw new Error(`${id} is not a scene`);
    for (const k of ["title", "duration", "narration", "picture", "transitionIn"]) if (b[k] !== undefined) s[k] = k === "duration" ? Number(b[k]) : b[k];
    if (b.narrationWritten === null) delete s.narrationWritten;
    saveStoryboard(sb);
    const version = await commitProjectFiles(b.note ?? `edit ${id} details`, b.model ?? "chat");
    const synced = b.duration !== undefined ? await syncDataDuration([id], b.model ?? "chat") : [];
    const camClips = b.duration !== undefined ? await recutCams([id]) : [];
    // A recorded scene whose line changed keeps its take in the video until it is recorded again.
    const audio = b.narration !== undefined ? await narrationAudio(id) : null;
    const recordAgain = audio?.stale ? { recordAgain: `${id} changed since its take; the old take stays in the video until the scene is recorded again (or keep_take for a spelling fix).` } : {};
    return { version, sceneVersions: synced, ...(camClips.length ? { camClips } : {}), ...recordAgain };
  }

  // The storyboard owns a scene's duration; the html's data-duration is kept equal to it so a
  // file read on its own tells the truth (the assembled page drops the attribute anyway). A
  // changed attribute is a scene version like any edit. Returns [{ scene, version }].
  async function syncDataDuration(ids, agent) {
    const sb = storyboard();
    const out = [];
    for (const id of ids) {
      const s = sb.scenes.find((x) => x.id === id);
      const file = join(dir, "scenes", id, "scene.html");
      if (!s || !existsSync(file)) continue;
      const html = readFileSync(file, "utf8");
      const next = html.replace(/(<div[^>]*\bid="root"[^>]*\bdata-duration=")[^"]*(")/, `$1${s.duration}$2`);
      if (next === html) continue;
      const r = await writeSceneHtml(id, { html: next, model: agent, note: `duration ${s.duration} s` }, "duration");
      out.push({ scene: id, version: r.version });
    }
    return out;
  }

  // internal.narrationHash: the hash of the text the take was read from (a camera take), instead
  // of the script as it is now; internal.take: its number. Not reachable from the tool's arguments.
  async function setNarrationAudio(id, b, internal = {}) {
    mustScene(id);
    if (!!b.path === !!b.base64) throw new Error("Pass exactly one of path or base64");
    if (b.path && !isAbsolute(b.path)) throw new Error("path must be an absolute path on the server");
    const inferred = b.path ? extname(b.path).slice(1) : "";
    const ext = String(b.ext || inferred).toLowerCase().replace(/^\./, "");
    if (!narrationExts.includes(ext)) throw new Error("ext must be mp3, wav or m4a");
    let data;
    if (b.path) {
      if (!existsSync(b.path) || !statSync(b.path).isFile()) throw new Error(`${b.path} is not a file`);
      data = readFileSync(b.path);
    } else {
      const encoded = String(b.base64 ?? "").replace(/\s/g, "");
      if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("base64 is not valid base64 file content");
      data = Buffer.from(encoded, "base64");
    }
    mkdirSync(narrationDir, { recursive: true });
    const target = join(narrationDir, `${id}.${ext}`);
    const tmp = join(narrationDir, `.${id}-${randomUUID()}.${ext}`);
    const previous = narrationFiles(id).filter((file) => existsSync(file));
    writeFileSync(tmp, data);
    try {
      await probeSeconds(tmp);
      for (const file of previous) rmSync(file, { force: true });
      renameSync(tmp, target);
      writeJson(takeFile(id), { narrationHash: internal.narrationHash ?? narrationHash(mustScene(id).narration), at: new Date().toISOString(), note: b.note ?? null, ...(internal.take ? { take: internal.take } : {}) });
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    // Audio is not a history version (binary, replaced often); the chat log records it.
    logChat("_project", { role: "system", text: `${b.model ?? "chat"} set narration audio for ${id}${b.note ? `: ${b.note}` : ""}.` });
    emit("project");
    return { scene: id, audio: await narrationAudio(id) };
  }

  async function removeNarrationAudio(id) {
    mustScene(id);
    const files = narrationFiles(id);
    const removed = files.filter((file) => existsSync(file));
    for (const file of removed) rmSync(file, { force: true });
    rmSync(takeFile(id), { force: true });
    if (removed.length) { logChat("_project", { role: "system", text: `Narration audio for ${id} removed.` }); emit("project"); }
    return { scene: id, audio: null, removed: removed.length > 0 };
  }

  // The audio is a recorded take (choose_take), not a voice service's rendering of the script.
  const fromTake = (tj) => tj?.take != null || /^take \d+$/.test(tj?.note ?? "");

  // adopt (the default when the audio is a recorded take): the scene's narration becomes what
  // the take says (lib/words.mjs), the line as written before is kept as narrationWritten (the
  // Script view shows the difference), and the audio and the chosen take are marked as read from
  // the new text, so the adoption does not make its own take stale.
  const setNarrationWords = (id, b) => locked(`takes:${id}`, () => setNarrationWordsNow(id, b));
  async function setNarrationWordsNow(id, b) {
    const scene = mustScene(id);
    const tj = readJson(takeFile(id), null);
    const adopt = b.adopt ?? fromTake(tj);
    const script = b.script === undefined ? (scene.narration ?? "") : b.script;
    // A recorded take: its restarts and fillers are found too (lib/words.mjs), with the take's
    // own levels for the pauses.
    const take = adopt && fromTake(tj) ? takesOf(id).takes.find((t) => t.chosen && t.n === tj.take) : null;
    const room = take ? await roomOf(id, take) : null;
    const r = convertNarrationWords({ words: b.words, scribe: b.scribe, whisper: b.whisper, script, adopt, edits: !!room, pause: room?.pause });
    let { words } = r;
    mkdirSync(narrationDir, { recursive: true });
    writeFileSync(narrationWordsFile(id), JSON.stringify(words, null, 2) + "\n");
    clearGeneratedBuilds();
    const edits = room ? await editTake(id, take, room, r, { cut: b.cut !== false, model: b.model }) : null;
    if (edits?.applied) words = readJson(narrationWordsFile(id), words);
    let adopted = null;
    if (adopt) {
      // Adopting again on the same audio compares with the line the take was read from, not with
      // the first adoption.
      const written = tj?.written ?? scene.narration ?? "";
      const sb = storyboard();
      const s = sb.scenes.find((x) => x.id === id);
      const changed = r.text !== (scene.narration ?? "");
      s.narration = r.text;
      if (r.text !== written) s.narrationWritten = written;
      else delete s.narrationWritten;
      saveStoryboard(sb);
      const version = await commitProjectFiles(`${id}: narration adopted from the take`, b.model ?? "chat");
      markCurrent(id, r.text, { written });
      adopted = { narration: r.text, written, changed, changes: r.changes, version };
    }
    if (edits?.flagged.length) await flagTake(id, edits.flagged);
    logChat("_project", { role: "system", text: `${b.model ?? "chat"} set narration words for ${id}${adopted?.changed ? `; the script now says what the take says (${r.changes.length} change${r.changes.length === 1 ? "" : "s"})` : ""}.` });
    emit("project");
    return { scene: id, words, count: words.length, lastEnd: words.at(-1)?.end ?? null, ...(adopt ? { adopted } : { unmatched: r.unmatched }), ...(edits ? { edits: { cut: edits.cut, flagged: edits.flagged, ...(edits.proposed ? { proposed: edits.proposed } : {}), keep: edits.keep, ...(edits.applied ? { next: "The audio and the camera clip were cut and the words re-timed: fit_scenes_to_narration with this scene, then build_soundtrack." } : {}) } } : {}), ...warningsOf(id) };
  }

  // The narration audio's levels against the take's threshold: pause(lo, hi) is the longest
  // stretch under it between two times (narration seconds).
  async function roomOf(id, take) {
    const audio = await narrationAudio(id);
    if (!audio) return null;
    const samples = await samplesOf(audio.file, 16000);
    const dbs = windowsDb(samples, 16000);
    const thr = take.level?.thresholdDb ?? threshold(levels(samples, 16000));
    const pause = (lo, hi) => {
      let best = 0;
      for (let i = Math.max(0, Math.floor(lo / WINDOW)), from = null; i <= Math.min(dbs.length, Math.ceil(hi / WINDOW)); i++) {
        if (i < dbs.length && i < Math.ceil(hi / WINDOW) && dbs[i] < thr) from ??= i;
        else if (from != null) (best = Math.max(best, (i - from) * WINDOW)), (from = null);
      }
      return best;
    };
    return { samples, dbs, thr, seconds: audio.seconds, pause };
  }

  // What the take says that the video should not (restarts and filler words the transcript
  // has, voiced hums it has not), cut out of the take where it does not show: at the start or
  // the end of the speech, or where the scene does not show the camera clip at that moment (a
  // jump cut shows full frame and picture-in-picture alike). Where it shows, it is flagged for
  // a new take instead. cut: false only proposes. Times: take seconds (from, to) and scene
  // seconds (at).
  async function editTake(id, take, room, r, { cut: apply = true, model } = {}) {
    const segments = segmentsOf(take);
    let kept = r.words;
    const removals = r.removed.map((x) => ({ kind: x.kind, text: x.text, start: x.start, end: Math.min(x.end, r.transcript[x.to - 1].start + 0.6) }));
    // A false start the transcript merged into the line: its words move to where they were said
    // again, and the start goes.
    const merged = r.removed.some((x) => x.from === 0) ? null : mergedFalseStart(room.dbs, room.thr, kept);
    if (merged) {
      kept = [...merged.moved, ...kept.slice(merged.moved.length)];
      writeFileSync(narrationWordsFile(id), JSON.stringify(kept, null, 2) + "\n");
      removals.push({ kind: "restart", text: `${merged.text}… (said again)`, start: 0, end: merged.end, from: 0, to: merged.end });
    }
    for (const hum of hums(room.samples, 16000, room.thr, r.transcript)) if (!removals.some((x) => hum.start < x.end && hum.end > x.start)) removals.push({ kind: "filler", text: "(hum)", start: hum.start, end: hum.end, hum: true });
    removals.sort((a, b) => a.start - b.start);
    if (!removals.length) return null;
    const lead = mustScene(id).narrationLead ?? 0.35;
    const spans = removals.map((x) => {
      if (x.from != null) return { ...x, edge: true };
      const prev = kept.findLast((w) => w.start < x.start - 1e-3), next = kept.find((w) => w.start >= x.end - 1e-3 && w.start > x.start);
      const prevEnd = prev ? Math.min(prev.end, prev.start + 0.6, x.start) : 0;
      const from = prev ? cutPoint(room.dbs, room.thr, x.hum ? Math.max(prevEnd, x.start - 0.5) : prevEnd, x.start + (x.hum ? 0.02 : 0.1), "start") : 0;
      const to = next ? cutPoint(room.dbs, room.thr, x.hum ? x.end - 0.02 : Math.max(from, x.end - 0.1), x.hum ? Math.min(next.start, x.end + 0.5) : next.start + 0.05, "end") : room.seconds;
      return { ...x, from, to: Math.max(from, to), edge: !prev || !next };
    });
    // Is the camera on screen anywhere in the stretch? The scene as it is now, words included.
    const middle = spans.filter((x) => !x.edge);
    if (middle.length) {
      const v = (await history.versions(id)).at(-1).v;
      const times = middle.flatMap((x) => [x.from, (x.from + x.to) / 2, x.to].map((t) => r3(lead + t)));
      const seen = await camVisible(await sceneBuild(id, v), times, `cam/${id}.mp4`, size());
      middle.forEach((x, i) => (x.visible = seen.slice(i * 3, i * 3 + 3).some((s) => s.visible)));
    }
    // Overlapping cuts are one cut.
    const cuts = spans.filter((x) => !x.visible).sort((a, b) => a.from - b.from).reduce((out, x) => {
      const last = out.at(-1);
      if (last && x.from <= last.to) (last.to = Math.max(last.to, x.to)), (last.text += `, ${x.text}`);
      else out.push({ ...x });
      return out;
    }, []);
    const keep = keepRanges(segments, cuts.map((x) => ({ from: x.from, to: x.to })));
    const at = (t) => toTake(t, segments);
    const cut = cuts.map((x) => ({ kind: x.kind, text: x.text, from: at(x.from), to: at(x.to) }));
    let applied = false;
    if (apply && cuts.length) {
      await chooseTakeNow(id, take.n, { keep: keep.map((k) => [k.from, k.to]), model }, { edits: { cut, at: new Date().toISOString() } });
      applied = true;
    }
    // The flagged ones where they now sit in the scene.
    const now = applied ? keep : segments;
    const flagged = spans.filter((x) => x.visible).map((x) => {
      const t = r3(lead + (fromTakeTime(at(x.start), now) ?? x.start));
      return { kind: x.kind, text: x.text, at: t, from: at(x.from), to: at(x.to), reason: `${x.kind === "restart" ? `"${x.text}" said twice` : `${x.text === "(hum)" ? "a filler sound" : `"${x.text}"`}`} at ${t.toFixed(1)} s while you are on screen` };
    });
    if (!apply && cuts.length) {
      const list = takesOf(id), t = list.takes.find((x) => x.n === take.n);
      t.proposed = { keep: keep.map((k) => [k.from, k.to]), cut };
      writeJson(takesFile(id), list);
    }
    if (cuts.length || flagged.length) logChat("_project", { role: "system", text: `${id}: ${applied ? `cut ${cut.map((c) => `"${c.text}"`).join(", ")} out of take ${take.n}` : cuts.length ? `proposed cutting ${cut.map((c) => `"${c.text}"`).join(", ")}` : "nothing cut"}${flagged.length ? `; record again: ${flagged.map((f) => f.reason).join("; ")}` : ""}.` });
    return { applied, cut, flagged, keep: (applied ? keep : segments).map((k) => [k.from, k.to]), ...(!apply && cuts.length ? { proposed: keep.map((k) => [k.from, k.to]) } : {}) };
  }

  // A take's flags: kept with it, and a comment by scene-loop on the scene at each one, so it
  // shows in the comment list. A flag already there (same words, same place) keeps its comment.
  async function flagTake(id, flagged) {
    const list = takesOf(id), take = list.takes.find((t) => t.chosen);
    if (!take) return;
    const old = take.edits?.flagged ?? [];
    for (const f of flagged) {
      const same = old.find((o) => o.text === f.text && Math.abs(o.at - f.at) < 0.3 && o.comment);
      f.comment = same?.comment ?? (await addComment(id, { t: f.at, text: `Record again: ${f.reason}. Cutting it would show as a jump.` }, "scene-loop")).id;
    }
    take.edits = { ...(take.edits ?? {}), flagged };
    writeJson(takesFile(id), list);
  }

  // A take that is no longer used, or kept as it is: its flag comments are done.
  function resolveFlags(id, take) {
    const ids = (take.edits?.flagged ?? []).map((f) => f.comment).filter(Boolean);
    if (!ids.length) return;
    const st = sceneState(id);
    for (const c of st.comments) if (ids.includes(c.id) && c.status === "pending") Object.assign(c, { status: "sent", sentAt: new Date().toISOString(), note: "take replaced or kept" });
    saveSceneState(id, st);
  }

  // Why a scene should be recorded again: its line changed since the take, and what the
  // chosen take says on camera that could not be cut.
  function recordAgain(s) {
    const out = [];
    const tj = readJson(takeFile(s.id), null);
    if (tj?.narrationHash && tj.narrationHash !== narrationHash(s.narration) && narrationFiles(s.id).some((f) => existsSync(f))) out.push("the line changed since the take");
    const chosen = existsSync(takesFile(s.id)) ? takesOf(s.id).takes.find((t) => t.chosen) : null;
    for (const f of chosen?.edits?.flagged ?? []) out.push(f.reason);
    return out;
  }

  // The narration audio (take.json) and the chosen take that made it count as read from text.
  function markCurrent(id, text, extra = {}) {
    const hash = narrationHash(text);
    const tj = readJson(takeFile(id), null);
    writeJson(takeFile(id), { ...(tj ?? { at: new Date().toISOString(), note: null }), ...extra, narrationHash: hash });
    const list = takesOf(id);
    const chosen = list.takes.find((t) => t.chosen);
    if (chosen && (tj?.take == null || tj.take === chosen.n)) {
      chosen.narrationHash = hash;
      writeJson(takesFile(id), list);
    }
  }

  // "Keep the take": the script of a recorded scene changed only in spelling (a typo, a name), so
  // the audio stays and counts as current again. The words keep their times and take the new
  // spelling; words in the script that the take does not have come back in unmatched.
  const keepTake = (id, b = {}) => locked(`takes:${id}`, () => keepTakeNow(id, b));
  async function keepTakeNow(id, { model, force = false } = {}) {
    const scene = mustScene(id);
    const audio = await narrationAudio(id);
    if (!audio) throw new Error(`${id} has no narration audio to keep`);
    const list = takesOf(id), chosen = list.takes.find((t) => t.chosen);
    const flags = chosen?.edits?.flagged?.length ? chosen.edits.flagged : null;
    if (flags) {
      // Kept as it is, what it says on camera included.
      resolveFlags(id, chosen);
      chosen.edits = { ...chosen.edits, flagged: [], kept: flags.map((f) => f.reason) };
      writeJson(takesFile(id), list);
    }
    if (audio.stale === false) {
      if (flags) emit("project");
      return { scene: id, kept: !!flags, ...(flags ? { flagsKept: flags.map((f) => f.reason) } : { note: "The take already matches the script." }), ...warningsOf(id) };
    }
    const old = readJson(narrationWordsFile(id), null);
    // Only a spelling fix may keep the take: the same words in the same order, each changed one
    // a near spelling. Added or removed words mean the video says something else; record again.
    if (!force) {
      const why = spellingOnly(old?.map((w) => w.word) ?? null, scene.narration ?? "");
      if (why) throw new Error(`${id}: ${why} Record the scene again, or pass force: true to keep the take anyway.`);
    }
    let unmatched = [];
    if (old?.length) {
      const r = convertNarrationWords({ words: old, script: scene.narration ?? "" });
      writeFileSync(narrationWordsFile(id), JSON.stringify(r.words, null, 2) + "\n");
      unmatched = r.unmatched;
      clearGeneratedBuilds();
    }
    markCurrent(id, scene.narration ?? "");
    logChat("_project", { role: "system", text: `${model ?? "chat"} kept the take for ${id} after a text fix.` });
    emit("project");
    return {
      scene: id, kept: true, unmatched,
      ...(unmatched.length ? { warning: `The take does not have ${unmatched.map((w) => `"${w}"`).join(", ")}: more than spelling changed, so record the scene again.` } : {}),
      ...warningsOf(id),
    };
  }

  // What a script or take change broke in a scene: data-at anchors and data-sfx cues that no
  // longer land on a heard word.
  function warningsOf(id) {
    const s = mustScene(id);
    return { anchorWarnings: anchorWarnings(s), sfxWarnings: cuesOf([s]).filter((c) => c.warning).map(({ cue, t, warning }) => ({ cue, t, warning })) };
  }

  function removeNarrationWords(id) {
    mustScene(id);
    const file = narrationWordsFile(id), removed = existsSync(file);
    rmSync(file, { force: true });
    if (removed) { clearGeneratedBuilds(); logChat("_project", { role: "system", text: `Narration words for ${id} removed.` }); emit("project"); }
    return { scene: id, words: null, removed };
  }

  async function fitScenesToNarration({ lead = 0.35, tail = 0.6, scenes, model } = {}) {
    lead = Number(lead);
    tail = Number(tail);
    if (!Number.isFinite(lead) || lead < 0 || !Number.isFinite(tail) || tail < 0) throw new Error("lead and tail must be non-negative seconds");
    const sb = storyboard();
    const fps = Number(sb.fps ?? FPS);
    if (scenes != null && !Array.isArray(scenes)) throw new Error("scenes must be an array of scene ids");
    const wanted = scenes == null ? null : new Set(scenes);
    if (wanted && scenes.some((id) => !sb.scenes.some((s) => s.id === id))) throw new Error("scenes must contain existing scene ids");
    const fitted = [];
    for (const scene of sb.scenes) {
      if (wanted && !wanted.has(scene.id)) continue;
      const audio = await narrationAudio(scene.id);
      if (!audio) continue;
      const oldDuration = scene.duration;
      const oldLead = scene.narrationLead;
      // Up to the frame grid, with a tolerance of a thousandth of a frame: 65.366667 s of audio is
      // 1961 frames, not 1962, although 65.366667 * 30 is a hair over 1961 in floating point.
      const newDuration = Math.ceil((lead + audio.seconds + tail) * fps - 1e-3) / fps;
      scene.duration = newDuration;
      scene.narrationLead = lead;
      fitted.push({ scene: scene.id, audioSeconds: audio.seconds, oldDuration, newDuration, narrationLead: lead, changed: oldDuration !== newDuration || oldLead !== lead, durationChanged: oldDuration !== newDuration });
    }
    saveStoryboard(sb);
    const version = await commitProjectFiles("fit scenes to narration", model ?? "chat");
    const changed = fitted.filter((s) => s.durationChanged).map((s) => s.scene);
    const sceneVersions = await syncDataDuration(changed, model ?? "chat");
    const camClips = await recutCams(fitted.map((s) => s.scene));
    return {
      lead,
      tail,
      fps,
      scenes: fitted,
      version,
      sceneVersions,
      camClips,
      note: changed.length ? `Durations changed for ${changed.join(", ")}; their data-duration was updated.` : "No scene durations changed.",
    };
  }

  // The cues of every scene (data-sfx), resolved against its words and lead. leads: { id: lead }
  // for scenes whose lead is about to change (build_soundtrack); the others use their own.
  function cuesOf(scenes, leads = {}) {
    return videoCues(dir, scenes, (s) => ({ html: readIf(join(dir, "scenes", s.id, "scene.html")) ?? "", words: readJson(narrationWordsFile(s.id), null), lead: leads[s.id] ?? s.narrationLead ?? 0.35 }));
  }

  // The voice: every scene's narration `lead` seconds into its scene, normalised to `loudness`.
  // Over it the sound effects (data-sfx cues, kit level = 11 dB under a -16 LUFS voice, gain per
  // cue on top) and storyboard.music as a bed storyboard.musicDb (default 15.5) dB under the
  // voice, faded in over 1 s and out over 2 s. A video with cues or music but no narration still gets a soundtrack.
  const musicDbOf = (sb) => (Number.isFinite(Number(sb.musicDb)) ? Number(sb.musicDb) : 15.5);
  async function buildSoundtrack({ lead = 0.35, loudness = -16, model } = {}) {
    lead = Number(lead);
    const keepLevel = loudness === false || loudness === null || loudness === "off"; // a recut of an original recording keeps its mix
    loudness = keepLevel ? null : Number(loudness);
    if (!Number.isFinite(lead) || lead < 0) throw new Error("lead must be non-negative seconds");
    if (!keepLevel && !Number.isFinite(loudness)) throw new Error("loudness must be a number in LUFS, or \"off\" to keep the source level");
    const sb = storyboard();
    if (!sb.scenes.length || !(sb.duration > 0)) throw new Error("the video has no duration");
    const audio = [];
    for (const scene of sb.scenes) audio.push(await narrationAudio(scene.id));
    const leads = Object.fromEntries(sb.scenes.flatMap((s, i) => (audio[i] ? [[s.id, lead]] : [])));
    const allCues = cuesOf(sb.scenes, leads);
    const cues = allCues.filter((c) => c.file && c.at != null && c.at < sb.duration);
    const musicFile = sb.music ? join(dir, sb.music) : null;
    if (musicFile && !existsSync(musicFile)) throw new Error(`storyboard.music: ${sb.music} is not a file`);
    const args = ["-nostdin", "-y", "-hide_banner", "-loglevel", "error"];
    for (const item of audio) if (item) args.push("-i", item.file);
    let input = 0;
    const filters = [];
    for (let i = 0; i < sb.scenes.length; i++) {
      const scene = sb.scenes[i];
      if (audio[i]) {
        filters.push(`[${input++}:a]aformat=sample_rates=48000:channel_layouts=mono,adelay=${Math.round(lead * 1000)}:all=1,apad,atrim=duration=${scene.duration},asetpts=N/SR/TB[p${i}]`);
      } else {
        filters.push(`anullsrc=r=48000:cl=mono,atrim=duration=${scene.duration},asetpts=N/SR/TB[p${i}]`);
      }
    }
    filters.push(`${sb.scenes.map((_, i) => `[p${i}]`).join("")}concat=n=${sb.scenes.length}:v=0:a=1[voice]`);
    const voiced = audio.some(Boolean);
    // loudnorm hands its frames on with timestamps that put the voice 30 to 70 ms late in the
    // m4a (a WAV hides it: it ignores timestamps); the voice is re-stamped from its samples.
    filters.push(`[voice]atrim=duration=${sb.duration}${keepLevel || !voiced ? "" : `,loudnorm=I=${loudness}:TP=-2:LRA=9,aresample=48000,asetpts=N/SR/TB`}[v]`);
    const mix = ["[v]"];
    for (const [j, c] of cues.entries()) {
      args.push("-i", c.file);
      const gain = c.gainDb + (c.own ? SFX_LEVEL - ((await momentaryMax(c.file)) ?? SFX_LEVEL) : 0);
      filters.push(`[${input++}:a]aformat=sample_rates=48000:channel_layouts=mono,volume=${Math.round(gain * 100) / 100}dB,adelay=${Math.round(c.at * 1000)}:all=1[c${j}]`);
      mix.push(`[c${j}]`);
    }
    if (musicFile) {
      const level = (keepLevel ? -16 : loudness) - musicDbOf(sb);
      args.push("-stream_loop", "-1", "-i", musicFile);
      filters.push(`[${input++}:a]aformat=sample_rates=48000:channel_layouts=mono,loudnorm=I=${level}:TP=-8:LRA=7,aresample=48000,atrim=duration=${sb.duration},asetpts=N/SR/TB,afade=t=in:d=1,afade=t=out:st=${Math.max(0, sb.duration - 2)}:d=2[m]`);
      mix.push("[m]");
    }
    filters.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:normalize=0:duration=first:dropout_transition=0,alimiter=limit=0.95:level=0:attack=1[out]` : "[v]anull[out]");
    const output = join(dir, "assets", "narration.m4a");
    const tmp = join(dir, "assets", ".narration.part.m4a");
    mkdirSync(dirname(output), { recursive: true });
    rmSync(tmp, { force: true });
    args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-t", String(sb.duration), "-ar", "48000", "-ac", "1", "-c:a", "aac", "-b:a", "192k", tmp);
    try {
      await exec("ffmpeg", args);
      renameSync(tmp, output);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    sb.scenes.forEach((scene, index) => { if (audio[index]) scene.narrationLead = lead; });
    sb.soundtrack = "assets/narration.m4a";
    saveStoryboard(sb);
    const version = await commitProjectFiles("soundtrack from narration", model ?? "chat");
    logChat("_project", { role: "system", text: `Soundtrack built from narration (${sb.duration} s${cues.length ? `, ${cues.length} sound effect${cues.length === 1 ? "" : "s"}` : ""}${musicFile ? `, music ${musicDbOf(sb)} dB under the voice` : ""}).` });
    const camClips = await recutCams();
    emit("project");
    const overruns = sb.scenes.flatMap((scene, i) => {
      const overrun = audio[i] ? lead + audio[i].seconds - scene.duration : 0;
      return overrun > 1e-3 ? [{ scene: scene.id, overrun: Math.round(overrun * 1000) / 1000 }] : []; // not the rounding of a frame-fitted scene
    });
    return {
      file: output,
      url: rel(output),
      seconds: sb.duration,
      lead,
      loudness,
      overruns,
      sfx: cues.map(({ scene, cue, at, sound, gainDb }) => ({ scene, cue, at, sound, gainDb })),
      sfxWarnings: allCues.filter((c) => c.warning).map(({ scene, cue, t, at, warning }) => ({ scene, cue, t, at, warning })),
      music: sb.music ?? null,
      camClips,
      version,
    };
  }

  // ---------- takes (narration read to camera in the Record view) ----------
  // assets/takes/<id>/<n>.<ext>, every one kept, and takes.json with what was found in each
  // (length, speech range, levels, the hash of the narration it was read from) and which one is
  // chosen. Choosing one writes the scene's narration audio through setNarrationAudio (so
  // take.json, the chat log and audio.stale work as for any audio) and assets/cam/<id>.mp4.
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const takesDir = (id) => join(dir, "assets", "takes", id);
  const takesFile = (id) => join(takesDir(id), "takes.json");
  const takesOf = (id) => readJson(takesFile(id), { takes: [], cam: null });
  const camRel = (id) => `assets/cam/${id}.mp4`;
  const TAKE_EXT = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mp4": "m4a", "audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3" };
  const TAKE_MAX = 4 * 1024 * 1024 * 1024;

  function takeView(id, t) {
    const scene = mustScene(id);
    return {
      n: t.n, url: rel(join(dir, t.file)), path: join(dir, t.file), createdAt: t.createdAt, seconds: t.seconds, hasVideo: t.hasVideo, width: t.width, height: t.height, devices: t.devices ?? null,
      speech: t.speech, cut: t.cut ?? null, segments: t.segments?.length > 1 ? t.segments : null, level: t.level, chosen: !!t.chosen, stale: t.narrationHash !== narrationHash(scene.narration),
      ...(t.edits ? { edits: t.edits } : {}), ...(t.proposed ? { proposed: t.proposed } : {}),
    };
  }

  // A new take, from the page's upload (stream + content type) or a file on the server (path).
  const addTake = (id, b) => locked(`takes:${id}`, () => addTakeNow(id, b));
  async function addTakeNow(id, { stream, mime, path, model, devices }) {
    const scene = mustScene(id);
    const type = String(mime ?? "").split(";")[0].trim().toLowerCase();
    const ext = path ? extname(path).slice(1).toLowerCase() : TAKE_EXT[type];
    if (!ext || !Object.values(TAKE_EXT).includes(ext)) throw new Error(`a take is mp4, webm, mov, m4a, wav or mp3${type ? `, not ${type}` : ""}`);
    if (path && (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile())) throw new Error(`${path} is not an absolute path to a file`);
    const list = takesOf(id);
    const n = Math.max(0, ...list.takes.map((t) => t.n)) + 1;
    mkdirSync(takesDir(id), { recursive: true });
    const file = join(takesDir(id), `${n}.${ext}`);
    const tmp = join(takesDir(id), `.${n}-${randomUUID()}.${ext}`);
    try {
      if (path) copyFileSync(path, tmp);
      else {
        let bytes = 0;
        const limit = new Transform({ transform(chunk, enc, next) { bytes += chunk.length; next(bytes > TAKE_MAX ? new Error("the take is over 4 GB") : null, chunk); } });
        await pipeline(stream, limit, createWriteStream(tmp));
        if (!bytes) throw new Error("the take is empty");
      }
      const a = await analyzeTake(tmp);
      renameSync(tmp, file);
      const take = { n, file: `assets/takes/${id}/${n}.${ext}`, createdAt: new Date().toISOString(), seconds: a.seconds, hasVideo: a.hasVideo, width: a.width, height: a.height, fps: a.fps, narrationHash: narrationHash(scene.narration), speech: a.speech, level: a.level, ...(devices?.camera || devices?.mic ? { devices } : {}), chosen: false };
      list.takes.push(take);
      writeJson(takesFile(id), list);
      metric({ kind: "take", scene: id, take: n, seconds: a.seconds, speech: a.speech && r3(a.speech.end - a.speech.start) });
      logChat("_project", { role: "system", text: `${model ?? "Record view"}: take ${n} for ${id} (${a.seconds.toFixed(1)} s${a.speech ? `, speech ${a.speech.start.toFixed(2)} to ${a.speech.end.toFixed(2)} s` : ", no speech found"}).` });
      emit("project");
      return { scene: id, take: takeView(id, take) };
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  // Delete takes that are not in use: the numbered ones, or every take but the chosen one (unused),
  // for one scene or (no scene) for every scene. The chosen take is never deleted: choose
  // another first. Numbers are not reused.
  const deleteTakes = (id, b = {}) => (id ? locked(`takes:${id}`, () => deleteTakesNow(id, b)) : deleteAllUnused(b));
  function deleteTakesNow(id, { takes, unused, model } = {}) {
    mustScene(id);
    const list = takesOf(id);
    const wanted = unused ? list.takes.filter((t) => !t.chosen).map((t) => t.n) : (takes ?? []).map(Number);
    if (!wanted.length) return { scene: id, deleted: [], freedBytes: 0 };
    const missing = wanted.filter((n) => !list.takes.some((t) => t.n === n));
    if (missing.length) throw new Error(`${id} has no take ${missing.join(", ")}`);
    const chosen = list.takes.find((t) => t.chosen && wanted.includes(t.n));
    if (chosen) throw new Error(`take ${chosen.n} is the one ${id} uses; choose another take before deleting it`);
    let freedBytes = 0;
    for (const n of wanted) {
      const t = list.takes.find((x) => x.n === n), file = join(dir, t.file);
      if (existsSync(file)) (freedBytes += statSync(file).size), rmSync(file, { force: true });
    }
    list.takes = list.takes.filter((t) => !wanted.includes(t.n));
    writeJson(takesFile(id), list);
    metric({ kind: "take-deleted", scene: id, takes: wanted, bytes: freedBytes });
    logChat("_project", { role: "system", text: `${model ?? "Record view"} deleted take ${wanted.join(", ")} of ${id} (${(freedBytes / 1e6).toFixed(0)} MB).` });
    emit("project");
    return { scene: id, deleted: wanted, freedBytes };
  }
  async function deleteAllUnused({ model } = {}) {
    const out = [];
    for (const s of storyboard().scenes) if (takesOf(s.id).takes.some((t) => !t.chosen)) out.push(await locked(`takes:${s.id}`, () => deleteTakesNow(s.id, { unused: true, model })));
    return { scenes: out, freedBytes: out.reduce((a, r) => a + r.freedBytes, 0) };
  }

  // The chosen take becomes the scene's narration and camera clip. speechStart/speechEnd (take
  // seconds) correct the detected speech range.
  // keep: [[from, to], ...] take seconds, the ranges the narration is made of (a restart or a
  // filler left out), joined with a crossfade; the camera clip makes the same cuts. Without it,
  // the speech range. Choosing the same take again keeps its narration words, re-timed through
  // the new cuts (words in a range cut out go); another take's words are removed.
  // internal.edits: what an adoption cut, recorded with the take.
  const segmentsOf = (t) => (t.segments?.length ? t.segments : t.cut ? [t.cut] : null);
  const chooseTake = (id, n, b = {}) => locked(`takes:${id}`, () => chooseTakeNow(id, Number(n), b));
  async function chooseTakeNow(id, n, { speechStart, speechEnd, keep, model } = {}, internal = {}) {
    mustScene(id);
    const list = takesOf(id);
    const take = list.takes.find((t) => t.n === n);
    if (!take) throw new Error(`${id} has no take ${n}${list.takes.length ? ` (takes: ${list.takes.map((t) => t.n).join(", ")})` : ""}`);
    let segments;
    if (keep != null) {
      if (!Array.isArray(keep) || !keep.length || keep.some((k) => !Array.isArray(k) || k.length !== 2)) throw new Error("keep is a list of [from, to] ranges in take seconds");
      segments = keep.map(([a, b]) => ({ from: r3(Number(a)), to: r3(Number(b)) }));
      if (segments.some((s, i) => !(s.from >= 0 && s.to > s.from && s.to <= take.seconds + 1e-3 && (!i || s.from >= segments[i - 1].to)))) throw new Error(`keep ranges must lie within the take (0 to ${take.seconds} s), each start before its end, in order and not overlapping`);
    } else {
      if (speechStart != null || speechEnd != null) {
        const start = Number(speechStart ?? take.speech?.start ?? 0), end = Number(speechEnd ?? take.speech?.end ?? take.seconds);
        if (!(start >= 0 && end > start && end <= take.seconds + 1e-3)) throw new Error(`speechStart and speechEnd must lie within the take (0 to ${take.seconds} s), start before end`);
        take.speech = { start: r3(start), end: r3(end), auto: false };
      }
      if (!take.speech) throw new Error(`No speech found in take ${n} of ${id}; pass speechStart and speechEnd (take seconds), or keep`);
      segments = [cutRange(take.speech, take.seconds)];
    }
    const cut = { from: segments[0].from, to: segments.at(-1).to };
    const before = readJson(takeFile(id), null);
    const oldWords = before?.take === n && take.chosen ? readJson(narrationWordsFile(id), null) : null;
    const oldSegments = segmentsOf(take);
    const tmp = join(narrationDir, `.take-${id}-${randomUUID()}.wav`);
    let audio;
    try {
      await cutNarration(join(dir, take.file), { segments, floorDb: take.level?.floorDb }, tmp);
      audio = (await setNarrationAudio(id, { path: tmp, note: `take ${n}${segments.length > 1 ? `, ${segments.length} ranges` : ""}`, model: model ?? "Record view" }, { narrationHash: take.narrationHash, take: n })).audio;
    } finally {
      rmSync(tmp, { force: true });
    }
    let wordsRemoved = false, wordsKept = null;
    if (oldWords && oldSegments) {
      // The same take: each word where its time lands in the new cut, or gone with a cut range.
      const at = (t) => fromTakeTime(toTake(t, oldSegments), segments);
      wordsKept = oldWords.flatMap((w) => {
        const mid = at((w.start + w.end) / 2);
        if (mid == null) return [];
        const start = at(w.start) ?? mid, end = at(w.end) ?? mid;
        return [{ ...w, start: Math.min(start, mid), end: Math.max(end, mid) }];
      });
      writeFileSync(narrationWordsFile(id), JSON.stringify(wordsKept, null, 2) + "\n");
      clearGeneratedBuilds();
    } else {
      // Words timed on another take would put every anchor in the wrong place.
      wordsRemoved = existsSync(narrationWordsFile(id)) && removeNarrationWords(id).removed;
    }
    const previous = list.takes.find((t) => t.chosen && t !== take);
    if (previous) resolveFlags(id, previous);
    for (const t of list.takes) t.chosen = t === take;
    take.chosenAt = new Date().toISOString();
    take.cut = cut;
    take.segments = segments;
    if (internal.edits) take.edits = internal.edits;
    else delete take.edits;
    delete take.proposed;
    writeJson(takesFile(id), list);
    metric({ kind: "take-chosen", scene: id, take: n, of: list.takes.length });
    const cam = take.hasVideo ? await cutCamNow(id, true) : (rmSync(join(dir, camRel(id)), { force: true }), null);
    emit("project");
    return {
      scene: id,
      take: takeView(id, take),
      audio: audio && { path: audio.file, url: audio.url, seconds: audio.seconds, stale: audio.stale },
      cam,
      wordsRemoved,
      ...(wordsKept ? { wordsKept: wordsKept.length } : {}),
      next: wordsKept ? "The words were re-timed to the new cut; fit_scenes_to_narration and build_soundtrack." : `Transcribe ${audio?.file} with ElevenLabs Scribe and pass the raw JSON to set_narration_words; then fit_scenes_to_narration and build_soundtrack.`,
    };
  }

  // assets/cam/<id>.mp4 from the chosen take: t=0 is the scene's t=0, narrationLead before the
  // narration cut starts, as long as the scene. Cut again only when what it was cut for
  // (take, lead, duration, size, fps) changed or the file is gone.
  async function cutCamNow(id, force = false) {
    const s = mustScene(id), sb = storyboard();
    const list = takesOf(id);
    const take = list.takes.find((t) => t.chosen);
    if (!take?.hasVideo || !take.cut) return null;
    const spec = { take: take.n, t0: r3(take.cut.from - (s.narrationLead ?? 0.35)), duration: s.duration, fps: sb.fps ?? FPS, ...size(), ...(take.segments?.length > 1 ? { segments: take.segments } : {}) };
    const file = join(dir, camRel(id));
    if (!force && existsSync(file) && JSON.stringify(list.cam?.spec) === JSON.stringify(spec)) return null;
    const r = await cutCam(join(dir, take.file), spec, file);
    list.cam = { spec, at: new Date().toISOString() };
    writeJson(takesFile(id), list);
    return { scene: id, file: r.file, url: rel(r.file), src: camRel(id), seconds: r.seconds, t0: spec.t0 };
  }

  // After a change to leads or durations: every scene whose cam clip no longer fits its scene.
  async function recutCams(ids = storyboard().scenes.map((s) => s.id)) {
    const out = [];
    for (const id of ids) {
      if (!existsSync(takesFile(id))) continue;
      try {
        const r = await locked(`takes:${id}`, () => cutCamNow(id));
        if (r) out.push(r);
      } catch (e) {
        out.push({ scene: id, error: e.message });
      }
    }
    if (out.length) logChat("_project", { role: "system", text: `Camera clips re-cut for ${out.map((r) => r.scene).join(", ")}.` });
    return out;
  }

  async function listTakes() {
    const out = [];
    for (const s of storyboard().scenes) {
      const list = takesOf(s.id);
      const chosen = list.takes.find((t) => t.chosen);
      const audio = chosen ? await narrationAudio(s.id) : null;
      const cam = join(dir, camRel(s.id));
      out.push({
        scene: s.id, title: s.title, narration: s.narration ?? "",
        takes: list.takes.map((t) => takeView(s.id, t)),
        chosen: chosen?.n ?? null,
        stale: chosen ? takeView(s.id, chosen).stale : null,
        recordAgain: recordAgain(s),
        audio: audio && { path: audio.file, url: audio.url, seconds: audio.seconds, stale: audio.stale },
        words: !!narrationWordsInfo(s.id),
        cam: existsSync(cam) ? { src: camRel(s.id), url: rel(cam), path: cam, cutFor: list.cam?.spec ?? null } : null,
      });
    }
    return out;
  }

  async function reorder(order, b = {}) {
    const sb = storyboard();
    const ids = sb.scenes.map((s) => s.id);
    if (!Array.isArray(order) || order.length !== ids.length || !ids.every((i) => order.includes(i))) throw new Error(`order must list every scene once: ${ids.join(", ")}`);
    sb.scenes = order.map((i) => sb.scenes.find((s) => s.id === i));
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? "reorder scenes", b.model ?? "chat") };
  }

  async function removeScene(id, b = {}) {
    const sb = storyboard();
    if (!sb.scenes.some((s) => s.id === id)) throw new Error(`${id} is not a scene`);
    if (sb.scenes.length === 1) throw new Error("can't remove the last scene");
    sb.scenes = sb.scenes.filter((s) => s.id !== id); // the folder and its versions stay on disk
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? `remove scene ${id} (files kept)`, b.model ?? "chat") };
  }

  async function setTheme(css, b = {}) {
    if (typeof css !== "string") throw new Error("css is required");
    writeFileSync(join(dir, "theme.css"), css);
    return { version: await commitProjectFiles(b.note ?? "theme.css", b.model ?? "chat") };
  }

  async function setDesign(markdown, b = {}) {
    if (typeof markdown !== "string") throw new Error("markdown is required");
    writeFileSync(join(dir, "frame.md"), markdown);
    return { version: await commitProjectFiles(b.note ?? "design spec", b.model ?? "chat") };
  }

  async function sceneHtml(id, v) {
    mustScene(id);
    return { id, version: v ? Number(v) : (await history.versions(id)).at(-1).v, html: v ? await history.fileAt(id, Number(v)) : readFileSync(join(dir, "scenes", id, "scene.html"), "utf8") };
  }

  // One write at a time per scene: the file write and its commit belong together, or two
  // concurrent writes commit one HTML under the other's name and lose the first.
  const locks = new Map();
  const locked = (key, fn) => {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    locks.set(key, run.catch(() => {}));
    return run;
  };

  // Every write is a version. via records the channel: webmcp, page-js, mcp or api.
  const writeSceneHtml = (id, b, via) => locked(id, () => writeSceneHtmlNow(id, b, via));
  async function writeSceneHtmlNow(id, b, via) {
    mustScene(id);
    if (typeof b.html !== "string" || !b.html.includes(`data-composition-id="${id}"`)) throw new Error(`html must keep the root data-composition-id="${id}"`);
    writeFileSync(join(dir, "scenes", id, "scene.html"), b.html);
    const agent = b.model || b.agent || "browser agent";
    const st = sceneState(id);
    const pend = st.comments.filter((c) => c.status === "pending" && (!b.resolves || b.resolves.includes(c.id)));
    const v = await history.commitScene(id, `${agent}: ${(b.note || pend[0]?.text || "edit").slice(0, 60)}`, agent);
    if (v) {
      for (const c of pend) Object.assign(c, { status: "sent", sentAt: new Date().toISOString(), result: v });
      st.versions[v] = { agent, via, comments: pend.map((c) => c.id), note: b.note, at: new Date().toISOString() };
      saveSceneState(id, st);
      logChat(id, { role: "system", text: `${agent} saved v${v}${b.note ? `: ${b.note}` : ""}.` });
      metric({ kind: "agent-write", scene: id, agent, via, newVersion: v, comments: pend.length });
      emit("project");
      makeVersionStills(id, v).then(() => emit("project"));
    }
    if (!v && b.resolves?.length) {
      const latest = (await history.versions(id)).at(-1).v;
      if (pend.length) {
        for (const c of pend) Object.assign(c, { status: "sent", sentAt: new Date().toISOString(), result: latest });
        saveSceneState(id, st);
        logChat(id, { role: "system", text: `${agent} resolved ${pend.length} comment${pend.length === 1 ? "" : "s"} on v${latest}, html unchanged.` });
        metric({ kind: "agent-write", scene: id, agent, via, newVersion: null, comments: pend.length, unchanged: true });
        emit("project");
      }
      return { version: latest, unchanged: true, resolved: pend.map((c) => c.id) };
    }
    return { version: v, unchanged: !v, resolved: v ? pend.map((c) => c.id) : [] };
  }

  // Stills of a scene. With times: a fresh snapshot of what is on disk, into .preview.
  // Without: the latest version's five stills (a disk edit becomes a version first).
  async function stills(id, times, version) {
    const sc = mustScene(id);
    if (!times?.length) {
      if (!version) await commitManualEdits(id);
      const v = version ?? (await history.versions(id)).at(-1).v;
      await makeVersionStills(id, v);
      return { scene: id, version: v, stills: listStills(id, v), systemFonts: fontsOf(id, v) };
    }
    // One preview snapshot per scene at a time: two get_stills calls rebuilt .preview/build under
    // a page that was still loading it.
    return locked(`preview:${id}`, async () => {
      const sceneDir = join(dir, "scenes", sc.id);
      const build = buildScene(dir, storyboard(), sc.id, readFileSync(join(sceneDir, "scene.html"), "utf8"), join(sceneDir, ".preview", "build"));
      const out = join(sceneDir, ".preview", "stills");
      rmSync(out, { recursive: true, force: true });
      const shots = (await snapshot(build, times, out, size())).map((s) => ({ t: s.t, file: s.file, url: rel(s.file) }));
      return { scene: id, version: null, stills: shots, systemFonts: readJson(join(out, "fonts.json"), null)?.system ?? null };
    });
  }

  // by is the person who wrote it and byId their id on the people list, both set by the
  // server (the logged-in person, or the page's reviewer); an agent's add_comment has none.
  async function addComment(id, b, by = null, byId = null) {
    mustScene(id);
    const version = b.version ?? (await history.versions(id)).at(-1).v;
    const st = sceneState(id);
    const c = { id: randomUUID().slice(0, 8), version, t: Number(b.t) || 0, region: b.region ?? null, text: String(b.text ?? "").trim(), ...(by ? { by } : {}), ...(byId ? { byId } : {}), status: "pending", createdAt: new Date().toISOString() };
    if (!c.text) throw new Error("text is required");
    if (c.text.length > 4000) throw new Error("A comment is 4000 characters at most.");
    st.comments.push(c);
    saveSceneState(id, st);
    makeCommentStill(id, c).then(() => emit("project"), () => {});
    emit("project");
    return c;
  }

  // onlyBy { id }: remove it only when that person wrote it (a commenter). A comment without
  // byId (from before the people list, or an agent's) is not theirs, whatever its name says.
  function deleteComment(id, cid, onlyBy = null) {
    const st = sceneState(id);
    const c = st.comments.find((c) => c.id === cid && c.status === "pending");
    if (c && onlyBy && (!c.byId || c.byId !== onlyBy.id)) throw new Error("You can only remove your own comments.");
    st.comments = st.comments.filter((x) => x !== c);
    saveSceneState(id, st);
    emit("project");
    return { ok: true };
  }


  async function restore(id, from) {
    mustScene(id);
    const v = await history.restore(id, from, reviewer);
    const st = sceneState(id);
    if (v) st.versions[v] = { agent: "restore", from, at: new Date().toISOString() };
    saveSceneState(id, st);
    logChat(id, { role: "system", text: v ? `Restored v${from} as v${v}.` : `v${from} is already what is on disk.` });
    metric({ kind: "restore", scene: id, from, newVersion: v });
    if (v) makeVersionStills(id, v).then(() => emit("project"));
    emit("project");
    return { v };
  }

  // ---------- previews for the page ----------
  async function sceneBuildUrl(id, v) {
    if (v === "disk") {
      buildScene(dir, storyboard(), id, readFileSync(join(dir, "scenes", id, "scene.html"), "utf8"), `${id}-disk`);
      return { url: rel(join(dir, ".build", `${id}-disk`, "index.html")) + `?ts=${Date.now()}` };
    }
    await sceneBuild(id, Number(v));
    return { url: rel(join(dir, ".build", `${id}-v${v}`, "index.html")) };
  }

  async function wholeBuildUrl() {
    await commitManualEdits();
    const { map, picked } = await wholeHtml();
    buildWhole(dir, storyboard(), map, "whole");
    return { url: rel(join(dir, ".build", "whole", "index.html")) + `?ts=${Date.now()}`, picked };
  }

  // Posters for the filmstrip: stills for every scene's latest version. Runs in the
  // background after open; cached stills make it a no-op.
  async function warm() {
    await commitManualEdits();
    for (const s of storyboard().scenes) {
      const vs = await history.versions(s.id);
      await makeVersionStills(s.id, vs.at(-1).v);
    }
    emit("project");
  }

  return {
    project, video, name, dir, rendersDir, storyboard, history, chat, view, rules, files, listScenes, pending,
    setMeta, createScene, updateScene, narrationAudio, setNarrationAudio, removeNarrationAudio, setNarrationWords, removeNarrationWords, fitScenesToNarration, buildSoundtrack, addTake, chooseTake, keepTake, deleteTakes, listTakes, recutCams, reorder, removeScene, setTheme, setDesign,
    sceneHtml, writeSceneHtml, stills, addComment, deleteComment, restore,
    render, getRender, deleteRenders, sceneBuildUrl, wholeBuildUrl, commitManualEdits, warm, clipKey,
  };
}
