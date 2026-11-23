// The files under a folder, for the render worker's sync and the disk use. Symlinks are not
// followed: a preview build (scenes/<id>/.preview/build) links assets/ and scenes/ back into
// the video, and following those walked scenes/s01/.preview/build/scenes/s01/... until the
// path was too long (ENAMETOOLONG on the Mac after 26 ms), so every render sent to the
// worker failed and fell back to the server. Folders named in skip are left out entirely.
import { lstatSync, readdirSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export const SKIP = [".preview", "node_modules", ".git"];

// [{ path, size, mtimeMs }] with paths relative to dir, "/"-separated, under rel when given.
// prune(path) leaves out a file or folder by its relative path.
export function walkFiles(dir, rel = "", { skip = SKIP, prune = () => false } = {}) {
  const out = [];
  const walk = (r) => {
    let entries;
    try {
      entries = readdirSync(r ? join(dir, r) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = r ? `${r}/${e.name}` : e.name;
      if (e.isSymbolicLink() || prune(p)) continue;
      if (e.isDirectory()) {
        if (!skip.includes(e.name)) walk(p);
      } else if (e.isFile()) {
        const st = lstatSync(join(dir, p), { throwIfNoEntry: false });
        if (st?.isFile()) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(rel);
  return out;
}

// walkFiles without blocking the server: on a network share (Azure Files) every readdir and
// lstat is a round trip, and a sync walk of a few videos held every other request for 50 s.
// Same rules and output; the order of the files may differ.
export async function walkFilesAsync(dir, rel = "", { skip = SKIP, prune = () => false } = {}) {
  const out = [];
  const walk = async (r) => {
    let entries;
    try {
      entries = await readdir(r ? join(dir, r) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (e) => {
      const p = r ? `${r}/${e.name}` : e.name;
      if (e.isSymbolicLink() || prune(p)) return;
      if (e.isDirectory()) {
        if (!skip.includes(e.name)) await walk(p);
      } else if (e.isFile()) {
        const st = await lstat(join(dir, p)).catch(() => null);
        if (st?.isFile()) out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      }
    }));
  };
  await walk(rel);
  return out;
}
