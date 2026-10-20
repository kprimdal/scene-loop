// Sound effects: data-sfx parsing and resolution (lib/sfx.mjs), and build_soundtrack mixing the
// cues in at their video time. Needs ffmpeg.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseCue, parseCues, resolveCue, cssDelay, kitNames, soundFile, momentaryMax, SFX_LEVEL, KIT_DIR } from "../lib/sfx.mjs";
import { createRegistry } from "../lib/projects.mjs";

test("a cue is name@spec with an optional :gainDb that never eats a sentence number", () => {
  assert.deepEqual(parseCue("pop@word:fyrre"), { raw: "pop@word:fyrre", name: "pop", spec: "word:fyrre", gainDb: 0 });
  assert.equal(parseCue("pop@word:fyrre:-3").gainDb, -3);
  assert.equal(parseCue("pop@word:fyrre:-3").spec, "word:fyrre");
  assert.deepEqual([parseCue("whoosh@sentence:2").spec, parseCue("whoosh@sentence:2").gainDb], ["sentence:2", 0]);
  assert.deepEqual([parseCue("whoosh@sentence:2-0.2:4").spec, parseCue("whoosh@sentence:2-0.2:4").gainDb], ["sentence:2-0.2", 4]);
  assert.deepEqual([parseCue("tick@1.25").spec, parseCue("tick@1.25:-6").gainDb], ["1.25", -6]);
  assert.equal(parseCue("pop@word:2024").spec, "word:2024");
  assert.equal(parseCue("ding@word:fyrre|1.2").spec, "word:fyrre|1.2");
  assert.ok(parseCue("pop").error);
  assert.ok(parseCue("pop@soon").error);
});

test("parseCues finds every cue with its element id", () => {
  const html = `<div id="root" data-composition-id="s1"><b id="s1-a" class="x" data-sfx="pop@word:fyrre whoosh@sentence:2-0.2"></b><i data-sfx=" tick@1.25 "></i></div>`;
  const cues = parseCues(html);
  assert.deepEqual(cues.map((c) => [c.name, c.spec, c.element]), [["pop", "word:fyrre", "s1-a"], ["whoosh", "sentence:2-0.2", "s1-a"], ["tick", "1.25", null]]);
});

test("cssDelay reads animation-delay or the shorthand's second time", () => {
  const html = `<style>#s1-a{animation:s1-in 0.6s ease 1.4s both} .scene #s1-b{animation-delay:250ms} #s1-c{animation:s1-in .5s both}</style>`;
  assert.equal(cssDelay(html, "s1-a"), 1.4);
  assert.equal(cssDelay(html, "s1-b"), 0.25);
  assert.equal(cssDelay(html, "s1-c"), 0);
  assert.equal(cssDelay(html, "s1-d"), null);
  assert.equal(cssDelay(html, null, "animation-delay: 2s"), 2);
});

test("resolveCue: words with the lead, fuzzy match, alternatives, then the CSS delay", () => {
  const words = [{ word: "Det", start: 0.1, end: 0.3 }, { word: "fyrre", start: 0.5, end: 0.9 }, { word: "år.", start: 1.0, end: 1.3 }, { word: "Nu", start: 2.0, end: 2.2 }];
  const html = `<style>#e{animation:x 1s 3.5s both}</style>`;
  const r = (spec) => resolveCue({ ...parseCue(`pop@${spec}`), element: "e" }, { words, lead: 0.35, html });
  assert.equal(r("word:fyrre").t, 0.85);
  assert.equal(r("word:fyrre").warning, null);
  assert.equal(r("sentence:2-0.2").t, 2.15);
  assert.equal(r("1.25").t, 1.25);
  assert.match(r("word:fyre").warning, /not heard/);
  assert.equal(r("word:fyre").t, 0.85);
  const alt = r("word:halvtreds|1.2");
  assert.deepEqual([alt.t, alt.fellBack], [1.2, true]);
  const css = r("word:halvtreds");
  assert.deepEqual([css.t, css.resolved], [3.5, false]);
  assert.match(css.warning, /CSS animation delay 3.5/);
  const none = resolveCue({ ...parseCue("pop@word:x"), element: null }, { words: null, lead: 0.35, html: "" });
  assert.equal(none.t, 0);
  assert.match(none.warning, /no narration words/);
});

test("the kit has the documented sounds, calibrated 11 dB under a -16 LUFS voice", async () => {
  const names = kitNames();
  for (const n of ["whoosh", "whoosh-long", "swoosh", "pop", "pop-low", "pop-high", "tick", "click", "typing", "ding", "error", "riser", "thud", "paper", "glitch"]) assert.ok(names.includes(n), n);
  assert.equal(SFX_LEVEL, -16 - 11);
  assert.ok(Math.abs((await momentaryMax(join(KIT_DIR, "whoosh.wav"))) - SFX_LEVEL) < 0.3);
});

let root, registry, video;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-sfx-"));
  registry = createRegistry(root, { reviewer: "Test", emit: () => {} });
  await registry.create("proj", { title: "Proj" });
  await registry.createVideo("proj", "fx", { title: "Fx", empty: true });
  video = await registry.get("proj", "fx");
});
after(() => rmSync(root, { recursive: true, force: true }));

// silencedetect's [kind, seconds] list: where the soundtrack goes quiet and loud.
const silences = (file) => {
  const r = execFileSync("sh", ["-c", `ffmpeg -hide_banner -nostats -i "${file}" -af silencedetect=n=-50dB:d=0.1 -f null - 2>&1`], { encoding: "utf8" });
  return [...r.matchAll(/silence_(start|end): ([\d.]+)/g)].map((m) => [m[1], Number(m[2])]);
};

test("build_soundtrack mixes cues at their video time, with no narration at all", async () => {
  const sceneHtml = (id, body) => `<template><style>#root{} #${id}-b{animation:${id}-x 1s 0.8s both} @keyframes ${id}-x{from{opacity:0}}</style><div id="root" data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="3">${body}</div></template>`;
  await video.createScene({ id: "fa", title: "A", duration: 3, html: sceneHtml("fa", `<div id="fa-a" data-sfx="thud@1.5"></div>`), model: "test" });
  await video.createScene({ id: "fb", title: "B", duration: 3, html: sceneHtml("fb", `<div id="fb-b" data-sfx="pop@word:hej nope@1"></div>`), model: "test" });
  const scenes = await video.listScenes();
  const fb = scenes.find((s) => s.id === "fb");
  assert.equal(scenes.find((s) => s.id === "fa").sfx[0].at, 1.5);
  assert.equal(fb.sfx[0].t, 0.8, "no words: the CSS animation delay");
  assert.equal(fb.sfx[0].at, 3.8);
  assert.match(fb.sfxWarnings.map((w) => w.warning).join(" "), /no sound "nope"/);
  const r = await video.buildSoundtrack({ model: "test" });
  assert.equal(r.sfx.length, 2);
  assert.ok(existsSync(r.file));
  assert.equal(video.storyboard().soundtrack, "assets/narration.m4a");
  const s = silences(r.file);
  assert.equal(s[0][0], "start");
  assert.ok(Math.abs(s[1][1] - 1.5) < 0.005, `first sound at ${s[1][1]}`);
  const second = s.find(([k, t]) => k === "end" && t > 2);
  assert.ok(Math.abs(second[1] - 3.8) < 0.005, `second sound at ${second[1]}`);
});

test("cues follow the words, and an assets/sfx file replaces a kit sound at the kit's level", async () => {
  const dir = join(video.dir, "assets", "narration");
  mkdirSync(dir, { recursive: true });
  // narration for fb: a tone from 0.5 s (the word "hej") to 1.0 s
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "aevalsrc='if(between(t,0.5,1.0),0.4*sin(2*PI*300*t),0)':s=48000:d=1.2", "-c:a", "pcm_s16le", join(dir, "fb.wav")]);
  await video.setNarrationWords("fb", { words: [{ word: "hej", start: 0.5, end: 1.0 }], script: "hej", model: "test" });
  const fb = (await video.listScenes()).find((s) => s.id === "fb");
  assert.equal(fb.sfx[0].t, 0.85);
  assert.equal(fb.sfx[0].warning, null);
  mkdirSync(join(video.dir, "assets", "sfx"), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=500:d=0.4", "-af", "volume=-3dB", join(video.dir, "assets", "sfx", "thud.wav")]);
  assert.equal(soundFile(video.dir, "thud").source, "assets/sfx/thud.wav");
  const r = await video.buildSoundtrack({ model: "test" });
  assert.deepEqual(r.sfx.map((c) => [c.scene, c.sound]), [["fa", "assets/sfx/thud.wav"], ["fb", "kit"]]);
  // the replaced thud at 1.5 s, measured: about the kit level, not the file's own -3 dB sine
  const m = execFileSync("sh", ["-c", `ffmpeg -hide_banner -nostats -i "${r.file}" -af atrim=1.4:2.1,apad=pad_dur=0.5,ebur128 -f null - 2>&1`], { encoding: "utf8" });
  const loudest = Math.max(...[...m.matchAll(/\bM:\s*(-?[\d.]+)/g)].map((x) => Number(x[1])));
  assert.ok(Math.abs(loudest - SFX_LEVEL) < 1.5, `override measured ${loudest} LUFS`);
});
