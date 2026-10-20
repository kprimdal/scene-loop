// Sound effects anchored to words. A scene puts cues on any element:
//   data-sfx="pop@word:fyrre whoosh@sentence:2-0.2 tick@1.25 thud@word:nu:-4"
// one cue per space-separated item, name@spec[:gainDb]. spec is a data-at anchor (word:,
// sentence:, offsets, | alternatives, resolved by anchor-core.js against the scene's words and
// narrationLead, the same matching as the page), or plain seconds of scene time; an
// alternative may be plain seconds too (word:fyrre|1.2). An anchor that is not heard falls back
// like data-at does: near spelling, then the alternatives, then the element's CSS animation
// delay, then 0. build_soundtrack mixes the cues; list_scenes reports them.
//
// The sounds are the kit in sfx/ (sfx/make_kit.py, calibrated so gain 0 sits 11 dB under a
// -16 LUFS voice) or the video's own assets/sfx/<name>.wav, which wins over a kit sound of the
// same name and is measured and brought to the kit's level first.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

export const KIT_DIR = fileURLToPath(new URL("../sfx/", import.meta.url));
export const SFX_LEVEL = -27; // LUFS, loudest 400 ms of a kit sound at gain 0
const anchorCore = new Function(`${readFileSync(new URL("./anchor-core.js", import.meta.url), "utf8")}; return __slAnchorCore;`)();

export const kitNames = () => (existsSync(KIT_DIR) ? readdirSync(KIT_DIR).filter((f) => f.endsWith(".wav")).map((f) => f.slice(0, -4)).sort() : []);

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const validSpec = (spec) => spec.length > 0 && spec.split("|").every((alt) => NUMBER.test(alt) || anchorCore.SPEC.test(alt));

// One cue item -> { name, spec, gainDb } or { error }. A trailing :<number> is the gain only
// when what is left is still a spec, so sentence:2 stays sentence 2 and sentence:2:-3 is
// sentence 2 at -3 dB.
export function parseCue(item) {
  const at = item.indexOf("@");
  if (at < 1) return { raw: item, error: `"${item}" is not name@spec` };
  const name = item.slice(0, at), rest = item.slice(at + 1);
  if (!/^[a-z0-9][\w-]*$/i.test(name)) return { raw: item, error: `"${name}" is not a sound name` };
  let spec = rest, gainDb = 0;
  const g = rest.match(/:([+-]?(?:\d+\.?\d*|\.\d+))$/);
  if (g && validSpec(rest.slice(0, g.index))) (spec = rest.slice(0, g.index)), (gainDb = Number(g[1]));
  if (!validSpec(spec)) return { raw: item, name, error: `"${spec}" is not seconds or a word:/sentence: anchor` };
  return { raw: item, name, spec, gainDb };
}

// Every data-sfx in a scene's html, with the element's id and tag (for the CSS fallback).
export function parseCues(html) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/<([a-z][\w-]*)\b[^>]*\bdata-sfx="([^"]*)"[^>]*>/gi)) {
    const id = m[0].match(/\sid="([^"]+)"/)?.[1] ?? null;
    const style = m[0].match(/\sstyle="([^"]*)"/)?.[1] ?? "";
    for (const item of m[2].trim().split(/\s+/).filter(Boolean)) out.push({ ...parseCue(item), element: id, tag: m[1].toLowerCase(), inlineStyle: style });
  }
  return out;
}

const seconds = (v) => (v.endsWith("ms") ? parseFloat(v) / 1000 : parseFloat(v));
// The first animation's delay for #id in the scene's styles (or the element's inline style):
// what a data-at anchor falls back to. null when the scene sets none.
export function cssDelay(html, id, inlineStyle = "") {
  const fromDecl = (decl) => {
    const d = decl.match(/(?:^|;)\s*animation-delay\s*:\s*([^;]+)/i);
    if (d) return seconds(d[1].split(",")[0].trim());
    const a = decl.match(/(?:^|;)\s*animation\s*:\s*([^;]+)/i);
    if (!a) return null;
    const times = a[1].split(",")[0].match(/-?(?:\d+\.?\d*|\.\d+)m?s\b/g) ?? [];
    return times.length > 1 ? seconds(times[1]) : times.length ? 0 : null;
  };
  const inline = fromDecl(inlineStyle);
  if (inline != null) return inline;
  if (!id) return null;
  const css = [...String(html).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  let found = null;
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(",").map((s) => s.trim());
    if (!selectors.some((s) => s === `#${id}` || s.endsWith(` #${id}`) || s.endsWith(`>#${id}`))) continue;
    const t = fromDecl(rule[2]);
    if (t != null) found = t; // later rules win
  }
  return found;
}

// Scene-local seconds for one parsed cue: { t, resolved, warning }.
export function resolveCue(cue, { words, lead = 0.35, html = "" }) {
  const warnings = [];
  const alts = cue.spec.split("|");
  for (let i = 0; i < alts.length; i++) {
    const alt = alts[i];
    let t = null;
    if (NUMBER.test(alt)) t = Number(alt);
    else if (words?.length) {
      const r = anchorCore.at(words, lead, alt, null);
      if (r.resolved) (t = r.t), warnings.push(...r.warnings);
    }
    if (t != null) {
      if (i) warnings.push(`${alts[0]} not found, used ${alt}`);
      return { t, resolved: true, fellBack: i > 0, warning: warnings.join("; ") || null };
    }
  }
  const css = cssDelay(html, cue.element, cue.inlineStyle);
  const why = words?.length ? `${cue.spec} not found` : "no narration words for this scene";
  warnings.push(css != null ? `${why}, kept the CSS animation delay ${css} s` : `${why}, and ${cue.element ? `#${cue.element}` : "the element"} has no animation delay: played at 0 s`);
  return { t: css ?? 0, resolved: false, fellBack: true, warning: warnings.join("; ") };
}

// The file for a sound: the video's assets/sfx/<name>.wav, else the kit's.
export function soundFile(videoDir, name) {
  const own = join(videoDir, "assets", "sfx", `${name}.wav`);
  if (existsSync(own)) return { file: own, source: `assets/sfx/${name}.wav`, own: true };
  const kit = join(KIT_DIR, `${name}.wav`);
  return existsSync(kit) ? { file: kit, source: "kit", own: false } : null;
}

// Loudest 400 ms of a file in LUFS (ffmpeg ebur128), cached per file version.
const measured = new Map();
export function momentaryMax(file) {
  const st = statSync(file);
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (!measured.has(key)) {
    measured.set(key, new Promise((ok, fail) => execFile("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-i", file, "-af", "aformat=sample_rates=48000,apad=pad_dur=0.5,ebur128", "-f", "null", "-"], { maxBuffer: 64 * 1024 * 1024 }, (e, so, se) => {
      if (e) return fail(new Error(`ffmpeg: ${String(se).trim().slice(-300)}`));
      const ms = [...String(se).matchAll(/\bM:\s*(-?[\d.]+|-inf)/g)].map((m) => Number(m[1])).filter(Number.isFinite);
      ok(ms.length ? Math.max(...ms) : null);
    })));
    measured.get(key).catch(() => measured.delete(key));
  }
  return measured.get(key);
}

// Every cue of every scene, resolved: [{ scene, name, spec, gainDb, t, at, sound, warning }]
// with at the video second. sceneInfo(s) gives { html, words, lead } for a storyboard scene.
export function videoCues(videoDir, scenes, sceneInfo) {
  const out = [];
  for (const s of scenes) {
    const { html, words, lead } = sceneInfo(s);
    for (const cue of parseCues(html)) {
      const base = { scene: s.id, element: cue.element, cue: cue.raw, name: cue.name ?? null, spec: cue.spec ?? null, gainDb: cue.gainDb ?? 0 };
      if (cue.error) { out.push({ ...base, t: null, at: null, sound: null, warning: cue.error }); continue; }
      const r = resolveCue(cue, { words, lead, html });
      const sound = soundFile(videoDir, cue.name);
      const warnings = [r.warning, sound ? null : `no sound "${cue.name}": not in the kit (${kitNames().join(", ")}) or assets/sfx/`];
      const at = Math.round((s.start + r.t) * 1000) / 1000;
      if (at < 0) warnings.push("before the video starts: played at 0 s");
      else if (r.t > s.duration) warnings.push(`after the scene ends (${s.duration} s)`);
      out.push({ ...base, t: r.t, at: Math.max(0, at), resolved: r.resolved, sound: sound?.source ?? null, file: sound?.file ?? null, own: sound?.own ?? false, warning: warnings.filter(Boolean).join("; ") || null });
    }
  }
  return out;
}
