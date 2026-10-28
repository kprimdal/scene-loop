// An older scene version plays the camera clip and voice it was saved with, not the take
// chosen since (2026-10-28: View on v4 played v5's take, because assets/cam/<id>.mp4 and the
// narration audio are overwritten in place).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, realpathSync, lstatSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { openVideo } from "../lib/video.mjs";

const hash = (f) => createHash("sha1").update(readFileSync(f)).digest("hex");
const config = (html) => JSON.parse(html.match(/window\.__slConfig = (.*?);<\/script>/)[1]);

test("an older version builds with its own camera clip, voice and length", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-vmedia-"));
  try {
    cpSync(new URL("../templates/project", import.meta.url).pathname, dir, { recursive: true });
    const video = await openVideo(dir, { project: "p", video: "v", reviewer: "test", emit: () => {} });
    const id = video.storyboard().scenes[0].id;
    const take = (name, lum, seconds) => {
      const f = join(dir, name);
      execFileSync("ffmpeg", ["-y", "-loglevel", "error",
        "-f", "lavfi", "-i", `nullsrc=s=320x180:r=30:d=${seconds},geq=lum=${lum}:cb=128:cr=128`,
        "-f", "lavfi", "-i", `aevalsrc='if(between(t,0.5,${seconds - 0.5}),0.3*sin(2*PI*220*t),0)':s=48000:d=${seconds}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", f]);
      return f;
    };
    const html = readFileSync(join(dir, "scenes", id, "scene.html"), "utf8").replace("</div>\n</template>", `  <video class="cam" src="assets/cam/${id}.mp4" muted playsinline></video>\n</div>\n</template>`);
    await video.writeSceneHtml(id, { html, model: "test" }, "api");

    await video.addTake(id, { path: take("a.mp4", 60, 4) });
    await video.chooseTake(id, 1, { speechStart: 0.5, speechEnd: 3.5, model: "test" });
    const fitA = await video.fitScenesToNarration({ model: "test" });
    const vA = fitA.sceneVersions.find((s) => s.scene === id).version;
    const camA = hash(join(dir, "assets", "cam", `${id}.mp4`)), voiceA = hash(join(dir, "assets", "narration", `${id}.wav`));
    const durationA = video.storyboard().scenes[0].duration;

    await video.addTake(id, { path: take("b.mp4", 200, 3) });
    await video.chooseTake(id, 2, { speechStart: 0.5, speechEnd: 2.5, model: "test" });
    const fitB = await video.fitScenesToNarration({ model: "test" });
    const vB = fitB.sceneVersions.find((s) => s.scene === id).version;
    assert.ok(vB > vA);
    assert.notEqual(video.storyboard().scenes[0].duration, durationA);

    // v A: its own clip, voice and length, the voice from the lead on instead of the soundtrack
    const a = await video.sceneBuildUrl(id, String(vA));
    assert.equal(a.pinned, true);
    assert.equal(a.duration, durationA);
    const buildA = join(dir, ".build", `${id}-v${vA}-pinned`);
    assert.equal(hash(join(buildA, "assets", "cam", `${id}.mp4`)), camA, "the clip of take 1, not take 2");
    assert.notEqual(camA, hash(join(dir, "assets", "cam", `${id}.mp4`)));
    const cfg = config(readFileSync(join(buildA, "index.html"), "utf8"));
    assert.deepEqual(cfg.audio, { src: `assets/narration/${id}.wav`, mediaStart: -0.35, voice: true });
    assert.equal(hash(join(buildA, cfg.audio.src)), voiceA);
    assert.equal(cfg.duration, durationA);
    assert.ok(realpathSync(join(buildA, "assets", "cam", `${id}.mp4`)).startsWith(realpathSync(join(dir, ".state", "media", "blobs"))));

    // the latest: the files as they are, through the plain assets link
    const b = await video.sceneBuildUrl(id, String(vB));
    assert.equal(b.pinned, false);
    assert.ok(lstatSync(join(dirname(join(dir, ".build", `${id}-v${vB}`, "index.html")), "assets")).isSymbolicLink());

    // a version saved before media was kept: the files as they are, as before
    rmSync(join(dir, ".state", "media", id, `v${vA}.json`));
    assert.equal((await video.sceneBuildUrl(id, String(vA))).pinned, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
