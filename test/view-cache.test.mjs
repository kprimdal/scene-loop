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
