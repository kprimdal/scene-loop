// A render job whose clip fails: the job reports that clip's error, not a clean-up error, and
// nothing goes on rendering after the job has said it failed. Before, the other clip runner
// kept taking scenes and the failed clip's segments kept writing into a work folder that was
// being removed (ENOTEMPTY on a network share, which replaced the real error).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVideo } from "../lib/video.mjs";

const scene = (id, duration, extra = "") => `<template>
<style>#root{position:absolute;inset:0;width:1920px;height:1080px;background:#fff;font-size:120px}
#${id}-t{position:absolute;left:100px;top:400px;animation:${id}-in 1s linear 0.2s both}
@keyframes ${id}-in{from{opacity:0;transform:translateX(-200px)}}</style>
<div id="root" data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="${duration}"><div id="${id}-t">${id}</div></div>
${extra}</template>`;

test("a failing clip ends the render with its own error, and no clip renders after that", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-renderfail-"));
  cpSync(new URL("../templates/project", import.meta.url).pathname, dir, { recursive: true });
  // The broken scene is the longest, so the queue starts with it and another clip is running
  // when it fails; the third scene has not started yet.
  const scenes = [
    { id: "s01-good", duration: 2 },
    { id: "s02-broken", duration: 4 },
    { id: "s03-later", duration: 1 },
  ];
  let start = 0;
  const sb = JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8"));
  sb.scenes = scenes.map((s) => ({ id: s.id, title: s.id, start: (start += s.duration) - s.duration, duration: s.duration, transitionIn: null, narration: "", picture: "" }));
  sb.duration = start;
  sb.fps = 10;
  writeFileSync(join(dir, "storyboard.json"), JSON.stringify(sb, null, 2));
  for (const s of scenes) {
    mkdirSync(join(dir, "scenes", s.id), { recursive: true });
    writeFileSync(join(dir, "scenes", s.id, "scene.html"), scene(s.id, s.duration, s.id === "s02-broken" ? "<script>throw new Error('broken on purpose')</script>" : ""));
  }
  const video = await openVideo(dir, { project: "p", video: "v", reviewer: "test", emit: () => {} });
  const job = await video.render();
  for (let i = 0; i < 6000 && video.getRender(job.job).state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  const r = video.getRender(job.job);
  assert.equal(r.state, "failed");
  assert.match(r.error, /broken on purpose/);

  const clips = join(dir, ".build", "clips");
  const listing = () => (existsSync(clips) ? readdirSync(clips).sort() : []);
  const atFailure = listing();
  assert.deepEqual(atFailure.filter((f) => f.endsWith(".work") || f.includes(".part.")), [], "no work folder or half clip is left");
  assert.ok(!atFailure.some((f) => f.startsWith("s03-later-")), "the scene after the failure was not started");
  await new Promise((res) => setTimeout(res, 1500));
  assert.deepEqual(listing(), atFailure, "nothing is written after the job failed");
});

// One clip, its frames split over parallel pages, and some of those pages fail: the clip
// rejects with that error only after every page has stopped, so no frame is rendered after
// it, and the work folder is gone. The scene counts its page loads in localStorage (shared by
// the pages of one Chrome), so the first loads work and the later ones throw.
test("a clip whose later pages fail stops every page before it rejects", { timeout: 120000 }, async () => {
  const { buildScene } = await import("../lib/assemble.mjs");
  const { renderClip, PARALLEL } = await import("../lib/render.mjs");
  if (PARALLEL < 3) return; // needs pages in parallel
  const dir = mkdtempSync(join(tmpdir(), "sl-clipfail-"));
  const key = `loads-${Date.now()}`;
  const html = `<template><style>#root{position:absolute;inset:0;width:1920px;height:1080px;background:#fff}
#c-t{position:absolute;left:0;top:400px;font-size:120px;animation:c-move 6s linear both}
@keyframes c-move{to{transform:translateX(1500px)}}</style>
<div id="root" data-composition-id="c" data-width="1920" data-height="1080" data-duration="6"><div id="c-t">moving</div></div>
<script>{ const n = Number(localStorage.getItem("${key}") || 0); localStorage.setItem("${key}", n + 1); if (n >= 3) throw new Error("broken on purpose"); }</script></template>`;
  const sb = { width: 1920, height: 1080, fps: 30, duration: 6, scenes: [{ id: "c", start: 0, duration: 6 }] };
  const build = buildScene(dir, sb, "c", html, "c-build");
  const out = join(dir, "clips", "c.mp4");
  let frames = 0;
  await assert.rejects(renderClip(build, out, { duration: 6, fps: 30, onFrame: () => frames++ }), /broken on purpose/);
  const atReject = frames;
  assert.equal(existsSync(join(dir, "clips", "c.work")), false, "the work folder is gone");
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(frames, atReject, "no frame is rendered after the clip rejected");
  assert.equal(existsSync(out), false);
});
