// Server-level checks on a scratch copy of the template; needs ffmpeg and ffprobe (and Chrome
// for the stills, which these tests do not wait for).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRegistry, TEMPLATE_DIR } from "../lib/projects.mjs";

let root, registry, video;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-test-"));
  registry = createRegistry(root, { reviewer: "Test", emit: () => {} });
  await registry.create("proj", { title: "Proj" });
  await registry.createVideo("proj", "vid", { title: "Vid" });
  video = await registry.get("proj", "vid");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("create_video with empty: true has no starter scene", async () => {
  const r = await registry.createVideo("proj", "empty", { title: "Empty", empty: true });
  assert.deepEqual(r.scenes, []);
  assert.deepEqual(readdirSync(join(root, "proj", "videos", "empty", "scenes")), []);
  const v = await registry.get("proj", "empty");
  assert.equal((await v.view()).duration, 0);
  await assert.rejects(v.render(), /no scenes/);
});

test("update_scene duration writes data-duration into the html as a new version", async () => {
  const r = await video.updateScene("s01-intro", { duration: 6.5, model: "test" });
  assert.deepEqual(r.sceneVersions.map((x) => x.scene), ["s01-intro"]);
  const html = readFileSync(join(video.dir, "scenes", "s01-intro", "scene.html"), "utf8");
  assert.match(html, /data-duration="6.5"/);
  assert.equal((await video.sceneHtml("s01-intro")).version, r.sceneVersions[0].version);
});

test("fit_scenes_to_narration lands frame-exact audio on its frame, not one over", async () => {
  // 65.366667 s of audio is exactly 1961 frames at 30 fps
  const dir = join(video.dir, "assets", "narration");
  mkdirSync(dir, { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "65.366667", "-c:a", "pcm_s16le", join(dir, "s01-intro.wav")]);
  const r = await video.fitScenesToNarration({ lead: 0, tail: 0, model: "test" });
  const s = r.scenes[0];
  assert.equal(Math.round(s.newDuration * 30), 1961, `duration ${s.newDuration}`);
  assert.equal(s.newDuration, 1961 / 30);
  const sb = await video.buildSoundtrack({ lead: 0, model: "test" });
  assert.deepEqual(sb.overruns, []);
  const kept = await video.buildSoundtrack({ lead: 0, loudness: "off", model: "test" });
  assert.equal(kept.loudness, null);
  rmSync(join(dir, "s01-intro.wav"));
  rmSync(join(video.dir, "assets", "narration.m4a"), { force: true });
});

test("a replaced asset re-keys only the scenes that use it", async () => {
  const assets = join(video.dir, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "a.png"), "a");
  writeFileSync(join(assets, "b.png"), "b");
  const sb = video.storyboard();
  const useA = `<template><style>#root{}</style><div id="root" data-composition-id="sA" data-width="1920" data-height="1080" data-duration="2"><img src="assets/a.png"></div></template>`;
  const useB = useA.replaceAll("sA", "sB").replace("a.png", "b.png");
  await video.createScene({ id: "sA", title: "A", duration: 2, html: useA, model: "test" });
  await video.createScene({ id: "sB", title: "B", duration: 2, html: useB, model: "test" });
  const keys = async () => {
    const { map, picked } = { map: { sA: useA, sB: useB }, picked: { sA: 1, sB: 1 } };
    const sb2 = video.storyboard();
    return Object.fromEntries(["sA", "sB"].map((id) => [id, video.clipKey(sb2.scenes.find((s) => s.id === id), picked[id], map[id], sb2, 30)]));
  };
  const before = await keys();
  writeFileSync(join(assets, "a.png"), "aa");
  utimesSync(join(assets, "a.png"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const after = await keys();
  assert.notEqual(before.sA, after.sA, "the scene using a.png re-renders");
  assert.equal(before.sB, after.sB, "the scene not using a.png keeps its clip");
});

test("list_scenes flags anchors that do not resolve", async () => {
  const html = `<template><style>#root{} #sC-t{animation: sC-x 1s 2s both} @keyframes sC-x{from{opacity:0}}</style><div id="root" data-composition-id="sC" data-width="1920" data-height="1080" data-duration="4"><div id="sC-t" data-at="word:nothere word:soft-bristled">x</div></div></template>`;
  await video.createScene({ id: "sC", title: "C", duration: 4, html, model: "test" });
  let scenes = await video.listScenes();
  assert.match(scenes.find((s) => s.id === "sC").anchorWarnings[0].warning, /no narration words/);
  await video.setNarrationWords("sC", { words: [{ word: "a", start: 0.1, end: 0.2 }, { word: "soft-bristled", start: 0.5, end: 0.9 }], script: "", model: "test" });
  scenes = await video.listScenes();
  const w = scenes.find((s) => s.id === "sC").anchorWarnings;
  assert.equal(w.length, 1);
  assert.equal(w[0].spec, "word:nothere");
  assert.equal(w[0].resolved, false);
});

test("narration audio is flagged stale after the script changes", async () => {
  const wav = join(root, "take.wav");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "1", "-c:a", "pcm_s16le", wav]);
  await video.updateScene("s01-intro", { narration: "First take text.", model: "test" });
  const set = await video.setNarrationAudio("s01-intro", { path: wav, model: "test" });
  assert.equal(set.audio.stale, false);
  assert.equal((await video.listScenes()).find((s) => s.id === "s01-intro").audio.stale, false);
  await video.updateScene("s01-intro", { narration: "Second take text.", model: "test" });
  assert.equal((await video.listScenes()).find((s) => s.id === "s01-intro").audio.stale, true);
  await video.removeNarrationAudio("s01-intro");
  assert.equal(existsSync(join(video.dir, "assets", "narration", "s01-intro.take.json")), false);
});
