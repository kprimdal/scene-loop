// One open video: its storyboard, version history (.history), state (.state), builds
// (.build), stills and renders. Everything a tool or a UI route does to a video goes
// through the object returned by openVideo, so the MCP endpoint and the page share it.
// (A video is what earlier versions called a project; names on disk stay as they were:
// project/vN tags for storyboard and theme versions, .state/project.json.)
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, renameSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createHistory } from "./history.mjs";
import { buildScene, buildWhole, fadeIn, FPS } from "./assemble.mjs";
import { snapshot, versionTimes, annotate } from "./stills.mjs";
import { renderClip, joinClips, frameCount, frameSpan } from "./render.mjs";
import { narrationWords as convertNarrationWords } from "./words.mjs";

export const SCENE_CONTRACT =
  "Each scene is scenes/<id>/scene.html: a <template> with a <style> and a root <div id=\"root\" data-composition-id=\"<id>\" data-width data-height data-duration>. Motion is CSS animations (or Web Animations from a <script> with el.animate()); times are seconds from the scene start, so an element that comes in at 1.2 s gets animation-delay: 1.2s. Use fill-mode both so the before and after states hold. When narration words exist, anchor to words instead of seconds: data-at=\"word:brush\", word:brush#2, sentence:2, offsets such as word:brush+0.3, alternatives such as word:noon|sentence:6+0.4, and one space-separated anchor per CSS animation. Code using el.animate() gets a scene-local second from window.__at[\"<id>\"](spec, fallback). A new narration take re-times these anchors; run fit_scenes_to_narration again if the audio length changed. The app's clock pauses every animation and seeks it to the frame being shown, so never rely on wall time: no setTimeout, setInterval, requestAnimationFrame loops, Date.now() or CSS transitions for motion. Something you draw yourself (canvas, a counter) registers window.__seek[\"<id>\"] = function (t) { ... } and draws the state at scene time t. Prefix element ids and @keyframes names with the scene id; ids and classes must not start with a digit. Scenes written for the old contract (one paused GSAP timeline in window.__timelines[\"<id>\"]) still play: the app loads GSAP for them and seeks the timeline, but write new scenes in CSS. Don't use HyperFrames skills or Studio; the app assembles and renders. theme.css is injected after every scene's styles, so project-wide changes (fonts, colours) go there; in the assembled page each scene's #root becomes a .scene element, so target .scene (with !important where a scene sets its own value).";

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

  const storyboard = () => ({ ...JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")), themeCss: readIf(join(dir, "theme.css")) });

  const scriptHash = (sb) => createHash("sha1").update(JSON.stringify(sb.scenes.map((s) => [s.id, s.narration ?? ""]))).digest("hex");
  function scriptStatus(sb = storyboard()) {
    const hash = scriptHash(sb);
    const agreed = sb.script;
    if (!agreed) {
      return {
        state: "not-agreed",
        hash,
        agreedHash: null,
        agreedAt: null,
        agreedBy: null,
        sentence: "Script not agreed: do not send narration to a paid voice service yet.",
      };
    }
    const unchanged = agreed.hash === hash;
    return {
      state: unchanged ? "agreed" : "changed",
      hash,
      agreedHash: agreed.hash,
      agreedAt: agreed.agreedAt,
      agreedBy: agreed.agreedBy,
      sentence: unchanged
        ? `Script agreed by ${agreed.agreedBy} at ${agreed.agreedAt}; render narration from it.`
        : `Script was agreed by ${agreed.agreedBy} at ${agreed.agreedAt} but has changed since: get it agreed again before paid narration.`,
    };
  }

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
  if (existsSync(join(dir, ".build"))) for (const f of readdirSync(join(dir, ".build"))) if (f !== "clips") rmSync(join(dir, ".build", f), { recursive: true, force: true });

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
    if (existsSync(join(dir, ".build"))) for (const f of readdirSync(join(dir, ".build"))) if (f !== "clips") rmSync(join(dir, ".build", f), { recursive: true, force: true });
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
    return Math.round(seconds * 1000) / 1000;
  }
  async function narrationAudio(id) {
    mustScene(id);
    const file = narrationFiles(id).find((candidate) => existsSync(candidate));
    if (!file) return null;
    return { file, url: rel(file), seconds: await probeSeconds(file) };
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
  const jobView = (j) => j && { job: j.id, state: j.state, pct: j.pct, picked: j.picked, clips: j.clips, startedAt: j.startedAt, ms: j.ms, file: j.file ? j.file.split("/").pop() : null, path: j.file, url: j.state === "done" ? `/renders/${base}/${j.file.split("/").pop()}` : null, error: j.error };

  // A scene's clip is cached under .build/clips/<id>-v<version>-<key>.mp4. The key hashes
  // what else changes its pixels (theme, size, background, fps, length and where its frames
  // fall on the video's frame grid, the clock, and the files in assets/), so an unchanged
  // scene is never rendered twice and a theme or asset change re-renders every scene.
  const CLOCK_ID = createHash("sha1").update(readFileSync(new URL("./clock.js", import.meta.url))).update(readFileSync(new URL("./anchors.js", import.meta.url))).digest("hex");
  function assetsId() {
    const root = join(dir, "assets");
    const out = [];
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const f = join(d, e.name);
        const key = f.slice(root.length + 1);
        if (key === "narration" || key === "narration.m4a") continue;
        if (e.isDirectory()) walk(f);
        else if (e.isFile()) { const st = statSync(f); out.push([f.slice(root.length), st.size, Math.floor(st.mtimeMs)]); }
      }
    };
    walk(root);
    return createHash("sha1").update(JSON.stringify(out)).digest("hex");
  }
  function clipFile(s, v, html, sb, fps, assets = assetsId()) {
    const words = readIf(narrationWordsFile(s.id));
    const wordsId = words == null ? null : createHash("sha1").update(words).digest("hex");
    const key = createHash("sha1").update(JSON.stringify([html, sb.themeCss, sb.width, sb.height, sb.background, fps, frameSpan(s.start, s.duration, fps), s.duration, CLOCK_ID, assets, wordsId, s.narrationLead ?? 0.35])).digest("hex").slice(0, 8);
    return join(dir, ".build", "clips", `${s.id}-v${v}-${key}.mp4`);
  }

  async function render() {
    if (running) throw new Error(`A render is already running (job ${running.id})`);
    const { map, picked } = await wholeHtml();
    const sb = storyboard();
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
    const assets = assetsId();
    const plan = sb.scenes.map((s, i) => ({ s, v: picked[s.id], frames: frameCount(s.duration, fps, s.start), fade: fadeIn(s, i), file: clipFile(s, picked[s.id], map[s.id], sb, fps, assets) }));
    const todo = plan.filter((p) => !existsSync(p.file));
    const total = todo.reduce((a, p) => a + p.frames, 0);
    job.clips = { scenes: plan.length, rendered: todo.length, cached: plan.length - todo.length };
    let done = 0;
    (async () => {
      await Promise.all(
        todo.map(async (p) => {
          await renderClip(await sceneBuild(p.s.id, p.v), p.file, { duration: p.s.duration, start: p.s.start, fps, width: sb.width ?? 1920, height: sb.height ?? 1080, onFrame: () => progress((++done / total) * 90) });
          for (const f of readdirSync(dirname(p.file))) if (f.startsWith(`${p.s.id}-v${p.v}-`) && join(dirname(p.file), f) !== p.file) rmSync(join(dirname(p.file), f), { force: true });
        }),
      );
      const joinStart = Date.now();
      await joinClips(plan, file, { fps, soundtrack: sb.soundtrack ? join(dir, sb.soundtrack) : null, onProgress: (f) => progress(90 + f * 10) });
      job.joinMs = Date.now() - joinStart;
    })().then(
      () => finish(null),
      (e) => finish(e),
    );
    function finish(err) {
      running = null;
      const ok = !err && existsSync(file);
      job.ms = Date.now() - started;
      job.state = ok ? "done" : "failed";
      job.pct = ok ? 100 : job.pct;
      job.error = ok ? null : String(err?.message ?? err).slice(-600);
      const ps = projectState();
      if (ok) ps.renders.unshift({ file: file.split("/").pop(), picked, at: new Date().toISOString(), ms: job.ms });
      saveProjectState(ps);
      metric({ kind: "render", renderer: "own", ok, ms: job.ms, joinMs: job.joinMs, frames: plan.reduce((a, p) => a + p.frames, 0), renderedFrames: total, clips: job.clips, picked, ...(ok ? {} : { error: job.error }) });
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
        audio: audio ? { seconds: audio.seconds, url: audio.url } : null,
        words,
        comments: st.comments.map((c) => ({ ...c, still: existsSync(commentStillPath(s.id, c.id)) ? rel(commentStillPath(s.id, c.id)) : null })),
        versions: vs.map((x) => ({ ...x, ...(st.versions[x.v] ?? { agent: x.v === 1 ? "import" : "?" }), stills: listStills(s.id, x.v).map(({ t, url }) => ({ t, url })) })),
      });
    }
    const ps = projectState();
    return {
      project, video, name, title: sb.title, duration: sb.duration, fps: sb.fps ?? FPS, soundtrack: sb.soundtrack, scenes,
      scriptStatus: scriptStatus(sb),
      // changes whenever storyboard.json or theme.css does; the page keys its preview on it
      stamp: createHash("sha1").update(JSON.stringify(sb)).digest("hex").slice(0, 8),
      renders: ps.renders.map((r) => ({ ...r, url: `/renders/${base}/${r.file}` })),
      rendering: !!running,
    };
  }

  const rules = () => ({ agents: readIf(join(dir, "AGENTS.md")), design: readIf(join(dir, "frame.md")), theme: readIf(join(dir, "theme.css")), sceneContract: SCENE_CONTRACT });
  const files = () => ({ storyboard: readIf(join(dir, "storyboard.json")), theme: readIf(join(dir, "theme.css")), design: readIf(join(dir, "frame.md")) });

  async function listScenes() {
    const missingAssets = (id) => [...new Set(readFileSync(join(dir, "scenes", id, "scene.html"), "utf8").match(/\bassets\/clips\/[^\s"'()<>?#]+/g) ?? [])].filter((path) => !existsSync(join(dir, path)));
    return (await view()).scenes.map((s) => ({ id: s.id, title: s.title, start: s.start, duration: s.duration, narration: s.narration, audio: s.audio, words: s.words, picture: s.picture, latest: s.versions.at(-1)?.v, pendingComments: s.comments.filter((c) => c.status === "pending").map(({ id, version, t, region, text }) => ({ id, version, t, region, text })), missingAssets: missingAssets(s.id) }));
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
        out.push({ scene: s.id, id: c.id, version: c.version, t: c.t, region: c.region, text: c.text, still: file ? rel(file) : null, file });
      }
    }
    return out;
  }

  // ---------- mutations ----------
  async function setMeta(b) {
    const sb = storyboard();
    for (const k of ["title", "language", "width", "height", "background", "accent", "soundtrack"]) if (b[k] !== undefined) sb[k] = b[k];
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? "project settings", b.model ?? "chat") };
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
    saveStoryboard(sb);
    return { version: await commitProjectFiles(b.note ?? `edit ${id} details`, b.model ?? "chat"), note: b.duration !== undefined ? "Also update data-duration in the scene's html." : null };
  }

  const narrationGate = () => {
    const status = scriptStatus();
    return { scriptStatus: status, ...(status.state === "agreed" ? {} : { warning: "Script not agreed: this audio may be paid for twice." }) };
  };

  async function setNarrationAudio(id, b) {
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
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    // Audio is not a history version (binary, replaced often); the chat log records it.
    logChat("_project", { role: "system", text: `${b.model ?? "chat"} set narration audio for ${id}${b.note ? `: ${b.note}` : ""}.` });
    emit("project");
    return { scene: id, audio: await narrationAudio(id), ...narrationGate() };
  }

  async function removeNarrationAudio(id) {
    mustScene(id);
    const files = narrationFiles(id);
    const removed = files.filter((file) => existsSync(file));
    for (const file of removed) rmSync(file, { force: true });
    if (removed.length) { logChat("_project", { role: "system", text: `Narration audio for ${id} removed.` }); emit("project"); }
    return { scene: id, audio: null, removed: removed.length > 0 };
  }

  function clearGeneratedBuilds() {
    if (existsSync(join(dir, ".build"))) for (const file of readdirSync(join(dir, ".build"))) if (file !== "clips") rmSync(join(dir, ".build", file), { recursive: true, force: true });
  }

  async function setNarrationWords(id, b) {
    const scene = mustScene(id);
    const { words, unmatched } = convertNarrationWords({ words: b.words, scribe: b.scribe, whisper: b.whisper, script: b.script === undefined ? scene.narration : b.script });
    mkdirSync(narrationDir, { recursive: true });
    writeFileSync(narrationWordsFile(id), JSON.stringify(words, null, 2) + "\n");
    clearGeneratedBuilds();
    logChat("_project", { role: "system", text: `${b.model ?? "chat"} set narration words for ${id}.` });
    emit("project");
    return { scene: id, words, count: words.length, lastEnd: words.at(-1)?.end ?? null, unmatched };
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
      const newDuration = Math.ceil((lead + audio.seconds + tail) * fps - 1e-9) / fps;
      scene.duration = newDuration;
      scene.narrationLead = lead;
      fitted.push({ scene: scene.id, audioSeconds: audio.seconds, oldDuration, newDuration, narrationLead: lead, changed: oldDuration !== newDuration || oldLead !== lead, durationChanged: oldDuration !== newDuration });
    }
    saveStoryboard(sb);
    const version = await commitProjectFiles("fit scenes to narration", model ?? "chat");
    const changed = fitted.filter((s) => s.durationChanged).map((s) => s.scene);
    return {
      lead,
      tail,
      fps,
      scenes: fitted,
      version,
      note: changed.length ? `Also update data-duration in the changed scene html: ${changed.join(", ")}.` : "No scene durations changed.",
    };
  }

  async function buildSoundtrack({ lead = 0.35, loudness = -16, model } = {}) {
    lead = Number(lead);
    loudness = Number(loudness);
    if (!Number.isFinite(lead) || lead < 0) throw new Error("lead must be non-negative seconds");
    if (!Number.isFinite(loudness)) throw new Error("loudness must be a number in LUFS");
    const sb = storyboard();
    if (!sb.scenes.length || !(sb.duration > 0)) throw new Error("the video has no duration");
    const audio = [];
    for (const scene of sb.scenes) audio.push(await narrationAudio(scene.id));
    const args = ["-nostdin", "-y", "-hide_banner", "-loglevel", "error"];
    for (const item of audio) if (item) args.push("-i", item.file);
    const filters = [];
    let input = 0;
    for (let i = 0; i < sb.scenes.length; i++) {
      const scene = sb.scenes[i];
      if (audio[i]) {
        filters.push(`[${input++}:a]aformat=sample_rates=48000:channel_layouts=mono,adelay=${Math.round(lead * 1000)}:all=1,apad,atrim=duration=${scene.duration},asetpts=N/SR/TB[p${i}]`);
      } else {
        filters.push(`anullsrc=r=48000:cl=mono,atrim=duration=${scene.duration},asetpts=N/SR/TB[p${i}]`);
      }
    }
    filters.push(`${sb.scenes.map((_, i) => `[p${i}]`).join("")}concat=n=${sb.scenes.length}:v=0:a=1[voice]`);
    filters.push(`[voice]atrim=duration=${sb.duration},loudnorm=I=${loudness}:TP=-2:LRA=9[out]`);
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
    logChat("_project", { role: "system", text: `Soundtrack built from narration (${sb.duration} s).` });
    emit("project");
    const overruns = sb.scenes.flatMap((scene, i) => {
      const overrun = audio[i] ? lead + audio[i].seconds - scene.duration : 0;
      return overrun > 0 ? [{ scene: scene.id, overrun: Math.round(overrun * 1000) / 1000 }] : [];
    });
    return {
      file: output,
      url: rel(output),
      seconds: sb.duration,
      lead,
      loudness,
      overruns,
      version,
      ...narrationGate(),
    };
  }

  async function toggleScriptAgreement() {
    const sb = storyboard();
    const current = scriptStatus(sb);
    if (current.state === "agreed") delete sb.script;
    else sb.script = { agreedAt: new Date().toISOString(), agreedBy: reviewer, hash: current.hash };
    saveStoryboard(sb);
    const version = await commitProjectFiles(current.state === "agreed" ? "script agreement cleared" : "script agreed", reviewer);
    return { version, scriptStatus: scriptStatus() };
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
      return { scene: id, version: v, stills: listStills(id, v) };
    }
    const sceneDir = join(dir, "scenes", sc.id);
    const build = buildScene(dir, storyboard(), sc.id, readFileSync(join(sceneDir, "scene.html"), "utf8"), join(sceneDir, ".preview", "build"));
    const out = join(sceneDir, ".preview", "stills");
    rmSync(out, { recursive: true, force: true });
    return { scene: id, version: null, stills: (await snapshot(build, times, out, size())).map((s) => ({ t: s.t, file: s.file, url: rel(s.file) })) };
  }

  async function addComment(id, b) {
    mustScene(id);
    const version = b.version ?? (await history.versions(id)).at(-1).v;
    const st = sceneState(id);
    const c = { id: randomUUID().slice(0, 8), version, t: Number(b.t) || 0, region: b.region ?? null, text: String(b.text ?? "").trim(), status: "pending", createdAt: new Date().toISOString() };
    if (!c.text) throw new Error("text is required");
    st.comments.push(c);
    saveSceneState(id, st);
    makeCommentStill(id, c).then(() => emit("project"), () => {});
    emit("project");
    return c;
  }

  function deleteComment(id, cid) {
    const st = sceneState(id);
    st.comments = st.comments.filter((c) => !(c.id === cid && c.status === "pending"));
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
    project, video, name, dir, rendersDir, storyboard, history, chat, view, rules, files, listScenes, pending, scriptStatus,
    setMeta, createScene, updateScene, narrationAudio, setNarrationAudio, removeNarrationAudio, setNarrationWords, removeNarrationWords, fitScenesToNarration, buildSoundtrack, toggleScriptAgreement, reorder, removeScene, setTheme, setDesign,
    sceneHtml, writeSceneHtml, stills, addComment, deleteComment, restore,
    render, getRender, sceneBuildUrl, wholeBuildUrl, commitManualEdits, warm,
  };
}
