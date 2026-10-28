// The soundtrack's measurement (lib/loudness.mjs) and build_soundtrack reporting it. Needs ffmpeg.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { measure, loudnessWarnings } from "../lib/loudness.mjs";
import { createRegistry } from "../lib/projects.mjs";

let root;
before(() => (root = mkdtempSync(join(tmpdir(), "sl-loud-"))));
after(() => rmSync(root, { recursive: true, force: true }));

const make = (name, expr, d) => {
  const file = join(root, name);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${d}`, "-c:a", "pcm_f32le", file]);
  return file;
};

test("a clean tone: loudness and peak, no clipping, the gap in the middle found", async () => {
  const file = make("gap.wav", "if(between(t,2,5),0,0.25*sin(2*PI*440*t))", 8);
  const m = await measure(file);
  assert.ok(m.integratedLufs < -10 && m.integratedLufs > -20, `I ${m.integratedLufs}`);
  assert.ok(m.truePeakDb < -11 && m.truePeakDb > -13, `peak ${m.truePeakDb}`);
  assert.equal(m.clippedSamples, 0);
  assert.equal(m.silences.length, 1);
  assert.ok(Math.abs(m.silences[0].from - 2) < 0.06 && Math.abs(m.silences[0].to - 5) < 0.06, JSON.stringify(m.silences));
  const w = loudnessWarnings(m, { target: -23, scenes: [{ id: "a", start: 0, duration: 4 }, { id: "b", start: 4, duration: 4 }], duration: 8 });
  assert.equal(w.length, 2, w.join("\n"));
  assert.match(w.join("\n"), /off the -23 LUFS target/);
  assert.match(w.join("\n"), /No sound from 2 to 5 s \(a, b\)/);
});

test("a clipped tone is counted and warned about; silence at the very end is not", async () => {
  const file = make("clip.wav", "if(lt(t,3),max(-1,min(1,2*sin(2*PI*440*t))),0)", 6);
  const m = await measure(file);
  assert.ok(m.clippedSamples > 1000, `clipped ${m.clippedSamples}`);
  const w = loudnessWarnings(m, { target: null, duration: 6 });
  assert.match(w.join("\n"), /clipped samples/);
  assert.match(w.join("\n"), /True peak/);
  assert.doesNotMatch(w.join("\n"), /No sound/);
});

test("silence is silent", async () => {
  const m = await measure(make("silent.wav", "0", 3));
  assert.equal(m.integratedLufs, null);
  assert.deepEqual(loudnessWarnings(m), ["The soundtrack is silent."]);
});

test("build_soundtrack returns the measurement and names the scene without sound", async () => {
  const registry = createRegistry(join(root, "projects"), { reviewer: "Test", emit: () => {} });
  await registry.create("proj", { title: "Proj" });
  await registry.createVideo("proj", "v", { title: "V", empty: true });
  const video = await registry.get("proj", "v");
  const html = (id) => `<template><style>#root{}</style><div id="root" data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="3"><div id="${id}-a" data-sfx="${id === "la" ? "thud@0.5 thud@2" : ""}"></div></div></template>`;
  await video.createScene({ id: "la", title: "A", duration: 3, html: html("la"), model: "test" });
  await video.createScene({ id: "lb", title: "B", duration: 3, html: html("lb"), model: "test" });
  await video.createScene({ id: "lc", title: "C", duration: 3, html: `<template><style>#root{}</style><div id="root" data-composition-id="lc" data-width="1920" data-height="1080" data-duration="3"><div id="lc-a" data-sfx="thud@0.2"></div></div></template>`, model: "test" });
  const r = await video.buildSoundtrack({ model: "test" });
  assert.equal(typeof r.measured.truePeakDb, "number");
  assert.equal(r.measured.clippedSamples, 0);
  const gap = r.measured.silences.find((s) => s.scenes.includes("lb"));
  assert.ok(gap, JSON.stringify(r.measured.silences));
  assert.match(r.loudnessWarnings.join("\n"), /No sound from [\d.]+ to [\d.]+ s \(la, lb(, lc)?\)/);
});
