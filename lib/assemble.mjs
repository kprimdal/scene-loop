// Turns scene files into one plain HTML page: every scene inlined as a .scene div inside
// a slot, and the page clock (lib/clock.js) that puts each scene at its own local time.
// A build is a folder under project/.build with index.html plus links to assets/ and
// scenes/, so the page works over the server and as a file:// URL for the renderer.
// GSAP is loaded only when a scene still uses it (the old contract); the clock seeks
// its timeline like any other animation.
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { join, isAbsolute, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLOCK = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "clock.js"), "utf8");
const ANCHORS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "anchors.js"), "utf8");
const GSAP = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";
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
  return { id, sid, style: styles.join("\n"), body, scripts, gsap: usesGsap(html) };
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
    ${parts.some((p) => p.gsap) ? `<script src="${GSAP}"></script>` : ""}
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${BG}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
      .slot { position: absolute; inset: 0; visibility: hidden; }
      .scene { position: absolute; top: 0; left: 0; width: ${W}px; height: ${H}px; overflow: hidden; background-color: ${BG}; }
${parts.map((p) => p.style).join("\n")}
    </style>
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
${parts.flatMap((p) => p.scripts).map((j) => `    <script>${j}</script>`).join("\n")}
    <script>
${CLOCK}
    </script>
  </body>
</html>
`;
}

function sceneConfig(projectDir, scene, rest) {
  const file = join(projectDir, "assets", "narration", `${scene.id}.words.json`);
  return { id: scene.id, ...rest, narrationLead: scene.narrationLead ?? 0.35, ...(existsSync(file) ? { words: JSON.parse(readFileSync(file, "utf8")) } : {}) };
}

function writeBuild(projectDir, name, html) {
  const dir = isAbsolute(name) ? name : join(projectDir, ".build", name);
  mkdirSync(dir, { recursive: true });
  for (const l of ["assets", "scenes"]) {
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

// One scene alone, with the soundtrack cut to the scene's window.
export function buildScene(projectDir, storyboard, id, html, name) {
  const sc = storyboard.scenes.find((s) => s.id === id);
  return writeBuild(projectDir, name, page({ parts: [flattenScene(html, id)], scenes: [sceneConfig(projectDir, sc, { start: 0, duration: sc.duration, fade: 0 })], duration: sc.duration, audio: { src: storyboard.soundtrack, mediaStart: sc.start }, sb: storyboard }));
}

// The whole video from a { sceneId: html } map, with the storyboard's crossfades.
export function buildWhole(projectDir, storyboard, htmlById, name) {
  const parts = storyboard.scenes.map((s) => flattenScene(htmlById[s.id], s.id));
  const scenes = storyboard.scenes.map((s, i) => sceneConfig(projectDir, s, { start: s.start, duration: s.duration, fade: fadeIn(s, i) }));
  return writeBuild(projectDir, name, page({ parts, scenes, duration: storyboard.duration, audio: { src: storyboard.soundtrack, mediaStart: 0 }, sb: storyboard }));
}
