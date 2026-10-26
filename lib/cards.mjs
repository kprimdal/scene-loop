// The Library: cards, formats and sources, read from one folder of JSON files.
//
//   <library>/library.json          title and the stages, in the order the page shows them
//   <library>/cards/<id>.json       one card per file: a technique, or something scene-loop
//                                   can apply (style, motion, transition, pattern, workflow)
//   <library>/formats/<id>.json     one format per file: YouTube, a vertical short, LinkedIn...
//   <library>/sources/<id>.json     where a card was learned from: a video, an article, a book
//   <library>/demos/<id>/...        a card's moving example: a scene.html and its assets
//
// The folder is set with --library <dir> (or SCENE_LOOP_LIBRARY). It is read on top of the
// starter library in this repository: its cards, formats and sources are added to the
// starter's, one with the same id replaces the starter's, and its library.json (title,
// stages) is the one used. Without it, the starter library alone. Content grows by commits to
// the library's own repository, never from the page: the server only reads it. Every read
// checks the files' sizes and times, so a git pull in the library folder shows on the next call.
//
// A card that does not validate is left out and reported in errors, so one bad file never
// hides the rest. bin/check-library.mjs runs the same checks before a commit.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const STARTER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "library");
export const KINDS = ["technique", "style", "motion", "transition", "pattern", "workflow"];
export const STATUS = ["have", "partial", "missing"];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

let root = process.env.SCENE_LOOP_LIBRARY ? resolve(process.env.SCENE_LOOP_LIBRARY) : STARTER;
export const libraryDir = () => root;
export function setLibraryDir(dir) {
  const d = resolve(dir);
  if (!existsSync(join(d, "library.json"))) throw new Error(`${d} is not a scene-loop library: it has no library.json`);
  root = d;
  cache = null;
}

export const hashOf = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort().map((f) => join(dir, f)) : []);

// ---------- checks, shared with bin/check-library.mjs ----------
const str = (v) => typeof v === "string" && v.trim().length > 0;
const strs = (v) => Array.isArray(v) && v.every(str);
const DASH = /\u2014/;
function noDashes(value, where, problems) {
  if (typeof value === "string") { if (DASH.test(value)) problems.push(`${where}: no em dashes`); }
  else if (Array.isArray(value)) value.forEach((v, i) => noDashes(v, `${where}[${i}]`, problems));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (k !== "css" && k !== "keyframes") noDashes(v, `${where}.${k}`, problems);
}

function checkApply(card, p) {
  const a = card.apply;
  if (card.kind === "technique") { if (a !== undefined) p.push("apply: a technique has no apply; link implementations in implementedBy"); return; }
  if (!a || typeof a !== "object") return p.push(`apply: a ${card.kind} card needs apply`);
  if (card.kind === "style" && !str(a.css)) p.push("apply.css: the style's CSS");
  if (card.kind === "motion" || card.kind === "transition") {
    if (!(a.duration >= 0) || (card.kind === "motion" && !(a.duration > 0))) p.push("apply.duration: seconds");
    if (card.kind === "motion" && !Array.isArray(a.keyframes)) p.push("apply.keyframes: an array");
    if (card.kind === "transition" && !["cut", "dissolve"].includes(card.id)) p.push("transition cards: the renderer knows cut and dissolve");
  }
  if (card.kind === "pattern") {
    if (!["process", "comparison", "presenter"].includes(a.layout ?? card.id)) p.push("apply.layout: process, comparison or presenter");
    if (!Array.isArray(a.fields) || !a.defaults) p.push("apply.fields and apply.defaults");
  }
  if (card.kind === "workflow" && (!strs(a.workflow) || !a.example || !strs(a.checklist))) p.push("apply.workflow, apply.example and apply.checklist");
}

export function checkCard(card, ctx) {
  const p = [];
  if (!ID.test(card.id ?? "")) p.push("id: lowercase letters, digits and -");
  if (!KINDS.includes(card.kind)) p.push(`kind: one of ${KINDS.join(", ")}`);
  if (!str(card.version)) p.push("version: a string, raised when the card changes");
  if (!str(card.title)) p.push("title");
  if (!str(card.summary)) p.push("summary: one line for the list");
  if (!ctx.stages.has(card.stage)) p.push(`stage: one of ${[...ctx.stages].join(", ")}`);
  if (card.formats !== undefined && !(Array.isArray(card.formats) && card.formats.every((f) => ctx.formats.has(f)))) p.push(`formats: ids from formats/ (${[...ctx.formats].join(", ")}), or leave out for every format`);
  if (card.kind === "technique") {
    if (!str(card.what)) p.push("what: what the technique is");
    if (!str(card.when)) p.push("when: when to use it");
    if (!STATUS.includes(card.status)) p.push(`status: ${STATUS.join(", ")} (does scene-loop do it today)`);
  }
  if (card.prompt !== undefined && !(card.prompt && str(card.prompt.text) && typeof (card.prompt.asShown ?? false) === "boolean")) p.push("prompt: { text, asShown }");
  if (!Array.isArray(card.sources ?? [])) p.push("sources: an array");
  for (const s of card.sources ?? []) if (!ctx.sources.has(s?.source)) p.push(`sources: no source "${s?.source}" in sources/`);
  for (const r of card.related ?? []) if (!ctx.cards.has(r)) p.push(`related: no card "${r}"`);
  for (const i of card.implementedBy ?? []) if (!(i?.card ? ctx.cards.has(i.card) : str(i?.tool))) p.push(`implementedBy: { card } or { tool }, got ${JSON.stringify(i)}`);
  if (card.demo !== undefined) {
    if (!/^demos\/[a-z0-9-]+\/[\w./-]+\.html$/.test(card.demo ?? "") || card.demo.includes("..")) p.push("demo: demos/<id>/<file>.html");
    else if (!existsSync(join(ctx.home ?? ctx.dir, card.demo))) p.push(`demo: ${card.demo} does not exist`);
  }
  checkApply(card, p);
  noDashes(card, card.id ?? "card", p);
  return p;
}

export function checkFormat(f, ctx) {
  const p = [];
  if (!ID.test(f.id ?? "")) p.push("id");
  for (const k of ["version", "title", "summary"]) if (!str(f[k])) p.push(k);
  if (!(f.width >= 240 && f.height >= 240)) p.push("width and height: the canvas in pixels");
  if (!strs(f.rules ?? [])) p.push("rules: an array of plain sentences");
  for (const s of f.sources ?? []) if (!ctx.sources.has(s?.source)) p.push(`sources: no source "${s?.source}"`);
  for (const c of f.cards ?? []) if (!ctx.cards.has(c)) p.push(`cards: no card "${c}"`);
  noDashes(f, f.id ?? "format", p);
  return p;
}

export function checkSource(s) {
  const p = [];
  if (!ID.test(s.id ?? "")) p.push("id");
  for (const k of ["title", "author", "kind"]) if (!str(s[k])) p.push(k);
  if (s.url != null && !/^https?:\/\//.test(s.url)) p.push("url: http(s) or null");
  noDashes(s, s.id ?? "source", p);
  return p;
}

// ---------- loading ----------
let cache = null;
const layersOf = (dir) => (resolve(dir) === STARTER ? [STARTER] : [STARTER, resolve(dir)]);
function signature(dir) {
  const files = layersOf(dir).flatMap((d) => [join(d, "library.json"), ...["cards", "formats", "sources"].flatMap((x) => jsonFiles(join(d, x)))]);
  return files.map((f) => { try { const s = statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } }).join("|");
}
// Where each card came from, for its demo files: id -> library folder.
const homes = new Map();

export function loadLibrary(dir = root) {
  const sig = signature(dir);
  if (cache?.dir === dir && cache.sig === sig) return cache.lib;
  const errors = [];
  const read = (f) => { try { return readJson(f); } catch (e) { errors.push({ file: f, problems: [`not JSON: ${e.message}`] }); return null; } };
  const layers = layersOf(dir);
  const meta = read(join(layers.at(-1), "library.json")) ?? { title: "Library", stages: [] };
  const stages = (meta.stages ?? []).filter((s) => ID.test(s?.id ?? "") && str(s.title));
  // Each layer's files by id; a later layer's file replaces an earlier one's.
  const merged = (sub) => {
    const byId = new Map();
    for (const d of layers) for (const f of jsonFiles(join(d, sub))) { const v = read(f); if (v) byId.set(v.id ?? f, [f, v, d]); }
    return [...byId.values()];
  };
  const rawSources = merged("sources"), rawFormats = merged("formats"), rawCards = merged("cards");
  homes.clear();
  for (const [, v, d] of rawCards) homes.set(v.id, d);
  const ctx = { dir, stages: new Set(stages.map((s) => s.id)), sources: new Set(rawSources.map(([, s]) => s.id)), formats: new Set(rawFormats.map(([, s]) => s.id)), cards: new Set(rawCards.map(([, c]) => c.id)) };
  const keep = (list, check) => {
    const seen = new Set(), out = [];
    for (const [file, v] of list) {
      ctx.home = homes.get(v.id) ?? dir;
      const problems = check(v, ctx);
      if (!file.endsWith(`/${v.id}.json`)) problems.push(`the file name must be ${v.id}.json`);
      if (seen.has(v.id)) problems.push(`duplicate id ${v.id}`);
      seen.add(v.id);
      if (problems.length) errors.push({ file, problems });
      else out.push({ ...v, contentHash: hashOf(v) });
    }
    return out;
  };
  const sources = keep(rawSources, checkSource);
  const formats = keep(rawFormats, checkFormat).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
  const order = new Map(stages.map((s, i) => [s.id, i]));
  const cards = keep(rawCards, checkCard).sort((a, b) => order.get(a.stage) - order.get(b.stage) || (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
  const lib = { dir, title: meta.title ?? "Library", description: meta.description ?? null, stages, cards, formats, sources, errors };
  cache = { dir, sig, lib };
  return lib;
}

// ---------- lookups ----------
const lib = () => loadLibrary();
export const listCards = () => lib().cards;
export function getCard(id, kind) {
  const c = lib().cards.find((c) => c.id === id && (!kind || [].concat(kind).includes(c.kind)));
  if (!c) {
    const of = lib().cards.filter((c) => !kind || [].concat(kind).includes(c.kind)).map((c) => c.id);
    throw new Error(`No ${kind ? [].concat(kind).join(" or ") + " " : ""}card "${id}". Cards: ${of.join(", ") || "(none)"}`);
  }
  return c;
}
export function getFormat(id) {
  const f = lib().formats.find((f) => f.id === id);
  if (!f) throw new Error(`No format "${id}". Formats: ${lib().formats.map((f) => f.id).join(", ") || "(none)"}`);
  return f;
}
export const listFormats = () => lib().formats;
export const listSources = () => lib().sources;

// A card's sources with their titles and links, for the page and the chat.
export function citedSources(card) {
  const all = new Map(lib().sources.map((s) => [s.id, s]));
  return (card.sources ?? []).map((s) => ({ ...s, title: all.get(s.source)?.title, author: all.get(s.source)?.author, url: s.url ?? all.get(s.source)?.url ?? null }));
}

// The file of a card's demo, or of an asset next to it. Never outside the demo's folder.
export function demoFile(card, rel = null) {
  if (!card.demo) return null;
  const home = homes.get(card.id) ?? root;
  const base = resolve(home, dirname(card.demo));
  const f = rel ? resolve(base, rel) : resolve(home, card.demo);
  if (!f.startsWith(base + sep) || !existsSync(f) || !statSync(f).isFile()) return null;
  const real = realpathSync(f);
  return real.startsWith(realpathSync(base) + sep) ? real : null;
}

// ---------- the implementations, in the shapes the scene code pins ----------
// Key order matters: the content hash of these objects is what apply tools compare.
export const styleOf = (c) => ({ id: c.id, kind: "style", version: c.version, title: c.title, summary: c.summary, tags: c.tags ?? [], guidance: c.guidance ?? "", css: c.apply.css });
export const motionOf = (c) => ({ id: c.id, title: c.title, version: c.version, kind: c.kind, summary: c.summary, guidance: c.guidance ?? "", duration: c.apply.duration, ...(c.apply.keyframes ? { keyframes: c.apply.keyframes } : {}), ...(c.apply.easing ? { easing: c.apply.easing } : {}) });
export const patternOf = (c) => ({ id: c.id, version: c.version, title: c.title, summary: c.summary, guidance: c.guidance ?? "", fields: c.apply.fields, defaults: c.apply.defaults, ...(c.apply.layout && c.apply.layout !== c.id ? { layout: c.apply.layout } : {}) });
export const workflowOf = (c) => ({ id: c.id, title: c.title, summary: c.summary, workflow: c.apply.workflow, example: c.apply.example, checklist: c.apply.checklist, prompt: c.prompt?.text ?? "", version: c.version, guidance: c.guidance ?? "" });

// What the chat is given for an attached card: enough to act on, nothing it has to look up.
export function cardBrief(card) {
  const base = { id: card.id, kind: card.kind, version: card.version, contentHash: card.contentHash, title: card.title, stage: card.stage };
  if (card.kind === "workflow") return { ...base, ...workflowOf(card), kind: "workflow", contentHash: card.contentHash };
  return { ...base, what: card.what ?? card.summary, when: card.when ?? null, prompt: card.prompt?.text ?? null, guidance: card.guidance ?? null, sources: citedSources(card).map((s) => [s.title, s.at].filter(Boolean).join(", ")) };
}
