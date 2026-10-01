// Turns scene files into playable HyperFrames projects. Shader transitions don't drive sub-composition timelines, so every page inlines its
// scenes as .scene divs whose timelines are added to one master timeline.
// A build is a folder under project/.build with index.html plus links to assets/ and
// scenes/, so `hyperframes snapshot` and `render` can run on it directly.
import { mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";

const HF = "0.8.103";

function flattenScene(html, id, offset) {
  const sid = `sc-${id}`;
  let s = html.replace(/<script src="[^"]*gsap[^"]*"><\/script>/g, "");
  const styles = [...s.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1].replaceAll("#root", `#${sid}`));
  let body = s.replace(/<style>[\s\S]*?<\/style>/g, "");
  // Scene scripts run untouched; the page collects window.__timelines[<id>] afterwards,
  // so it doesn't matter how a scene registers its timeline.
  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  body = body.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<\/?template>/g, "");
  const root = body.match(/<div[^>]*\bid="root"[^>]*>/);
  if (!root) throw new Error(`${id}: no <div id="root"> in scene.html`);
  body = body.slice(0, root.index) + `<div id="${sid}" class="scene">` + body.slice(root.index + root[0].length);
  body = body.replace(/\sdata-(start|duration|track-index)="[^"]*"/g, "").replace(/class="clip "/g, 'class="').replace(/\sclass="clip"/g, "");
  return { id, offset, sid, style: styles.join("\n"), body: body.trim(), scripts };
}

function page({ parts, duration, audio, transitions, sb }) {
  const W = sb.width ?? 1920, H = sb.height ?? 1080, BG = sb.background ?? "#FFFFFF", ACCENT = sb.accent ?? "#2456B8";
  const shader = transitions?.length
    ? `HyperShader.init({
        timeline: tl, bgColor: "${BG}", accentColor: "${ACCENT}", compositionId: "main",
        scenes: ${JSON.stringify(parts.map((p) => p.sid))},
        transitions: ${JSON.stringify(transitions)},
      });`
    : "";
  return `<!doctype html>
<html lang="da">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <!-- Loaded explicitly: the player only injects the runtime when window.__hf is
         missing, and the shader library creates window.__hf first. -->
    <script src="https://cdn.jsdelivr.net/npm/@hyperframes/core@${HF}/dist/hyperframe.runtime.iife.js"></script>
    ${shader ? `<script src="https://cdn.jsdelivr.net/npm/@hyperframes/shader-transitions@${HF}/dist/index.global.js"></script>` : ""}
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${BG}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }
      .scene { position: absolute; top: 0; left: 0; width: ${W}px; height: ${H}px; overflow: hidden; background-color: ${BG}; }
${parts.map((p) => p.style).join("\n")}
    </style>
    ${sb.themeCss ? `<style id="project-theme">\n${sb.themeCss}\n    </style>` : ""}
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${duration}">
${parts.map((p) => p.body).join("\n")}
      ${audio.src ? `<audio id="el-soundtrack" src="${audio.src}" data-start="0" data-duration="${duration}"${audio.mediaStart ? ` data-media-start="${audio.mediaStart}"` : ""} data-track-index="10"></audio>` : ""}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
${parts.flatMap((p) => p.scripts).map((j) => `    <script>${j}</script>`).join("\n")}
    <script>
      var tl = window.__timelines["main"];
      ${JSON.stringify(parts.map((p) => [p.id, p.offset]))}.forEach(function (e) {
        var t = window.__timelines[e[0]];
        if (!t) throw new Error("scene " + e[0] + " registered no timeline");
        delete window.__timelines[e[0]];
        t.paused(false);
        tl.add(t, e[1]);
      });
      ${shader}
    </script>
  </body>
</html>
`;
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

// One scene alone, with the soundtrack cut to the scene's window.
export function buildScene(projectDir, storyboard, id, html, name) {
  const sc = storyboard.scenes.find((s) => s.id === id);
  const part = flattenScene(html, id, 0);
  return writeBuild(projectDir, name, page({ parts: [part], duration: sc.duration, audio: { src: storyboard.soundtrack, mediaStart: sc.start }, sb: storyboard }));
}

// The whole video from a { sceneId: html } map, with the storyboard's transitions.
export function buildWhole(projectDir, storyboard, htmlById, name) {
  const parts = storyboard.scenes.map((s) => flattenScene(htmlById[s.id], s.id, s.start));
  const transitions = storyboard.scenes.slice(1).map((s) => ({ time: s.start, ...(s.transitionIn?.shader ? { shader: s.transitionIn.shader } : {}), duration: s.transitionIn?.duration ?? 0.6 }));
  return writeBuild(projectDir, name, page({ parts, duration: storyboard.duration, audio: { src: storyboard.soundtrack }, transitions, sb: storyboard }));
}
