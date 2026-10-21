import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVideo } from "../lib/video.mjs";

test("delete takes: numbered, unused, never the chosen one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-del-"));
  cpSync(new URL("../templates/project", import.meta.url).pathname, dir, { recursive: true });
  const video = await openVideo(dir, { project: "p", video: "v", reviewer: "test", emit: () => {} });
  const id = video.storyboard().scenes[0].id;
  const src = join(dir, "src.wav");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-f", "lavfi", "-i", "sine=f=220:d=1", "-filter_complex", "[0][1]concat=n=2:v=0:a=1,atrim=duration=2.5", src]);
  for (let i = 0; i < 3; i++) await video.addTake(id, { path: src, model: "test" });
  await video.chooseTake(id, 2, { speechStart: 1, speechEnd: 2, model: "test" });
  await assert.rejects(video.deleteTakes(id, { takes: [2] }), /choose another take/);
  const one = await video.deleteTakes(id, { takes: [1], model: "test" });
  assert.deepEqual(one.deleted, [1]);
  assert.ok(one.freedBytes > 0);
  assert.equal(existsSync(join(dir, "assets", "takes", id, "1.wav")), false);
  const rest = await video.deleteTakes(undefined, { unused: true, model: "test" });
  assert.deepEqual(rest.scenes.map((s) => s.deleted), [[3]]);
  const left = JSON.parse(readFileSync(join(dir, "assets", "takes", id, "takes.json"), "utf8")).takes;
  assert.deepEqual(left.map((t) => [t.n, t.chosen]), [[2, true]]);
  await assert.rejects(video.deleteTakes(id, { takes: [9] }), /no take 9/);
});
