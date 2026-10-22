import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, TEMPLATE_DIR } from "../lib/projects.mjs";

test("list_projects reports disk use per video and project, by part, without following symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "sl-disk-"));
  const pr = join(root, "p");
  mkdirSync(join(pr, "videos"), { recursive: true });
  writeFileSync(join(pr, "project.md"), "---\ntitle: P\n---\n");
  const v = join(pr, "videos", "v");
  cpSync(TEMPLATE_DIR, v, { recursive: true });
  const put = (rel, n) => { mkdirSync(join(v, rel, ".."), { recursive: true }); writeFileSync(join(v, rel), Buffer.alloc(n)); };
  put("renders/whole-1.mp4", 5000);
  put("assets/takes/s01/1.webm", 3000);
  put("assets/cam/s01.mp4", 1000);
  put(".build/clips/s01.mp4", 700);
  put("scenes/s01-intro/.preview/build/index.html", 300);
  put(".state/stills/s01/v1/a.png", 200);
  put(".history/objects/x", 100);
  symlinkSync("../..", join(v, "scenes", "s01-intro", ".preview", "build", "scenes")); // the loop a preview build makes
  mkdirSync(join(pr, ".trash", "old"), { recursive: true });
  writeFileSync(join(pr, ".trash", "old", "big.mp4"), Buffer.alloc(9000));
  // An empty project sums to zeros, not NaN.
  mkdirSync(join(root, "empty", "videos"), { recursive: true });
  writeFileSync(join(root, "empty", "project.md"), "");

  const reg = createRegistry(root, { reviewer: "test", emit: () => {} });
  const [empty, p] = await reg.list();
  const d = p.videos[0].disk;
  assert.equal(d.renders, 5000);
  assert.equal(d.takes, 4000);
  assert.equal(d.cache, 1000);
  assert.equal(d.stills, 200);
  assert.equal(d.versions, 100);
  assert.ok(d.files > 0, "the template's scene and storyboard count as files");
  assert.equal(d.total, d.renders + d.takes + d.cache + d.stills + d.versions + d.files);
  assert.equal(p.disk.trash, 9000);
  assert.equal(p.disk.total, d.total + 9000);
  assert.equal(p.disk.renders, 5000);
  assert.deepEqual([empty.name, empty.disk.total, empty.disk.trash], ["empty", 0, 0]);
});
