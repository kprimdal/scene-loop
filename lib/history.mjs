// Version history for scenes. A private git dir (project/.history) over the project
// folder, so the lab repo is untouched. Every version is a commit tagged <scene>/vN;
// approval is a moving tag <scene>/approved. Going back never rewrites: it commits the
// old content as a new version.
import { execFile } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let queue = Promise.resolve();

export function createHistory(projectDir) {
  const gitDir = join(projectDir, ".history");
  const git = (args, opts = {}) =>
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

  async function init(sceneIds) {
    if (existsSync(gitDir)) return;
    await new Promise((res, rej) => execFile("git", ["init", "--bare", "-q", gitDir], (e) => (e ? rej(e) : res())));
    await git(["config", "core.bare", "false"]);
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), [".history/", ".build/", ".state/", "renders/", "**/.preview/", ".DS_Store", ""].join("\n"));
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "import"]);
    for (const id of sceneIds) await git(["tag", `${id}/v1`]);
  }

  async function versions(id) {
    const out = await git(["for-each-ref", `refs/tags/${id}/v*`, "--format=%(refname:short)\t%(objectname:short)\t%(creatordate:iso-strict)\t%(contents:subject)"]);
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [tag, sha, date, subject] = l.split("\t");
        return { v: Number(tag.split("/v")[1]), sha, date, subject };
      })
      .sort((a, b) => a.v - b.v);
  }

  async function approved(id) {
    try {
      const sha = (await git(["rev-list", "-n1", `${id}/approved`])).trim();
      const vs = await versions(id);
      const tagged = await Promise.all(vs.map(async (x) => [x.v, (await git(["rev-list", "-n1", `${id}/v${x.v}`])).trim()]));
      return tagged.filter(([, s]) => s === sha).map(([v]) => v).pop() ?? null;
    } catch {
      return null;
    }
  }

  const fileAt = (id, v, file = "scene.html") => git(["show", `${id}/v${v}:scenes/${id}/${file}`]);

  async function dirtyPaths(pathspec = ".") {
    const out = await git(["status", "--porcelain", "-uall", "--", pathspec]);
    return out.split("\n").filter(Boolean).map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
  }

  // Commit whatever changed in one scene folder as its next version. Returns the new
  // version number, or null when nothing changed.
  const commitScene = (id, message, author) =>
    serial(async () => {
      if (!(await dirtyPaths(`scenes/${id}`)).length) return null;
      const vs = await versions(id);
      const next = (vs.at(-1)?.v ?? 0) + 1;
      await git(["add", "-A", "--", `scenes/${id}`]);
      await git(["commit", "-q", "-m", `${id} v${next}: ${message}`, "--", `scenes/${id}`], { author });
      await git(["tag", `${id}/v${next}`]);
      return next;
    });

  const approve = (id, v) => serial(() => git(["tag", "-f", `${id}/approved`, `${id}/v${v}`]));

  const restore = (id, v, author) =>
    serial(async () => {
      await git(["rm", "-rq", "--ignore-unmatch", "--", `scenes/${id}`]);
      await git(["checkout", `${id}/v${v}`, "--", `scenes/${id}`]);
      return null;
    }).then(() => commitScene(id, `restore v${v}`, author));

  // Undo changes outside the given scene folders (the scope guard behind the CLI
  // sandboxes). Tracked files are checked out again; new files are only reported.
  const revertOutside = (allowedPrefixes) =>
    serial(async () => {
      const dirty = await dirtyPaths(".");
      const outside = dirty.filter((d) => !allowedPrefixes.some((p) => d.path.startsWith(p)));
      for (const d of outside) if (d.code !== "??") await git(["checkout", "HEAD", "--", d.path]).catch(() => {});
      return outside;
    });

  return { init, versions, approved, fileAt, dirtyPaths, commitScene, approve, restore, revertOutside };
}
