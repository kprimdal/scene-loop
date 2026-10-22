// The asset library: music beds (later sound effects and images) shared by every project the
// instance serves, so a bed made for one video can be heard, found and used again in the next.
//
//   <root>/library/<kind>/<id>.<ext>    the file
//   <root>/library/<kind>/<id>.json     its metadata, one sidecar per item
//
// One sidecar per item rather than one library.json: an item is two files that travel together
// (copy them to another instance and it is there), a hand edit or a broken write touches one
// item, not the whole library, and there is no shared file for two writes to race on. The
// listing reads the sidecars; a file without one is reported as unindexed, never guessed at
// from its name. In the single-video layout the library lives in <video>/.state/library.
//
// A video does not play from the library. use() copies the file into the video's
// assets/music/<id>.<ext> and records the id as storyboard.musicLibrary next to
// storyboard.music, so a render never depends on the library staying as it is, and a removed
// item leaves the videos that used it intact. Which videos use an item is found by content
// (sha1 of the file under assets/music/ or at storyboard.music), so a copy made by hand
// before the library existed is found too.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

export const KINDS = { music: ["mp3", "wav", "m4a", "ogg", "flac"] };
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EDITABLE = ["title", "source", "sourceModel", "prompt", "created", "license", "loop", "bpm", "tags", "note"];

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const today = () => new Date().toISOString().slice(0, 10);
const slug = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
const tagList = (t) => [...new Set((Array.isArray(t) ? t : typeof t === "string" ? t.split(",") : []).map((x) => String(x).trim()).filter(Boolean))];

function probeSeconds(file) {
  return new Promise((ok, fail) =>
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], (e, so, se) => {
      const s = Number(String(so).trim());
      if (e || !Number.isFinite(s)) return fail(new Error(`ffprobe could not read ${basename(file)}: ${String(se).trim().slice(-200) || "no duration"}`));
      ok(Math.round(s * 1000) / 1000);
    }),
  );
}

// sha1 of a file, cached per path, size and mtime: the usage scan hashes every bed of every video.
const hashes = new Map();
function sha1(file) {
  const st = statSync(file);
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (!hashes.has(key)) {
    hashes.set(key, new Promise((ok, fail) => {
      const h = createHash("sha1");
      createReadStream(file).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", fail);
    }));
    hashes.get(key).catch(() => hashes.delete(key));
  }
  return hashes.get(key);
}

// dir: the library folder. videos(): [{ project, video, dir }] for every video served.
// open(project, video): the open video (lib/video.mjs). emit: the server's SSE broadcast.
export function createLibrary({ dir, videos, open, emit }) {
  dir = resolve(dir);
  const kindDir = (kind) => join(dir, kind);
  const mustKind = (kind) => {
    if (!KINDS[kind]) throw new Error(`kind: one of ${Object.keys(KINDS).join(", ")}`);
    return kind;
  };

  function items(kind) {
    const kinds = kind ? [mustKind(kind)] : Object.keys(KINDS);
    const out = [];
    for (const k of kinds) {
      if (!existsSync(kindDir(k))) continue;
      for (const f of readdirSync(kindDir(k)).filter((f) => f.endsWith(".json")).sort()) {
        const it = readJson(join(kindDir(k), f));
        if (it?.id && it.file && existsSync(join(kindDir(k), it.file))) out.push({ ...it, kind: k });
      }
    }
    // Newest first, then by title.
    return out.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")) || String(a.title).localeCompare(String(b.title)));
  }
  const find = (id) => items().find((it) => it.id === id);
  const mustItem = (id) => {
    const it = find(id);
    if (!it) throw new Error(`No library item "${id}". Items: ${items().map((x) => x.id).join(", ") || "(none; add one with add_to_library)"}`);
    return it;
  };
  const fileOf = (it) => join(kindDir(it.kind), it.file);
  const urlOf = (it) => `/library/${encodeURIComponent(it.kind)}/${encodeURIComponent(it.file)}`;

  // Every video's beds: storyboard.music and the files under assets/music/, by content.
  async function usage() {
    const found = [];
    for (const v of videos()) {
      const sb = readJson(join(v.dir, "storyboard.json")) ?? {};
      const paths = new Set(sb.music ? [sb.music] : []);
      const md = join(v.dir, "assets", "music");
      if (existsSync(md)) for (const f of readdirSync(md)) if (!f.startsWith(".")) paths.add(`assets/music/${f}`);
      for (const p of paths) {
        const f = join(v.dir, p);
        if (!existsSync(f) || !statSync(f).isFile()) continue;
        found.push({ project: v.project, video: v.video, path: p, bed: p === sb.music, musicLibrary: p === sb.music ? sb.musicLibrary ?? null : null, sha1: await sha1(f).catch(() => null) });
      }
    }
    return found;
  }
  const usedIn = (it, all) => all.filter((u) => u.sha1 === it.sha1).map(({ sha1, musicLibrary, ...u }) => u);

  async function list({ kind, tag } = {}) {
    const all = await usage();
    const want = tag ? String(tag).toLowerCase() : null;
    const shown = items(kind).filter((it) => !want || (it.tags ?? []).some((t) => t.toLowerCase() === want));
    const known = new Set(items().map((it) => `${it.kind}/${it.file}`));
    const unindexed = (kind ? [kind] : Object.keys(KINDS)).flatMap((k) =>
      existsSync(kindDir(k)) ? readdirSync(kindDir(k)).filter((f) => !f.startsWith(".") && KINDS[k].includes(extname(f).slice(1).toLowerCase()) && !known.has(`${k}/${f}`)).map((f) => join(kindDir(k), f)) : [],
    );
    return {
      dir,
      items: shown.map((it) => ({ ...it, url: urlOf(it), path: fileOf(it), usedIn: usedIn(it, all) })),
      tags: [...new Set(items(kind).flatMap((it) => it.tags ?? []))].sort(),
      ...(unindexed.length ? { unindexed, hint: "Files in the library without metadata: add_to_library with path set to one of them writes its metadata without copying it." } : {}),
    };
  }

  function clean(b, { partial = false } = {}) {
    const out = {};
    for (const k of EDITABLE) {
      if (b[k] === undefined) continue;
      const v = b[k];
      if (k === "loop") out.loop = v === null ? false : Boolean(v);
      else if (k === "bpm") {
        if (v === null || v === "") out.bpm = null;
        else if (!(Number(v) > 0 && Number(v) < 400)) throw new Error("bpm: a number of beats per minute, or null");
        else out.bpm = Number(v);
      } else if (k === "tags") out.tags = tagList(v);
      else if (k === "created") {
        if (v && !/^\d{4}-\d{2}-\d{2}/.test(String(v))) throw new Error("created: a date, YYYY-MM-DD");
        out.created = v ? String(v).slice(0, 10) : null;
      } else out[k] = v == null ? null : String(v);
    }
    if (!partial && !out.title) throw new Error("title is required");
    if ("title" in out && !String(out.title ?? "").trim()) throw new Error("title can't be empty");
    return out;
  }

  // From a file on disk (path), base64 content, or an uploaded file the server streamed to a
  // temp file (upload: true moves it instead of copying). A path to a library file that has
  // no sidecar yet only gets its metadata written.
  async function add(b, { by = "chat", upload = false } = {}) {
    const kind = mustKind(b.kind ?? "music");
    const meta = clean(b);
    let src, ext, tmp = null;
    if (b.base64 != null) {
      ext = String(b.ext ?? "").toLowerCase().replace(/^\./, "");
      if (!KINDS[kind].includes(ext)) throw new Error(`ext: one of ${KINDS[kind].join(", ")}`);
      mkdirSync(kindDir(kind), { recursive: true });
      src = tmp = join(kindDir(kind), `.add-${process.pid}-${Date.now()}.${ext}`);
      writeFileSync(src, Buffer.from(String(b.base64), "base64"));
    } else {
      if (typeof b.path !== "string" || !isAbsolute(b.path)) throw new Error("path: an absolute path to a file on the server (or base64 with ext)");
      src = resolve(b.path);
      if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`${src} is not a file`);
      ext = (b.ext ?? extname(src).slice(1)).toLowerCase();
      if (!KINDS[kind].includes(ext)) throw new Error(`${basename(src)}: ${kind} takes ${KINDS[kind].join(", ")}`);
      if (upload) tmp = src;
    }
    try {
      const inPlace = resolve(src).startsWith(kindDir(kind) + "/") && !tmp;
      let id = b.id ? String(b.id) : inPlace ? basename(src, extname(src)) : slug(meta.title);
      if (!ID.test(id)) throw new Error("id: lowercase letters, digits and -, starting with a letter or digit");
      const taken = (x) => find(x) || (!inPlace && existsSync(join(kindDir(kind), `${x}.${ext}`)));
      if (taken(id)) {
        if (b.id || inPlace) throw new Error(`The library already has "${id}"`);
        let n = 2;
        while (taken(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      const duration = await probeSeconds(src);
      const hash = await sha1(src);
      const twin = items(kind).find((it) => it.sha1 === hash);
      if (twin) throw new Error(`That file is already in the library as "${twin.id}" (${twin.title}).`);
      const file = inPlace ? basename(src) : `${id}.${ext}`;
      mkdirSync(kindDir(kind), { recursive: true });
      if (!inPlace) {
        if (tmp) renameSync(tmp, join(kindDir(kind), file));
        else copyFileSync(src, join(kindDir(kind), file));
        tmp = null;
      }
      const item = {
        id, kind, title: meta.title, file, duration,
        source: meta.source ?? "file", sourceModel: meta.sourceModel ?? null, prompt: meta.prompt ?? null,
        created: meta.created ?? today(), license: meta.license ?? null,
        loop: meta.loop ?? false, bpm: meta.bpm ?? null, tags: meta.tags ?? [], note: meta.note ?? null,
        sha1: hash, size: statSync(join(kindDir(kind), file)).size,
        from: b.base64 != null || upload ? (b.name ? `upload: ${basename(String(b.name))}` : "upload") : src,
        added: new Date().toISOString(), addedBy: by,
      };
      writeFileSync(join(kindDir(kind), `${id}.json`), JSON.stringify(item, null, 2) + "\n");
      emit("library", { id, change: "added" });
      return { ...item, url: urlOf(item), path: fileOf(item), usedIn: usedIn(item, await usage()) };
    } finally {
      if (tmp) rmSync(tmp, { force: true });
    }
  }

  async function update(id, b, { by = "chat" } = {}) {
    const it = mustItem(id);
    const fields = clean(b, { partial: true });
    if (!Object.keys(fields).length) throw new Error(`Nothing to change; pass any of ${EDITABLE.join(", ")}`);
    const { url, path, usedIn: _u, ...stored } = it;
    const next = { ...stored, ...fields, updated: new Date().toISOString(), updatedBy: by };
    writeFileSync(join(kindDir(it.kind), `${it.id}.json`), JSON.stringify(next, null, 2) + "\n");
    emit("library", { id, change: "updated" });
    return { ...next, url: urlOf(next), path: fileOf(next), usedIn: usedIn(next, await usage()) };
  }

  // The videos keep their copies; the guard is about losing the record of where a bed came from.
  async function remove(id, { force = false } = {}) {
    const it = mustItem(id);
    const used = usedIn(it, await usage());
    const beds = used.filter((u) => u.bed);
    if (beds.length && !force) throw new Error(`"${id}" is the music in ${beds.map((u) => `${u.project}/${u.video}`).join(", ")}. Their copies would stay, but the library would lose it; pass force: true to remove it anyway.`);
    rmSync(fileOf(it), { force: true });
    rmSync(join(kindDir(it.kind), `${it.id}.json`), { force: true });
    emit("library", { id, change: "removed" });
    return { removed: id, title: it.title, keptIn: used };
  }

  // The video gets its own copy under assets/music/<id>.<ext> and storyboard.music points at it,
  // with musicLibrary: <id> next to it. A file with the same content already under
  // assets/music/ is used instead of a second copy.
  async function use(project, video, id, { model } = {}) {
    const it = mustItem(id);
    if (it.kind !== "music") throw new Error(`"${id}" is ${it.kind}, not music`);
    const v = await open(project, video);
    const md = join(v.dir, "assets", "music");
    mkdirSync(md, { recursive: true });
    // A copy already there (made by hand, under another name) is used as it is.
    let rel = `assets/music/${it.file}`;
    for (const f of readdirSync(md).filter((f) => !f.startsWith(".")).sort((a, b) => (a === it.file ? -1 : b === it.file ? 1 : 0))) {
      if (statSync(join(md, f)).isFile() && (await sha1(join(md, f))) === it.sha1) { rel = `assets/music/${f}`; break; }
    }
    const dest = join(v.dir, rel);
    const same = existsSync(dest) && (await sha1(dest)) === it.sha1;
    if (!same) {
      const part = `${dest}.part-${process.pid}`;
      copyFileSync(fileOf(it), part);
      renameSync(part, dest);
    }
    const sb = v.storyboard();
    const before = sb.music ?? null;
    const r = await v.setMeta({ music: rel, musicLibrary: it.id, note: `music: ${it.title} (library ${it.id})`, model: model ?? "chat" });
    emit("library", { id, change: "used" });
    return {
      project: v.project, video: v.video, item: it.id, title: it.title, music: rel, copied: !same, replaced: before && before !== rel ? before : null, version: r.version,
      next: sb.soundtrack || v.storyboard().scenes.some((s) => s.narration) ? "build_soundtrack lays the bed under the voice (15.5 dB down, looped, 1 s fade in, 2 s out)." : "build_soundtrack makes the soundtrack with the bed.",
    };
  }

  const file = (kind, name) => {
    if (!KINDS[kind] || name.includes("/") || name.startsWith(".")) return null;
    const f = join(kindDir(kind), name);
    return KINDS[kind].includes(extname(f).slice(1).toLowerCase()) && existsSync(f) ? f : null;
  };

  return { dir, list, add, update, remove, use, file, find };
}
