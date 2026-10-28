// Turns scene files into one plain HTML page: every scene inlined as a .scene div inside
// a slot, and the page clock (lib/clock.js) that puts each scene at its own local time.
// A build is a folder under project/.build with index.html plus links to assets/ and
// scenes/, so the page works over the server and as a file:// URL for the renderer.
// GSAP is loaded only when a scene still uses it (the old contract); the clock seeks
// its timeline like any other animation.
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, isAbsolute, relative, dirname } from "node:path";
import { sceneMotion } from "./motion.mjs";
import { fileURLToPath } from "node:url";

const CLOCK = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "clock.js"), "utf8");
const TIMESHIM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "timeshim.js"), "utf8");
const ANCHORS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "anchor-core.js"), "utf8") + "\n" + readFileSync(join(dirname(fileURLToPath(import.meta.url)), "anchors.js"), "utf8");
export const GSAP = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";
export const FPS = 30;

export const usesGsap = (html) => /\bgsap\s*\./.test(html);

function flattenScene(html, id) {
  const sid = `sc-${id}`;
  let s = html.replace(/<script src="[^"]*gsap[^"]*"><\/script>/g, "");
  const styles = [...s.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1].replaceAll("#root", `#${sid}`));
  let body = s.replace(/<style>[\s\S]*?<\/style>/g, "");
  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  body = body.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<\/?template>/g, "");
  const root = body.match(/<div[^>]*\bid="root"[^>]*>/);
  if (!root) throw new Error(`${id}: no <div id="root"> in scene.html`);
  body = body.slice(0, root.index) + `<div class="slot" data-slot="${id}"><div id="${sid}" class="scene">` + body.slice(root.index + root[0].length);
  body = body.trim() + "</div>"; // closes the slot after the root div's own </div>
  body = body.replace(/\sdata-(start|duration|track-index)="[^"]*"/g, "").replace(/class="clip "/g, 'class="').replace(/\sclass="clip"/g, "");
  return { id, sid, opaqueBackdrop:sceneMotion(html).some(m=>m.target==='scene'), style: styles.join("\n"), body, scripts, gsap: usesGsap(html) };
}

// scenes: [{ id, start, duration, fade }]; audio: { src, mediaStart } or null.
const scriptJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

function page({ parts, scenes, duration, audio, sb }) {
  const W = sb.width ?? 1920, H = sb.height ?? 1080, BG = sb.background ?? "#FFFFFF";
  const config = { width: W, height: H, fps: sb.fps ?? FPS, duration, scenes, audio: audio?.src ? audio : null };
  return `<!doctype html>
<html lang="${sb.language === "Danish" ? "da" : "en"}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script>
${TIMESHIM}
    </script>
    ${parts.some((p) => p.gsap) ? `<script src="${GSAP}"></script>` : ""}
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${BG}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
      .slot { position: absolute; inset: 0; visibility: hidden; }
      .scene { position: absolute; top: 0; left: 0; width: ${W}px; height: ${H}px; overflow: hidden; background-color: ${BG}; }
${parts.filter(p=>p.opaqueBackdrop).map(p=>`[data-slot="${p.id}"]{background:${BG}}`).join("\n")}
${parts.map((p) => p.style).join("\n")}
    </style>
    ${sb.brandCss ? `<style id="project-brand">\n${sb.brandCss}\n    </style>` : ""}
    ${sb.themeCss ? `<style id="project-theme">\n${sb.themeCss}\n    </style>` : ""}
  </head>
  <body>
    <script>window.__slConfig = ${scriptJson(config)};</script>
    <div id="root">
${parts.map((p) => p.body).join("\n")}
    </div>
    <script>window.__timelines = window.__timelines || {}; window.__seek = window.__seek || {};</script>
    <script>
${ANCHORS}
    </script>
${parts.filter((p) => p.scripts.length).map((p) => [`    <script>window.__slTime.enter(${scriptJson(p.id)});</script>`, ...p.scripts.map((j) => `    <script>${j}</script>`), `    <script>window.__slTime.leave();</script>`].join("\n")).join("\n")}
    <script>
${CLOCK}
    </script>
  </body>
</html>
`;
}

function sceneConfig(projectDir, scene, rest, wordsFile = join(projectDir, "assets", "narration", `${scene.id}.words.json`)) {
  return { id: scene.id, ...rest, narrationLead: scene.narrationLead ?? 0.35, ...(wordsFile && existsSync(wordsFile) ? { words: JSON.parse(readFileSync(wordsFile, "utf8")) } : {}) };
}

// overlay { "assets/cam/s01.mp4": "/abs/file" or null }: in this build those paths are the
// given file (or missing, for null) and everything else under assets/ links to the project's.
function linkAssets(dir, projectDir, overlay) {
  const under = (rel) => Object.keys(overlay).some((p) => p.startsWith(rel + "/"));
  const tree = (rel) => {
    const src = join(projectDir, rel), dst = join(dir, rel);
    mkdirSync(dst, { recursive: true });
    const names = new Set(existsSync(src) ? readdirSync(src) : []);
    for (const p of Object.keys(overlay)) if (p.startsWith(rel + "/")) names.add(p.slice(rel.length + 1).split("/")[0]);
    for (const n of names) {
      const r = `${rel}/${n}`;
      if (r in overlay) overlay[r] && symlinkSync(relative(dst, overlay[r]), join(dst, n));
      else if (under(r)) tree(r);
      else symlinkSync(relative(dst, join(src, n)), join(dst, n));
    }
  };
  tree("assets");
}

function writeBuild(projectDir, name, html, overlay = null) {
  const dir = isAbsolute(name) ? name : join(projectDir, ".build", name);
  if (overlay) rmSync(dir, { recursive: true, force: true }); // written once; a half-written one goes
  mkdirSync(dir, { recursive: true });
  if (overlay) linkAssets(dir, projectDir, overlay);
  for (const l of overlay ? ["scenes"] : ["assets", "scenes"]) {
    try {
      symlinkSync(relative(dir, join(projectDir, l)), join(dir, l));
    } catch (e) {
      if (e.code !== "EEXIST") throw e; // existsSync misses dangling links, e.g. a project without assets/
    }
  }
  writeFileSync(join(dir, "index.html"), html);
  return dir;
}

// The crossfade into a scene: transitionIn { duration } (default 0.6 s), none for the first
// scene or { type: "cut" }. Never longer than the scene itself.
export const fadeIn = (s, i) => (i === 0 || s.transitionIn?.type === "cut" ? 0 : Math.min(s.transitionIn?.duration ?? 0.6, s.duration));

// One scene alone, with the soundtrack cut to the scene's window. pinned: an older version
// with the media it was saved with (lib/video.mjs pinMedia): { duration, narrationLead,
// files: { path: file or null } }. Its camera clip and words replace the project's, and its
// voice plays instead of the soundtrack, which was laid to the newer take.
export function buildScene(projectDir, storyboard, id, html, name, pinned = null) {
  let sc = storyboard.scenes.find((s) => s.id === id);
  let audio = { src: storyboard.soundtrack, mediaStart: sc.start };
  let words;
  if (pinned) {
    sc = { ...sc, duration: pinned.duration ?? sc.duration, narrationLead: pinned.narrationLead ?? sc.narrationLead };
    const voice = Object.keys(pinned.files).find((p) => /\/narration\/[^/]+\.(mp3|wav|m4a)$/.test(p) && pinned.files[p]);
    audio = voice ? { src: voice, mediaStart: -(sc.narrationLead ?? 0.35), voice: true } : null;
    words = pinned.files[`assets/narration/${id}.words.json`] ?? null;
  }
  const config = sceneConfig(projectDir, sc, { start: 0, duration: sc.duration, fade: 0 }, words);
  return writeBuild(projectDir, name, page({ parts: [flattenScene(html, id)], scenes: [config], duration: sc.duration, audio, sb: storyboard }), pinned?.files);
}

// The whole video from a { sceneId: html } map, with the storyboard's crossfades.
export function buildWhole(projectDir, storyboard, htmlById, name) {
  const parts = storyboard.scenes.map((s) => flattenScene(htmlById[s.id], s.id));
  const scenes = storyboard.scenes.map((s, i) => sceneConfig(projectDir, s, { start: s.start, duration: s.duration, fade: fadeIn(s, i) }));
  return writeBuild(projectDir, name, page({ parts, scenes, duration: storyboard.duration, audio: { src: storyboard.soundtrack, mediaStart: 0 }, sb: storyboard }));
}

// Catalog examples use the same assembly and frozen clock as real scenes.
export function examplePage(html, transitionIn = null) {
  if (transitionIn) {
    const first={id:"library-example",start:0,duration:2,fade:0}, second={id:"library-next",start:2,duration:2,fade:transitionIn.type==='cut'?0:transitionIn.duration};
    const next=html.replaceAll('library-example','library-next').replace('One clear idea','A fresh perspective').replace('background:#163b39','background:#512e46').replace('background:#d5f2bc','background:#f3d0a1');
    return page({parts:[flattenScene(html,first.id),flattenScene(next,second.id)],scenes:[first,second],duration:4,audio:null,sb:{width:960,height:540}});
  }
  const sc = { id: "library-example", start: 0, duration: 4, fade: 0 };
  return page({ parts: [flattenScene(html, sc.id)], scenes: [sc], duration: 4, audio: null, sb: { width: 960, height: 540 } });
}

// A Library demo: a scene of its own size and length (data-width, data-height, data-duration
// on its root, default 960x540 and 4 s), with base pointing at the demo's folder so its
// assets/ load from the library.
export function demoPage(html, base) {
  const root = html.match(/<div[^>]*\bid="root"[^>]*>/)?.[0] ?? "";
  const num = (k, d) => Number(root.match(new RegExp(`data-${k}="([\\d.]+)"`))?.[1]) || d;
  const width = num("width", 960), height = num("height", 540), duration = num("duration", 4);
  const sc = { id: "library-demo", start: 0, duration, fade: 0 };
  const out = page({ parts: [flattenScene(html, sc.id)], scenes: [sc], duration, audio: null, sb: { width, height } });
  return out.replace("<head>", `<head>\n    <base href="${base.replace(/"/g, "")}" />`);
}

