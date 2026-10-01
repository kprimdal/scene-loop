// The projects an instance serves. `node server.mjs <dir>`: a dir with a storyboard.json
// is one project (named after its folder); any other dir is a projects root with one
// folder per project. Projects open lazily and stay open for the life of the process.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openProject } from "./project.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const TEMPLATE_DIR = join(appDir, "templates", "project");
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const isProject = (d) => existsSync(join(d, "storyboard.json"));

export function createRegistry(dir, { reviewer, emit }) {
  dir = resolve(dir);
  const single = isProject(dir);
  const root = single ? dirname(dir) : dir;
  const open = new Map(); // name -> Promise<project>

  function names() {
    if (single) return [basename(dir)];
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((n) => !n.startsWith(".") && statSync(join(root, n)).isDirectory() && isProject(join(root, n))).sort();
  }

  const dirOf = (name) => (single ? dir : join(root, name));

  function get(name) {
    if (!NAME.test(name ?? "") || !names().includes(name)) throw new Error(`No project "${name}". Projects: ${names().join(", ") || "(none; create one with create_project)"}`);
    if (!open.has(name)) {
      const p = openProject(dirOf(name), { name, reviewer, emit }).then((pr) => (pr.warm().catch(() => {}), pr));
      p.catch(() => open.delete(name));
      open.set(name, p);
    }
    return open.get(name);
  }

  // The project a call means: the one named, else the only one there is.
  function resolveProject(name) {
    if (name) return get(name);
    const all = names();
    if (all.length === 1) return get(all[0]);
    if (!all.length) throw new Error("No projects yet. Create one with create_project.");
    throw new Error(`Several projects; pass project (one of ${all.join(", ")}).`);
  }

  async function list() {
    const out = [];
    for (const n of names()) {
      let title = n, scenes = null;
      try {
        const sb = JSON.parse(readFileSync(join(dirOf(n), "storyboard.json"), "utf8"));
        title = sb.title ?? n;
        scenes = sb.scenes?.length ?? 0;
      } catch {}
      out.push({ name: n, title, scenes, dir: dirOf(n) });
    }
    return out;
  }

  async function create(name, { title } = {}) {
    if (single) throw new Error(`This instance serves one project (${basename(dir)}). Start the server on a projects root to create more.`);
    if (!NAME.test(name ?? "")) throw new Error("name: letters, digits, . _ - only, no leading dot");
    const target = join(root, name);
    if (existsSync(target)) throw new Error(`${target} already exists`);
    cpSync(TEMPLATE_DIR, target, { recursive: true });
    const sbPath = join(target, "storyboard.json");
    const sb = JSON.parse(readFileSync(sbPath, "utf8"));
    sb.title = title || name;
    writeFileSync(sbPath, JSON.stringify(sb, null, 2) + "\n");
    const p = await get(name);
    emit("projects", {});
    return { name, title: sb.title, dir: target, scenes: (await p.listScenes()).map((s) => s.id) };
  }

  return { single, root, dir, names, get, resolve: resolveProject, list, create };
}
