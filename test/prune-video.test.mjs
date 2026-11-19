import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVideo } from "../lib/video.mjs";
import { walkFiles } from "../lib/walk.mjs";

// A video with three versions of its one scene (v2 and v3 each pinned to a different camera
// clip), stills for every version, a comment still, a blob no pin names, three renders and an
// unfinished one, a chosen and an unused take, and a render clip in .build. Synthetic bytes
// throughout. keepRenders as the server's --keep-renders (default 2).
async function fixture(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sl-prune-"));
  cpSync(new URL("../templates/project", import.meta.url).pathname, dir, { recursive: true });
  const video = await openVideo(dir, { project: "p", video: "v", reviewer: "test", emit: () => {}, keepRenders: 2, ...opts });
  const id = video.storyboard().scenes[0].id;
  const htmlFile = join(dir, "scenes", id, "scene.html");
  mkdirSync(join(dir, "assets", "cam"), { recursive: true });
  for (const [n, size] of [["A", 3000], ["B", 5000]]) {
    writeFileSync(join(dir, "assets", "cam", `${id}.mp4`), Buffer.alloc(size, n));
    writeFileSync(htmlFile, readFileSync(htmlFile, "utf8").replace("</template>", `<!-- cam ${n} -->\n</template>`));
    await video.history.commitScene(id, `cam ${n}`, "test");
  }
  assert.deepEqual((await video.history.versions(id)).map((x) => x.v), [1, 2, 3]);

  const stills = join(dir, ".state", "stills", id);
  for (const v of [1, 2, 3]) {
    mkdirSync(join(stills, `v${v}`), { recursive: true });
    writeFileSync(join(stills, `v${v}`, `${id}-at-1.0.png`), Buffer.alloc(700));
  }
  mkdirSync(join(dir, ".state", "comments", id), { recursive: true });
  writeFileSync(join(dir, ".state", "comments", id, "c1.png"), Buffer.alloc(400));

  const blobs = join(dir, ".state", "media", "blobs");
  writeFileSync(join(blobs, "0000orphan.mp4"), Buffer.alloc(900));
  const old = new Date(Date.now() - 3600e3);
  for (const f of readdirSync(blobs)) utimesSync(join(blobs, f), old, old);

  const renders = ["whole-2026-11-19-10-00.mp4", "whole-2026-11-18-10-00.mp4", "whole-2026-11-17-10-00.mp4"];
  for (const f of renders) writeFileSync(join(dir, "renders", f), Buffer.alloc(1000));
  writeFileSync(join(dir, "renders", "whole-2026-11-19-11-00.part.mp4"), Buffer.alloc(300));
  writeFileSync(join(dir, ".state", "project.json"), JSON.stringify({ renders: renders.map((file) => ({ file, picked: {}, at: new Date().toISOString(), ms: 1000 })) }));

  const takes = join(dir, "assets", "takes", id);
  mkdirSync(takes, { recursive: true });
  writeFileSync(join(takes, "1.wav"), Buffer.alloc(1200));
  writeFileSync(join(takes, "2.wav"), Buffer.alloc(800));
  writeFileSync(join(takes, "takes.json"), JSON.stringify({ takes: [{ n: 1, file: `assets/takes/${id}/1.wav` }, { n: 2, file: `assets/takes/${id}/2.wav`, chosen: true }], cam: null }));

  mkdirSync(join(dir, ".build", "clips"), { recursive: true });
  writeFileSync(join(dir, ".build", "clips", `${id}-v3-abcd1234.mp4`), Buffer.alloc(2500));
  return { dir, video, id, stills, blobs, renders, takes };
}

const pin = (dir, id, v) => JSON.parse(readFileSync(join(dir, ".state", "media", id, `v${v}.json`), "utf8"));
const files = (dir) => walkFiles(dir, "", { skip: [] }).map((f) => `${f.path}:${f.size}`).sort();

test("prune video: a dry run counts every part and deletes nothing", async () => {
  const { dir, video } = await fixture();
  try {
    const before = files(dir);
    const r = await video.pruneVideo({ cache: true, dryRun: true });
    assert.equal(r.dryRun, true);
    // renders: the oldest of three (two kept) and the unfinished file; takes: the unused one; stills: v1 and v2; media: the v2 pin,
    // the blob only v2 names, and the orphan; cache: the clip.
    assert.equal(r.byBucket.renders, 1300);
    assert.equal(r.keptRenders, 2);
    assert.equal(r.byBucket.takes, 1200);
    assert.equal(r.byBucket.stills, 1400);
    assert.ok(r.byBucket.media > 3000 + 900, `media ${r.byBucket.media}`);
    assert.equal(r.byBucket.cache, 2500);
    assert.equal(r.freedBytes, Object.values(r.byBucket).reduce((a, b) => a + b, 0));
    assert.deepEqual(files(dir), before, "nothing on disk changed");
    assert.equal((await video.pruneVideo({ dryRun: true })).byBucket.cache, 0, "cache is off unless asked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune video: keeps each scene's latest version, the referenced blobs, the newest render, the chosen take and the cache", async () => {
  const { dir, video, id, stills, blobs, renders, takes } = await fixture();
  try {
    const dry = await video.pruneVideo({ dryRun: true });
    const latestBlob = join(dir, ".state", "media", pin(dir, id, 3).files[`assets/cam/${id}.mp4`]);
    const olderBlob = join(dir, ".state", "media", pin(dir, id, 2).files[`assets/cam/${id}.mp4`]);
    assert.notEqual(latestBlob, olderBlob);
    const historyBefore = files(join(dir, ".history")), sceneBefore = readFileSync(join(dir, "scenes", id, "scene.html"), "utf8");

    const r = await video.pruneVideo({ model: "test" });
    assert.equal(r.dryRun, false);
    assert.deepEqual(r.byBucket, dry.byBucket, "the dry run counted what the real run deletes");

    assert.deepEqual(readdirSync(stills), ["v3"], "only the latest version's stills");
    assert.ok(existsSync(join(dir, ".state", "comments", id, "c1.png")), "comment stills stay");
    assert.deepEqual(readdirSync(join(dir, ".state", "media", id)), ["v3.json"], "only the latest version's pin");
    assert.ok(existsSync(latestBlob), "a blob the latest pin names stays");
    assert.equal(existsSync(olderBlob), false, "a blob only an older pin named goes");
    assert.equal(existsSync(join(blobs, "0000orphan.mp4")), false, "a blob no pin names goes");
    assert.deepEqual(readdirSync(join(dir, "renders")).sort(), renders.slice(0, 2).sort(), "the newest two renders stay, the unfinished file goes");
    assert.deepEqual(readdirSync(takes).sort(), ["2.wav", "takes.json"], "the chosen take stays");
    assert.ok(existsSync(join(dir, ".build", "clips")), "the cache is untouched unless asked");
    assert.ok(readdirSync(join(dir, ".build", "clips")).length);
    assert.deepEqual(files(join(dir, ".history")), historyBefore);
    assert.equal(readFileSync(join(dir, "scenes", id, "scene.html"), "utf8"), sceneBefore);

    // Nothing left to free, and the cache only when asked.
    assert.equal((await video.pruneVideo({})).freedBytes, 0);
    const cache = await video.pruneVideo({ cache: true });
    assert.equal(cache.byBucket.cache, 2500);
    assert.deepEqual(readdirSync(join(dir, ".build")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune video: renders keep the server's number, and never fewer than one", async () => {
  for (const [keepRenders, left] of [[1, 1], [3, 3], [0, 1]]) {
    const { dir, video } = await fixture({ keepRenders });
    try {
      const r = await video.pruneVideo({ takes: false, stills: false, media: false });
      assert.equal(r.keptRenders, Math.max(1, keepRenders));
      assert.equal(video.getRender().renders.length, left, `keepRenders ${keepRenders}`);
      assert.ok(existsSync(join(dir, "renders", "whole-2026-11-19-10-00.mp4")), "the newest render stays");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("prune video: a blob written moments ago is kept (a pin may be on its way)", async () => {
  const { dir, video, blobs } = await fixture();
  try {
    writeFileSync(join(blobs, "1111fresh.mp4"), Buffer.alloc(100));
    await video.pruneVideo({});
    assert.ok(existsSync(join(blobs, "1111fresh.mp4")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune video: refused while a render runs, and a render is refused while it prunes", async () => {
  const { dir, video } = await fixture();
  try {
    const pruning = video.pruneVideo({ dryRun: true });
    await assert.rejects(video.render(), /being pruned/);
    await pruning;

    const job = await video.render();
    await assert.rejects(video.pruneVideo({ cache: true }), /render is running/);
    assert.ok(existsSync(join(dir, ".build")), ".build is left alone");
    for (let i = 0; i < 3000 && video.getRender(job.job).state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
