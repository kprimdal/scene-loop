// Version history for scenes. A private git dir (<video>/.history) over the video
// folder, so the lab repo is untouched. A project folder gets one too, for project.md,
// with its videos/ left out (exclude). Every version is a commit tagged <scene>/vN.
// Going back never rewrites: it commits the
// old content as a new version.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let queue = Promise.resolve();

// onScene(id, v) runs after every new scene version, inside the queue, so nothing else
// commits until it is done (lib/video.mjs pins the version's media there).
export function createHistory(projectDir, { exclude = [], onScene = null } = {}) {
  const gitDir = join(projectDir, ".history");
  // The tags, read once and kept until this history writes: on a network share one
  // for-each-ref over 50 tags took 3.9 s, and the page asks for them on every load. Only this
  // process writes the video's .history; forget() is for anything that changes it outside.
  let tagsRead = null; // Promise<Map id -> versions>
  const READS = new Set(["for-each-ref", "show", "status", "cat-file", "rev-parse", "log"]);
  const forget = () => (tagsRead = null);
  const git = (args, opts = {}) => {
    if (READS.has(args[0])) return run(args, opts);
    forget(); // before: no read that starts now caches the old tags; after: none that started during the write
    return run(args, opts).finally(forget);
  };
  const run = (args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        "git",
        ["--git-dir", gitDir, "--work-tree", projectDir, ...args],
        { cwd: projectDir, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_AUTHOR_NAME: opts.author ?? "scene-loop", GIT_AUTHOR_EMAIL: "scene-loop@local", GIT_COMMITTER_NAME: "scene-loop", GIT_COMMITTER_EMAIL: "scene-loop@local" } },
        (err, stdout, stderr) => (err ? reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`)) : resolve(stdout)),
      );
    });
  // git operations from parallel scene agents must not fight over the index lock
  const serial = (fn) => (queue = queue.then(fn, fn));

  // Never versioned: the people file (password hashes, the session key) when the server's root
  // is itself a video, and the raw camera takes (large, kept as files). A history made before
  // they were excluded gets the lines added.
  const ALWAYS = [".people.json*", "assets/takes/", ".references/media/", ".references/inbox/"];
  const excludeFile = join(gitDir, "info", "exclude");
  if (existsSync(excludeFile)) {
    const have = readFileSync(excludeFile, "utf8").split("\n");
    const missing = ALWAYS.filter((x) => !have.includes(x));
    if (missing.length) appendFileSync(excludeFile, (have.at(-1) === "" ? "" : "\n") + missing.join("\n") + "\n");
  }

  async function init(sceneIds) {
    if (existsSync(gitDir)) return;
    await new Promise((res, rej) => execFile("git", ["init", "--bare", "-q", gitDir], (e) => (e ? rej(e) : res())));
    await git(["config", "core.bare", "false"]);
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), [".history/", ".build/", ".state/", "renders/", "**/.preview/", ".DS_Store", ...ALWAYS, ...exclude, ""].join("\n"));
    await git(["add", "-A"]);
    await git(["commit", "-q", "--allow-empty", "-m", "import"]);
    for (const id of sceneIds) await git(["tag", `${id}/v1`]);
  }

  // Scene versions are tags <id>/vN. Full ref names, and only that shape: a tag such as s012
  // is not version 12 of s01.
  const FORMAT = "--format=%(refname)\t%(objectname:short)\t%(creatordate:iso-strict)\t%(contents:subject)";
  const parse = (out) =>
    out
      .split("\n")
      .map((l) => {
        const [ref, sha, date, subject] = l.split("\t");
        const m = /^refs\/tags\/(.+)\/v([1-9]\d*)$/.exec(ref ?? "");
        return m && { id: m[1], v: Number(m[2]), sha, date, subject };
      })
      .filter(Boolean);
  const strip = ({ id, ...x }) => x;

  async function versions(id) {
    return (await allVersions()).get(id) ?? [];
  }

  // Every scene's versions from one git run: Map id -> versions (oldest first). Each call gets
  // its own copies, so a caller cannot change the cached ones.
  async function allVersions() {
    const read = (tagsRead ??= git(["for-each-ref", "refs/tags/", FORMAT]).then((out) => {
      const by = new Map();
      for (const x of parse(out)) {
        if (!by.has(x.id)) by.set(x.id, []);
        by.get(x.id).push(strip(x));
      }
      for (const vs of by.values()) vs.sort((a, b) => a.v - b.v);
      return by;
    }));
    read.catch(() => tagsRead === read && forget());
    return new Map([...(await read)].map(([id, vs]) => [id, vs.map((x) => ({ ...x }))]));
  }

  const fileAt = (id, v, file = "scene.html") => git(["show", `${id}/v${v}:scenes/${id}/${file}`]);

  async function dirtyPaths(pathspec = ".") {
    const out = await git(["status", "--porcelain", "-uall", "--", pathspec]);
    return out.split("\n").filter(Boolean).map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
  }

  // Commit whatever changed in one scene folder as its next version. Returns the new
  // version number, or null when nothing changed.
  const commitScene = (id, message, author, { repairUntagged = false } = {}) =>
    serial(async () => {
      const dirty=(await dirtyPaths(`scenes/${id}`)).length;
      const vs = await versions(id);
      const next = (vs.at(-1)?.v ?? 0) + 1;
      if(!dirty) {
        // A recording selection has a durable completion marker. If interrupted between
        // commit and tag, its bytes are already committed: repair only the missing tag.
        if(!repairUntagged || vs.length && await fileAt(id,vs.at(-1).v)===readFileSync(join(projectDir,'scenes',id,'scene.html'),'utf8')) return null;
        await git(['tag',`${id}/v${next}`]); await onScene?.(id, next); return next;
      }
      await git(["add", "-A", "--", `scenes/${id}`]);
      await git(["commit", "-q", "-m", `${id} v${next}: ${message}`, "--", `scenes/${id}`], { author });
      await git(["tag", `${id}/v${next}`]);
      await onScene?.(id, next);
      return next;
    });

  // Project files (storyboard.json, theme.css, frame.md) get their own versions, tagged project/vN.
  const commitProject = (paths, message, author, { repairUntagged = false } = {}) =>
    serial(async () => {
      const changed = (await Promise.all(paths.map((p) => dirtyPaths(p)))).flat();
      const out = await git(["tag", "-l", "project/v*"]);
      const next = Math.max(0, ...out.split("\n").filter(Boolean).map((t) => Number(t.split("/v")[1]))) + 1;
      if(!changed.length) {
        if(!repairUntagged) return null;
        const same=next>1 && (await Promise.all(paths.map(async p=>{
          try{return await git(['show',`project/v${next-1}:${p}`])===readFileSync(join(projectDir,p),'utf8');}catch{return false;}
        }))).every(Boolean);
        if(same) return null;
        await git(['tag',`project/v${next}`]); return next;
      }
      await git(["add", "-A", "--", ...paths]);
      await git(["commit", "-q", "-m", `project v${next}: ${message}`, "--", ...paths], { author });
      await git(["tag", `project/v${next}`]);
      return next;
    });


  const restore = (id, v, author) =>
    serial(async () => {
      await git(["rm", "-rq", "--ignore-unmatch", "--", `scenes/${id}`]);
      await git(["checkout", `${id}/v${v}`, "--", `scenes/${id}`]);
      return null;
    }).then(() => commitScene(id, `restore v${v}`, author));

  return { init, versions, allVersions, forget, fileAt, dirtyPaths, commitScene, commitProject, restore };
}
