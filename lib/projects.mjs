// The projects an instance serves and their videos. A project is a folder with project.md
// (instructions for the chat; frontmatter title and tags) and videos/<video>/, one folder
// per video (storyboard.json, scenes/, theme.css, frame.md and the app's own state).
//
// Two older layouts keep working as they are, with nothing moved:
// - `node server.mjs <dir>` on a folder with a storyboard.json: one project with one video,
//   both named after the folder.
// - a root whose folders have a storyboard.json: each is a project with one video of the
//   same name.
// In both, the project folder is the video folder, so project.md (if any) sits next to
// storyboard.json. Videos open lazily and stay open for the life of the process.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openVideo } from "./video.mjs";
import { createHistory } from "./history.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const TEMPLATE_DIR = join(appDir, "templates", "project");
const PROJECT_MD = join(appDir, "templates", "project.md");
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const isVideo = (d) => existsSync(join(d, "storyboard.json"));
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// The frontmatter we use: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines.
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
export function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(md ?? "");
  const meta = {};
  if (!m) return { meta, body: md ?? "" };
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      meta[key] = !v ? [] : v.startsWith("[") ? v.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean) : unquote(v);
    } else if (item && key && Array.isArray(meta[key])) meta[key].push(unquote(item[1]));
  }
  return { meta, body: md.slice(m[0].length) };
}
const tagsOf = (meta) => (Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === "string" ? meta.tags.split(",") : []).map((t) => String(t).trim()).filter(Boolean);

const starterMd = (title, tags) =>
  readFileSync(PROJECT_MD, "utf8")
    .replace(/^title: .*$/m, `title: ${JSON.stringify(title)}`)
    .replace(/^tags: .*$/m, `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`);

export function createRegistry(dir, { reviewer, emit }) {
  dir = resolve(dir);
  const single = isVideo(dir);
  const root = single ? dirname(dir) : dir;
  const open = new Map(); // "project/video" -> Promise<video>
  const histories = new Map(); // project -> Promise<history>, new layout only

  // { name, dir, legacy }: legacy means the project folder is its one video's folder.
  function info(name) {
    if (single) return name === basename(dir) ? { name, dir, legacy: true } : null;
    if (!NAME.test(name ?? "")) return null;
    const d = join(root, name);
    if (!existsSync(d) || !statSync(d).isDirectory()) return null;
    if (isVideo(d)) return { name, dir: d, legacy: true };
    if (existsSync(join(d, "project.md")) || existsSync(join(d, "videos"))) return { name, dir: d, legacy: false };
    return null;
  }

  function names() {
    if (single) return [basename(dir)];
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((n) => !n.startsWith(".") && info(n)).sort();
  }

  function project(name) {
    const pr = info(name);
    if (!pr) throw new Error(`No project "${name}". Projects: ${names().join(", ") || "(none; create one with create_project)"}`);
    return pr;
  }

  function videoNames(pr) {
    if (pr.legacy) return [pr.name];
    const vd = join(pr.dir, "videos");
    if (!existsSync(vd)) return [];
    return readdirSync(vd).filter((n) => NAME.test(n) && isVideo(join(vd, n))).sort();
  }
  const videoDir = (pr, v) => (pr.legacy ? pr.dir : join(pr.dir, "videos", v));

  // Where a video's files are, without opening it (for serving files).
  function dirOfVideo(projectName, videoName) {
    const pr = project(projectName);
    if (!videoNames(pr).includes(videoName)) throw new Error(`No video "${videoName}" in ${pr.name}`);
    return videoDir(pr, videoName);
  }

  function get(projectName, videoName) {
    const pr = project(projectName);
    const vids = videoNames(pr);
    if (!vids.includes(videoName)) throw new Error(`No video "${videoName}" in project ${pr.name}. Videos: ${vids.join(", ") || "(none; create one with create_video)"}`);
    const key = `${pr.name}/${videoName}`;
    if (!open.has(key)) {
      const p = openVideo(videoDir(pr, videoName), { project: pr.name, video: videoName, reviewer, emit }).then((v) => (v.warm().catch(() => {}), v));
      p.catch(() => open.delete(key));
      open.set(key, p);
    }
    return open.get(key);
  }

  // The project a call means: the one named, else the only one there is.
  function pickProject(name) {
    if (name) return project(name).name;
    const all = names();
    if (all.length === 1) return all[0];
    if (!all.length) throw new Error("No projects yet. Create one with create_project.");
    throw new Error(`Several projects; pass project (one of ${all.join(", ")}).`);
  }

  // The project and video a call means. Either may be left out when there is only one; a
  // video name alone is enough when exactly one project has a video of that name.
  function pick(projectName, videoName) {
    if (!projectName && videoName) {
      const owners = names().filter((n) => videoNames(info(n)).includes(videoName));
      if (owners.length === 1) return { project: owners[0], video: videoName };
    }
    const p = pickProject(projectName);
    if (videoName) return { project: p, video: videoName };
    const vids = videoNames(project(p));
    if (vids.length === 1) return { project: p, video: vids[0] };
    if (!vids.length) throw new Error(`Project ${p} has no videos yet. Create one with create_video.`);
    throw new Error(`Project ${p} has several videos; pass video (one of ${vids.join(", ")}).`);
  }

  const resolveVideo = (projectName, videoName) => {
    const r = pick(projectName, videoName);
    return get(r.project, r.video);
  };

  // ---------- project.md ----------
  // Saves are versions: in the project's own history (new layout: <project>/.history, with
  // videos/ left out) or, for an old-layout project, in its video's history. Tagged project/vN.
  async function historyOf(pr) {
    if (pr.legacy) return (await get(pr.name, pr.name)).history;
    if (!histories.has(pr.name)) {
      const h = createHistory(pr.dir, { exclude: ["videos/"] });
      const p = h.init([]).then(() => h);
      p.catch(() => histories.delete(pr.name));
      histories.set(pr.name, p);
    }
    return histories.get(pr.name);
  }

  const mdFile = (pr) => join(pr.dir, "project.md");
  function readMeta(pr) {
    const f = mdFile(pr);
    const markdown = existsSync(f) ? readFileSync(f, "utf8") : null;
    const { meta } = frontmatter(markdown);
    const firstTitle = pr.legacy ? readJson(join(pr.dir, "storyboard.json"))?.title : null;
    return { markdown, title: (typeof meta.title === "string" && meta.title) || firstTitle || pr.name, tags: tagsOf(meta) };
  }

  function instructions(projectName) {
    const pr = project(pickProject(projectName));
    const { markdown, title, tags } = readMeta(pr);
    // Without a project.md, the starter a new project gets, for the page to fill in.
    const starter = markdown == null ? starterMd(title, tags) : undefined;
    return { project: pr.name, title, tags, markdown, file: mdFile(pr), starter };
  }

  async function setInstructions(projectName, markdown, { note, model } = {}) {
    if (typeof markdown !== "string") throw new Error("markdown is required");
    const pr = project(pickProject(projectName));
    const history = await historyOf(pr); // first, so the file as it was is the "import" version
    writeFileSync(mdFile(pr), markdown.endsWith("\n") ? markdown : markdown + "\n");
    const version = await history.commitProject(["project.md"], note || "project instructions", model || "chat");
    emit("projects", { project: pr.name });
    const { title, tags } = readMeta(pr);
    return { project: pr.name, version, unchanged: !version, title, tags };
  }

  // ---------- listing ----------
  // Read from disk without opening the video: title, scenes, duration, a poster (the last
  // still of the first scene's newest stills) and the latest render.
  function videoSummary(pr, v) {
    const d = videoDir(pr, v);
    const base = `${encodeURIComponent(pr.name)}/${encodeURIComponent(v)}`;
    const sb = readJson(join(d, "storyboard.json")) ?? {};
    const scenes = sb.scenes ?? [];
    let poster = null;
    const sd = scenes[0] && join(d, ".state", "stills", scenes[0].id);
    if (sd && existsSync(sd)) {
      const vs = readdirSync(sd).filter((x) => /^v\d+$/.test(x)).sort((a, b) => b.slice(1) - a.slice(1));
      for (const x of vs) {
        const png = readdirSync(join(sd, x)).filter((f) => f.endsWith(".png")).sort((a, b) => parseFloat(a.split("-at-")[1]) - parseFloat(b.split("-at-")[1])).at(-1);
        if (png) { poster = `/p/${base}/.state/stills/${scenes[0].id}/${x}/${png}`; break; }
      }
    }
    const r = readJson(join(d, ".state", "project.json"))?.renders?.[0];
    return {
      name: v,
      title: sb.title ?? v,
      scenes: scenes.length,
      duration: sb.duration ?? scenes.reduce((a, s) => a + (s.duration ?? 0), 0),
      fps: sb.fps ?? 30,
      poster,
      latestRender: r ? { file: r.file, at: r.at, mode: r.mode, url: `/renders/${base}/${r.file}` } : null,
      dir: d,
    };
  }

  async function list() {
    return names().map((n) => {
      const pr = info(n);
      const { title, tags, markdown } = readMeta(pr);
      return { name: n, title, tags, instructions: markdown != null, layout: pr.legacy ? "video-folder" : "project", dir: pr.dir, videos: videoNames(pr).map((v) => videoSummary(pr, v)) };
    });
  }

  // ---------- creating ----------
  async function create(name, { title, tags } = {}) {
    if (single) throw new Error(`This instance serves one video (${basename(dir)}). Start the server on a projects root to create projects.`);
    if (!NAME.test(name ?? "")) throw new Error("name: letters, digits, . _ - only, no leading dot");
    const target = join(root, name);
    if (existsSync(target)) throw new Error(`${target} already exists`);
    mkdirSync(join(target, "videos"), { recursive: true });
    const tagList = (Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : []).map((t) => String(t).trim()).filter(Boolean);
    writeFileSync(join(target, "project.md"), starterMd(title || name, tagList));
    await historyOf(project(name));
    emit("projects", { project: name });
    return { name, title: title || name, tags: tagList, file: join(target, "project.md"), videos: [], next: "Add a video with create_video." };
  }

  async function createVideo(projectName, name, { title, empty = false } = {}) {
    const pr = project(pickProject(projectName));
    if (pr.legacy) throw new Error(`${pr.name} is a single video folder (the older layout). To give it more videos, make a project folder with videos/${pr.name}/ inside and move the video there.`);
    if (!NAME.test(name ?? "")) throw new Error("name: letters, digits, . _ - only, no leading dot");
    const target = join(pr.dir, "videos", name);
    if (existsSync(target)) throw new Error(`${target} already exists`);
    cpSync(TEMPLATE_DIR, target, { recursive: true });
    const sbPath = join(target, "storyboard.json");
    const sb = JSON.parse(readFileSync(sbPath, "utf8"));
    sb.title = title || name;
    if (empty) {
      for (const s of sb.scenes) rmSync(join(target, "scenes", s.id), { recursive: true, force: true });
      sb.scenes = [];
      sb.duration = 0;
    }
    writeFileSync(sbPath, JSON.stringify(sb, null, 2) + "\n");
    const v = await get(pr.name, name);
    emit("projects", { project: pr.name, video: name });
    return { project: pr.name, video: name, title: sb.title, dir: target, scenes: (await v.listScenes()).map((s) => s.id) };
  }

  return { single, root, dir, names, videoNames: (n) => videoNames(project(n)), get, dirOfVideo, pick, pickProject, resolve: resolveVideo, list, create, createVideo, instructions, setInstructions };
}
