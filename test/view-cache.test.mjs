// The project view the page loads on every refresh: one git run for every scene's versions, and
// narration lengths probed once per file revision. Needs ffmpeg and ffprobe.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRegistry } from "../lib/projects.mjs";

let root, video;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-view-"));
  const registry = createRegistry(root, { reviewer: "Test", emit: () => {} });
  await registry.create("proj", { title: "Proj" });
  await registry.createVideo("proj", "vid", { title: "Vid" });
  video = await registry.get("proj", "vid");
});
after(() => rmSync(root, { recursive: true, force: true }));

const tone = (file, seconds) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "pcm_s16le", file]);

test("allVersions returns every scene's versions from one git run, as versions(id) does", async () => {
  const id = (await video.view()).scenes[0].id;
  await video.updateScene(id, { duration: 6, model: "test" });
  const all = await video.history.allVersions();
  for (const s of video.storyboard().scenes) assert.deepEqual(all.get(s.id), await video.history.versions(s.id), s.id);
  assert.deepEqual(all.get(id).map((x) => x.v), [1, 2]);
  assert.deepEqual((await video.view()).scenes.find((s) => s.id === id).versions.map((x) => x.v), [1, 2]);
});

test("a tag that only looks like a version is not one: s012 is not s01 v12", async () => {
  const id = video.storyboard().scenes[0].id;
  const git = (...a) => execFileSync("git", ["--git-dir", join(video.dir, ".history"), ...a]);
  const before = await video.history.versions(id);
  git("tag", `${id}2`);
  git("tag", `${id}/vX`);
  video.history.forget(); // tags made outside the server
  try {
    assert.deepEqual(await video.history.versions(id), before);
    assert.deepEqual((await video.history.allVersions()).get(id), before);
  } finally {
    git("tag", "-d", `${id}2`, `${id}/vX`);
    video.history.forget();
  }
});

test("view probes a narration file again only when its size or mtime changes", async () => {
  const id = video.storyboard().scenes[0].id;
  const dir = join(video.dir, "assets", "narration");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.wav`);
  const seconds = async () => (await video.view()).scenes.find((s) => s.id === id).audio.seconds;
  tone(file, 1);
  utimesSync(file, 1_700_000_000, 1_700_000_000); // whole seconds, so setting it again below matches exactly
  assert.ok(Math.abs((await seconds()) - 1) < 0.01);
  // Same size and mtime, bytes ffprobe cannot read: the cached length is used, no probe runs.
  const st = statSync(file);
  writeFileSync(file, Buffer.alloc(st.size));
  utimesSync(file, 1_700_000_000, 1_700_000_000);
  assert.ok(Math.abs((await seconds()) - 1) < 0.01);
  // A new take: probed again.
  tone(file, 2);
  assert.ok(Math.abs((await seconds()) - 2) < 0.01);
});

test("the tags are read once and read again after the server writes a version", async () => {
  const id = video.storyboard().scenes[0].id;
  const before = (await video.history.versions(id)).at(-1).v;
  const git = (...a) => execFileSync("git", ["--git-dir", join(video.dir, ".history"), ...a]);
  // A tag made outside the server is not seen until forget(): proof the list is cached.
  git("tag", `${id}/v${before + 50}`);
  try {
    assert.equal((await video.history.versions(id)).at(-1).v, before);
  } finally {
    git("tag", "-d", `${id}/v${before + 50}`);
  }
  // A write through the server is seen at once.
  const r = await video.updateScene(id, { duration: 7.5, model: "test" });
  const v = r.sceneVersions[0].version;
  assert.equal(v, before + 1);
  assert.equal((await video.history.versions(id)).at(-1).v, v);
  assert.equal((await video.view()).scenes.find((s) => s.id === id).versions.at(-1).v, v);
  // Callers get copies.
  (await video.history.versions(id)).pop();
  assert.equal((await video.history.versions(id)).at(-1).v, v);
});

test("view lists a version's stills again after an event", async () => {
  const id = video.storyboard().scenes[0].id;
  const v = (await video.history.versions(id)).at(-1).v;
  const d = join(video.dir, ".state", "stills", id, `v${v}`);
  const count = async () => (await video.view()).scenes.find((s) => s.id === id).versions.at(-1).stills.length;
  const n = await count();
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "frame-99-at-9.5s.png"), "");
  assert.equal(await count(), n, "the listing is reused until something changes");
  await video.updateScene(id, { duration: 7.6, model: "test" }); // emits
  const after = (await video.view()).scenes.find((s) => s.id === id).versions.find((x) => x.v === v).stills.length;
  assert.equal(after, n + 1);
});
