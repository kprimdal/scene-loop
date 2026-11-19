import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVideo } from "../lib/video.mjs";

test("delete renders: named files, keep the newest n, unknown names rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-delr-"));
  cpSync(new URL("../templates/project", import.meta.url).pathname, dir, { recursive: true });
  const video = await openVideo(dir, { project: "p", video: "v", reviewer: "test", emit: () => {} });
  // Three finished renders, newest first, as a render job leaves them.
  mkdirSync(join(dir, "renders"), { recursive: true });
  const files = ["whole-2026-10-22-15-40.mp4", "whole-2026-10-22-15-31.mp4", "whole-2026-10-21-18-57.mp4"];
  for (const f of files) writeFileSync(join(dir, "renders", f), Buffer.alloc(1000));
  mkdirSync(join(dir, ".state"), { recursive: true });
  writeFileSync(join(dir, ".state", "project.json"), JSON.stringify({ renders: files.map((file, i) => ({ file, picked: {}, at: new Date(Date.now() - i * 60000).toISOString(), ms: 1000 })) }));
  assert.equal(video.getRender().renders.length, 3);

  assert.throws(() => video.deleteRenders({ files: ["whole-nope.mp4"] }), /no render whole-nope.mp4/);
  assert.deepEqual(video.deleteRenders({}), { deleted: [], freedBytes: 0 });

  const one = video.deleteRenders({ files: [files[2]], model: "test" });
  assert.deepEqual(one.deleted, [files[2]]);
  assert.equal(one.freedBytes, 1000);
  assert.equal(existsSync(join(dir, "renders", files[2])), false);
  assert.deepEqual(video.getRender().renders.map((r) => r.file), files.slice(0, 2));

  const rest = video.deleteRenders({ keep: 1, model: "test" });
  assert.deepEqual(rest.deleted, [files[1]]);
  assert.deepEqual(video.getRender().renders.map((r) => r.file), [files[0]]);
  assert.ok(existsSync(join(dir, "renders", files[0])), "the newest render stays");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".state", "project.json"), "utf8")).renders.map((r) => r.file), [files[0]]);
  assert.deepEqual(video.deleteRenders({ keep: 1 }), { deleted: [], freedBytes: 0 });
});

test("delete renders: keep never deletes a file a kept entry names (two renders in one minute)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-delr-dup-"));
  cpSync(new URL("../templates/project", import.meta.url).pathname, dir, { recursive: true });
  const video = await openVideo(dir, { project: "p", video: "v", reviewer: "test", emit: () => {} });
  const same = "whole-2026-10-22-15-40.mp4", older = "whole-2026-10-21-18-57.mp4";
  for (const f of [same, older]) writeFileSync(join(dir, "renders", f), Buffer.alloc(1000));
  writeFileSync(join(dir, ".state", "project.json"), JSON.stringify({ renders: [same, same, same, older].map((file) => ({ file, picked: {}, at: new Date().toISOString(), ms: 1000 })) }));
  const r = video.deleteRenders({ keep: 2 });
  assert.deepEqual(r.deleted, [older]);
  assert.ok(existsSync(join(dir, "renders", same)), "the newest file stays");
  assert.deepEqual(video.getRender().renders.map((x) => x.file), [same, same]);
  assert.deepEqual(video.deleteRenders({ keep: 1 }), { deleted: [], freedBytes: 0 });
  assert.ok(existsSync(join(dir, "renders", same)));
  assert.deepEqual(video.getRender().renders.map((x) => x.file), [same], "the stale entry is dropped");
  rmSync(dir, { recursive: true, force: true });
});

// After a successful render the video keeps the newest keepRenders (the server's
// --keep-renders), and an aborted render's *.part.mp4 goes. 0 keeps every render.
async function renderWith(keepRenders) {
  const dir = mkdtempSync(join(tmpdir(), "sl-keepr-"));
  cpSync(new URL("../templates/project", import.meta.url).pathname, dir, { recursive: true });
  const video = await openVideo(dir, { project: "p", video: "v", reviewer: "test", emit: () => {}, keepRenders });
  const files = ["whole-2026-10-22-15-40.mp4", "whole-2026-10-22-15-31.mp4", "whole-2026-10-21-18-57.mp4"];
  for (const f of files) writeFileSync(join(dir, "renders", f), Buffer.alloc(1000));
  writeFileSync(join(dir, "renders", "whole-2026-10-22-16-00.part.mp4"), Buffer.alloc(500));
  writeFileSync(join(dir, ".state", "project.json"), JSON.stringify({ renders: files.map((file, i) => ({ file, picked: {}, at: new Date(Date.now() - (i + 1) * 60000).toISOString(), ms: 1000 })) }));
  const job = await video.render();
  for (let i = 0; i < 3000 && video.getRender(job.job).state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  const r = video.getRender(job.job);
  assert.equal(r.state, "done", r.error);
  return { dir, video, files, newest: r.file };
}

test("after a render: keepRenders 2 (the server's default) leaves the newest two, unfinished files go", async () => {
  const { dir, video, files, newest } = await renderWith(2);
  try {
    assert.deepEqual(video.getRender().renders.map((r) => r.file), [newest, files[0]]);
    assert.deepEqual(readdirSync(join(dir, "renders")).filter((f) => f.endsWith(".mp4")).sort(), [newest, files[0]].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after a render: keepRenders 0 keeps every render but still clears unfinished files", async () => {
  const { dir, video, files, newest } = await renderWith(0);
  try {
    assert.deepEqual(video.getRender().renders.map((r) => r.file), [newest, ...files]);
    assert.equal(readdirSync(join(dir, "renders")).some((f) => f.endsWith(".part.mp4")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
