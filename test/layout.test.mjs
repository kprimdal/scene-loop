// The layout check in the stills, inspect_scene, the contact sheet and the elements under a
// comment's box (lib/probe.mjs, lib/render.mjs). Needs Chrome and ffmpeg.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVideo } from "../lib/video.mjs";
import { findChrome } from "../lib/chrome.mjs";

let chrome = true;
try { findChrome(); } catch { chrome = false; }

const SCENE = `<template>
<style>
  #root { font: 48px/1.2 sans-serif; color: #111; }
  #s01-intro-box { position: absolute; left: 100px; top: 100px; width: 220px; height: 60px; }
  #s01-intro-edge { position: absolute; left: 1700px; top: 300px; white-space: nowrap; }
  #s01-intro-frame { position: absolute; left: 100px; top: 500px; width: 300px; height: 70px; overflow: hidden; }
  #s01-intro-frame p { white-space: nowrap; }
  #s01-intro-a, #s01-intro-b { position: absolute; left: 800px; top: 700px; }
  #s01-intro-tiny { position: absolute; left: 100px; top: 900px; font-size: 12px; }
  #s01-intro-gone { position: absolute; left: 1800px; top: 1000px; white-space: nowrap; opacity: 0; }
  #s01-intro-fly { position: absolute; left: 800px; top: 100px; white-space: nowrap; animation: s01-intro-in 1s linear 0s both; }
  @keyframes s01-intro-in { from { transform: translateX(1000px); } }
</style>
<div id="root" data-composition-id="s01-intro" data-width="1920" data-height="1080" data-duration="4">
  <div id="s01-intro-box">This sentence is far too long for its little box</div>
  <div id="s01-intro-edge">Half of this runs off the frame</div>
  <div id="s01-intro-frame"><p>Clipped by the parent box here</p></div>
  <div id="s01-intro-a">First words</div>
  <div id="s01-intro-b">Second words</div>
  <div id="s01-intro-tiny">Fine print nobody can read</div>
  <div id="s01-intro-gone">Hidden and off the frame</div>
  <div id="s01-intro-fly">Flies in from the right</div>
</div>
</template>
`;

let dir, video;
before(async () => {
  if (!chrome) return;
  dir = mkdtempSync(join(tmpdir(), "sl-layout-"));
  cpSync(new URL("../templates/project", import.meta.url).pathname, dir, { recursive: true });
  video = await openVideo(dir, { project: "p", video: "v", reviewer: "test", emit: () => {} });
  await video.writeSceneHtml("s01-intro", { html: SCENE, model: "test" }, "api");
});
after(() => dir && (process.env.KEEP ? console.log(dir) : rmSync(dir, { recursive: true, force: true })));

test("the stills carry a layout check that names each problem once, with its times", { skip: !chrome && "no Chrome" }, async () => {
  const r = await video.stills("s01-intro");
  const by = (el) => r.layoutWarnings.filter((i) => i.element === el).map((i) => i.kind);
  assert.deepEqual(by("#s01-intro-box"), ["overflow"]);
  assert.deepEqual(by("#s01-intro-edge"), ["off-frame"]);
  assert.deepEqual(by("#s01-intro-frame p"), ["clipped"]);
  assert.ok(by("#s01-intro-a").includes("overlap") || by("#s01-intro-b").includes("overlap"));
  assert.deepEqual(by("#s01-intro-tiny"), ["small-text"]);
  assert.deepEqual(by("#s01-intro-gone"), [], "invisible text is not checked");
  // off the frame while it flies in (0.4 s), on it at rest: never reported
  assert.deepEqual(by("#s01-intro-fly"), []);
  const edge = r.layoutWarnings.find((i) => i.element === "#s01-intro-edge");
  assert.ok(edge.times.includes(1.02), `checked where the animation came to rest: ${edge.times}`);
  assert.equal(edge.text, "Half of this runs off the frame");
  const listed = (await video.listScenes())[0].layoutWarnings;
  assert.equal(listed.length, r.layoutWarnings.length);
});

test("inspect_scene gives boxes in canvas pixels, and a region the elements under it", { skip: !chrome && "no Chrome" }, async () => {
  const all = await video.inspectScene("s01-intro", { t: 2 });
  const edge = all.elements.find((e) => e.element === "#s01-intro-edge");
  assert.deepEqual([edge.box.x, edge.box.y], [1700, 300]);
  assert.equal(edge.fontSize, 48);
  assert.ok(all.issues.some((i) => i.kind === "off-frame"));
  const mid = await video.inspectScene("s01-intro", { t: 0.5 });
  assert.equal(mid.elements.find((e) => e.element === "#s01-intro-fly").moving, true);
  const under = await video.inspectScene("s01-intro", { t: 2, region: { x: 90 / 1920, y: 90 / 1080, w: 260 / 1920, h: 90 / 1080 } });
  assert.equal(under.elements[0].element, "#s01-intro-box");
  assert.ok(!under.elements.some((e) => e.element === "#s01-intro-edge"));
});

test("a contact sheet is one picture as wide as the frame", { skip: !chrome && "no Chrome" }, async () => {
  const r = await video.contactSheet("s01-intro", { count: 12 });
  assert.equal(r.times.length, 12);
  assert.ok(existsSync(r.file));
  const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", r.file], { encoding: "utf8" }).trim();
  const [w, h] = size.split(",").map(Number);
  assert.equal(w, 1920);
  assert.ok(h > 800 && h <= 1080, `height ${h}`);
});

test("a comment on an area carries the elements under its box", { skip: !chrome && "no Chrome" }, async () => {
  await video.addComment("s01-intro", { t: 2, text: "too long", region: { x: 90 / 1920, y: 90 / 1080, w: 260 / 1920, h: 90 / 1080 } });
  const [c] = await video.pending();
  assert.equal(c.elements[0].element, "#s01-intro-box");
  assert.match(c.elements[0].text, /far too long/);
});
