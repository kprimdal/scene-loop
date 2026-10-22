import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../lib/projects.mjs";
import { callTool } from "../lib/tools.mjs";

const template = new URL("../templates/project", import.meta.url).pathname;

test("library: add, list with usage, use as a bed, update, remove", async () => {
  const root = mkdtempSync(join(tmpdir(), "sl-lib-"));
  for (const [p, v] of [["a", "one"], ["b", "two"]]) {
    mkdirSync(join(root, p, "videos"), { recursive: true });
    writeFileSync(join(root, p, "project.md"), "---\ntitle: x\n---\n");
    cpSync(template, join(root, p, "videos", v), { recursive: true });
  }
  const src = join(root, "bed.mp3");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=220:d=2", "-c:a", "libmp3lame", src]);
  // a copy made by hand before the library existed
  mkdirSync(join(root, "b", "videos", "two", "assets", "music"), { recursive: true });
  copyFileSync(src, join(root, "b", "videos", "two", "assets", "music", "old.mp3"));

  const events = [];
  const registry = createRegistry(root, { reviewer: "t", emit: (type, data) => events.push([type, data]) });
  assert.deepEqual(registry.names(), ["a", "b"], "library/ is not a project");
  const call = (name, args) => callTool(name, args, { registry, via: "api", origin: "http://x" });

  const it = await call("add_to_library", { path: src, title: "Calm pad", source: "elevenlabs-music", sourceModel: "music_v1", prompt: "a pad", loop: true, bpm: 65, tags: "calm, pad", license: "test", model: "m" });
  assert.equal(it.id, "calm-pad");
  assert.equal(it.sourceModel, "music_v1");
  assert.equal(it.addedBy, "m");
  assert.ok(Math.abs(it.duration - 2) < 0.1);
  assert.deepEqual(it.tags, ["calm", "pad"]);
  assert.ok(existsSync(join(root, "library", "music", "calm-pad.mp3")) && existsSync(join(root, "library", "music", "calm-pad.json")));
  assert.deepEqual(it.usedIn, [{ project: "b", video: "two", path: "assets/music/old.mp3", bed: false }]);
  assert.ok(events.some(([t]) => t === "library"));
  await assert.rejects(call("add_to_library", { path: src, title: "Again", model: "m" }), /already in the library as "calm-pad"/);
  await assert.rejects(call("create_project", { name: "library" }), /asset library/);

  const used = await call("use_library_music", { project: "a", video: "one", item: "calm-pad", model: "m" });
  assert.equal(used.music, "assets/music/calm-pad.mp3");
  assert.equal(used.copied, true);
  const sb = JSON.parse(readFileSync(join(root, "a", "videos", "one", "storyboard.json"), "utf8"));
  assert.equal(sb.music, "assets/music/calm-pad.mp3");
  assert.equal(sb.musicLibrary, "calm-pad");
  // the hand copy is used as it is, not copied again
  const reuse = await call("use_library_music", { project: "b", video: "two", item: "calm-pad", model: "m" });
  assert.deepEqual([reuse.music, reuse.copied], ["assets/music/old.mp3", false]);

  const list = await call("list_library", { tag: "calm" });
  assert.deepEqual(list.items[0].usedIn.filter((u) => u.bed).map((u) => `${u.project}/${u.video}`), ["a/one", "b/two"]);
  assert.equal((await call("list_library", { tag: "nope" })).items.length, 0);

  const up = await call("update_library_item", { item: "calm-pad", title: "Calm pad 65", bpm: null, model: "m" });
  assert.deepEqual([up.title, up.bpm, up.prompt], ["Calm pad 65", null, "a pad"]);

  // a plain path from set_video drops the library record
  await call("set_video", { project: "b", video: "two", music: "assets/music/old.mp3", model: "m" });
  assert.equal(JSON.parse(readFileSync(join(root, "b", "videos", "two", "storyboard.json"), "utf8")).musicLibrary, undefined);

  await assert.rejects(call("remove_from_library", { item: "calm-pad" }), /is the music in a\/one, b\/two/);
  const gone = await call("remove_from_library", { item: "calm-pad", force: true });
  assert.equal(gone.keptIn.length, 2);
  assert.ok(existsSync(join(root, "a", "videos", "one", "assets", "music", "calm-pad.mp3")), "the video keeps its copy");
  assert.equal((await call("list_library", {})).items.length, 0);
});
