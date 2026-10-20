// Takes (the Record view): speech detection, the narration cut and the camera clip, and the
// cam clip following fit_scenes_to_narration. Fixture media from ffmpeg's lavfi sources.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { parseSilences, speechRange, threshold, levels } from "../lib/takes.mjs";
import { createRegistry } from "../lib/projects.mjs";

test("speechRange drops short sounds (the space bar) and keeps pauses inside the speech", () => {
  const silences = [{ start: 0, end: 1.2 }, { start: 2.0, end: 2.5 }, { start: 3.0, end: 3.6 }, { start: 3.65, end: 4 }];
  assert.deepEqual(speechRange(silences, 4), { start: 1.2, end: 3 });
  assert.deepEqual(speechRange([], 2), { start: 0, end: 2 });
  assert.equal(speechRange([{ start: 0, end: 2 }], 2), null);
  assert.deepEqual(parseSilences("[silencedetect] silence_start: -0.002\n[silencedetect] silence_end: 1.2 | silence_duration: 1.2\n[silencedetect] silence_start: 3.4\n", 4), [{ start: 0, end: 1.2 }, { start: 3.4, end: 4 }]);
});

test("the threshold sits between the room and the voice", () => {
  assert.equal(threshold({ floorDb: -60, peakDb: -20 }), -46);
  assert.equal(threshold({ floorDb: -45, peakDb: -40 }), -37, "at least 8 dB over a noisy floor");
  assert.equal(threshold({ floorDb: -80, peakDb: -10 }), -60, "at most 20 dB over a quiet one");
  const tone = Float32Array.from({ length: 16000 }, (_, i) => (i > 8000 ? 0.3 * Math.sin(i / 3) : 0.001 * Math.sin(i)));
  const l = levels(tone, 16000);
  assert.ok(l.floorDb < -55 && l.peakDb > -16, JSON.stringify(l));
});

let root, registry, video, takeFile;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-takes-"));
  registry = createRegistry(root, { reviewer: "Test", emit: () => {} });
  await registry.create("proj", { title: "Proj" });
  await registry.createVideo("proj", "rec", { title: "Rec" });
  video = await registry.get("proj", "rec");
  await video.updateScene("s01-intro", { narration: "Hello there.", model: "test" });
  // A 4 s take at 640x360, 30 fps: frame N has luma 16 + 2N, so a frame tells its own number.
  // Room noise, speech (a tone) from 1.2 to 3.0 s, and the space bar (a 20 ms click) at 3.6 s.
  takeFile = join(root, "take.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "nullsrc=s=640x360:r=30:d=4,geq=lum='16+2*N':cb=128:cr=128",
    "-f", "lavfi", "-i", "aevalsrc='if(between(t,1.2,3.0),0.3*sin(2*PI*220*t),0)+if(between(t,3.6,3.62),0.5*sin(2*PI*2000*t),0)+0.0015*(random(0)-0.5)':s=48000:d=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", takeFile]);
});
after(() => rmSync(root, { recursive: true, force: true }));

const lumaAt = (file, frames) => {
  const out = execFileSync("ffprobe", ["-v", "error", "-f", "lavfi", "-i", `movie=${file},signalstats`, "-show_entries", "frame_tags=lavfi.signalstats.YAVG", "-of", "csv=p=0"], { encoding: "utf8" }).trim().split("\n").map(parseFloat);
  return frames.map((i) => out[i]);
};
const frameCount = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames,width,height,r_frame_rate", "-of", "csv=p=0", file], { encoding: "utf8" }).trim().split(",").at(-1));

test("a take is stored, analysed and listed", async () => {
  const r = await video.addTake("s01-intro", { stream: Readable.from(readFileSync(takeFile)), mime: "video/mp4" });
  assert.equal(r.take.n, 1);
  assert.ok(existsSync(join(video.dir, "assets", "takes", "s01-intro", "1.mp4")));
  assert.ok(Math.abs(r.take.speech.start - 1.2) < 0.05 && Math.abs(r.take.speech.end - 3.0) < 0.05, JSON.stringify(r.take.speech));
  assert.equal(r.take.stale, false);
  const two = await video.addTake("s01-intro", { path: takeFile });
  assert.equal(two.take.n, 2);
  const [s] = await video.listTakes();
  assert.deepEqual([s.takes.length, s.chosen, s.audio, s.cam], [2, null, null, null]);
  await assert.rejects(video.addTake("s01-intro", { stream: Readable.from(Buffer.from("x")), mime: "text/plain" }), /mp4, webm/);
});

test("choosing a take writes the narration and a cam clip whose t=0 is the scene's t=0", async () => {
  mkdirSync(join(video.dir, "assets", "narration"), { recursive: true });
  writeFileSync(join(video.dir, "assets", "narration", "s01-intro.words.json"), "[]");
  const r = await video.chooseTake("s01-intro", 1, { model: "test" });
  assert.equal(r.wordsRemoved, true, "words timed on another take are removed");
  const { from, to } = r.take.cut;
  assert.ok(Math.abs(r.audio.seconds - (to - from)) < 0.03, `${r.audio.seconds} vs ${to - from}`);
  assert.equal(r.audio.stale, false);
  assert.ok(existsSync(join(video.dir, "assets", "narration", "s01-intro.wav")));
  const take = JSON.parse(readFileSync(join(video.dir, "assets", "narration", "s01-intro.take.json"), "utf8"));
  assert.equal(take.note, "take 1");
  // scene frame k shows take frame k + t0 * 30, t0 = cut.from - lead
  const t0 = from - 0.35;
  assert.equal(r.cam.t0, Math.round(t0 * 1000) / 1000);
  const cam = join(video.dir, "assets", "cam", "s01-intro.mp4");
  assert.equal(frameCount(cam), Math.round(video.storyboard().scenes[0].duration * 30));
  const [y0, y30] = lumaAt(cam, [0, 30]);
  const want = (k) => 16 + 2 * Math.round(k + t0 * 30);
  assert.ok(Math.abs(y0 - want(0)) <= 2.5 && Math.abs(y30 - want(30)) <= 2.5, `luma ${y0}, ${y30}; want ${want(0)}, ${want(30)}`);
  // the script changes: the take and the audio are stale
  await video.updateScene("s01-intro", { narration: "Hello there, world.", model: "test" });
  const [s] = await video.listTakes();
  assert.deepEqual([s.chosen, s.stale, s.audio.stale, s.words], [1, true, true, false]);
});

test("fit_scenes_to_narration re-cuts the cam clip, the render cache follows it, and the first word lands at the lead", async () => {
  const id = "s01-intro";
  const html = readFileSync(join(video.dir, "scenes", id, "scene.html"), "utf8").replace("</div>\n</template>", `  <video class="cam" src="assets/cam/${id}.mp4" muted playsinline></video>\n</div>\n</template>`);
  await video.writeSceneHtml(id, { html, model: "test" }, "api");
  const key = () => { const sb = video.storyboard(); return video.clipKey(sb.scenes[0], 1, readFileSync(join(video.dir, "scenes", id, "scene.html"), "utf8"), sb, 30); };
  const before = key();
  const fit = await video.fitScenesToNarration({ model: "test" });
  const duration = video.storyboard().scenes[0].duration;
  assert.deepEqual(fit.camClips.map((c) => c.scene), [id]);
  assert.equal(frameCount(join(video.dir, "assets", "cam", `${id}.mp4`)), Math.round(duration * 30));
  assert.notEqual(key(), before, "a re-cut cam clip re-renders the scene");
  const again = await video.buildSoundtrack({ model: "test" });
  assert.deepEqual(again.camClips, [], "nothing changed: no re-cut");
  const s = execFileSync("sh", ["-c", `ffmpeg -hide_banner -nostats -i "${again.file}" -af silencedetect=n=-40dB:d=0.1 -f null - 2>&1`], { encoding: "utf8" });
  const first = Number(s.match(/silence_end: ([\d.]+)/)[1]);
  const take = (await video.listTakes())[0].takes[0];
  const expected = 0.35 + (take.speech.start - take.cut.from);
  assert.ok(Math.abs(first - expected) < 0.005, `first word at ${first}, expected ${expected}`);
  const other = await video.chooseTake(id, 2, { speechStart: 1.0, speechEnd: 3.1, model: "test" });
  assert.deepEqual([other.take.speech.auto, other.take.cut.from], [false, 0.92]);
  assert.equal((await video.listTakes())[0].chosen, 2);
});
