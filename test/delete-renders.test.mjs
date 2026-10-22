import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
