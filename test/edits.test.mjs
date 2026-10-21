// Cutting inside a take: restarts and fillers left out of the narration and the camera clip
// where the camera does not show, flagged for a new take where it does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { narrationWords } from "../lib/words.mjs";
import { keepRanges, toTake, fromTake, islands, mergedFalseStart } from "../lib/takes.mjs";
import { createRegistry } from "../lib/projects.mjs";

// Words at given seconds, "|" a 0.7 s pause.
const said = (spec) => {
  const out = [];
  let t = 0;
  for (const w of spec.split(" ")) {
    if (w === "|") t += 0.7;
    else out.push({ word: w, start: +t.toFixed(3), end: +(t + 0.4).toFixed(3) }), (t += 0.5);
  }
  return out;
};

test("restarts: a broken-off start and a sentence said twice leave the text; the later one stays", () => {
  const a = narrationWords({ words: said("Men er | Men har den læst alle mails?"), script: "Men har den læst alle mails?", adopt: true, edits: true });
  assert.equal(a.text, "Men har den læst alle mails?");
  assert.deepEqual(a.removed.map((x) => [x.kind, x.text]), [["restart", "Men er"]]);
  const b = narrationWords({ words: said("Tre varer. Priser mangler for to varer. | Priser mangler for to varer. Det er alt. øh"), script: "Tre varer. Priser mangler for to varer. Det er alt.", adopt: true, edits: true });
  assert.equal(b.text, "Tre varer. Priser mangler for to varer. Det er alt.");
  assert.deepEqual(b.removed.map((x) => [x.kind, x.text]), [["restart", "Priser mangler for to varer."], ["filler", "øh"]]);
  // a repeat the script has is no restart
  assert.deepEqual(narrationWords({ words: said("Tjek det. Tjek det igen."), script: "Tjek det. Tjek det igen.", adopt: true, edits: true }).removed, []);
});

test("keep ranges map narration time to take time and back", () => {
  const segs = [{ from: 1, to: 4 }, { from: 6, to: 9 }];
  assert.equal(toTake(3.5, segs), 6.5);
  assert.equal(fromTake(6.5, segs), 3.5);
  assert.equal(fromTake(5, segs), null);
  assert.deepEqual(keepRanges(segs, [{ from: 1, to: 2 }, { from: 4, to: 5 }]), [{ from: 1, to: 2 }, { from: 3, to: 4 }, { from: 6, to: 7 }, { from: 8, to: 9 }]);
});

// Levels in 20 ms windows: -30 dB where [from, to] lists sound, -70 elsewhere.
const levelsOf = (sound, seconds) => Array.from({ length: Math.round(seconds / 0.02) }, (_, i) => (sound.some(([a, b]) => i * 0.02 >= a - 1e-9 && i * 0.02 < b - 1e-9) ? -30 : -70));

test("a word that dips between syllables is one island, so its tail is no filler", () => {
  // Kristian's "prislister": 4.76-5.24 and 5.28-5.48, one word start at 4.78
  assert.deepEqual(islands(levelsOf([[1, 2], [4.76, 5.24], [5.28, 5.48]], 7), -50), [{ start: 1, end: 2 }, { start: 4.76, end: 5.48 }]);
});

test("a false start the transcript merged into the line is cut, and its word moves to where it was said", () => {
  // "Men er..." 0.7-1.6, a pause, "Men har den læst" from 2.5; whisper put "Men" at 1.0
  const dbs = levelsOf([[0.7, 1.6], [2.5, 4]], 5);
  const words = [{ word: "Men", start: 1.0, end: 2.7 }, { word: "har", start: 2.8, end: 3.0 }, { word: "den", start: 3.1, end: 3.3 }];
  const r = mergedFalseStart(dbs, -50, words);
  assert.deepEqual([r.start, r.end, r.text], [0, 2.42, "Men"]);
  assert.deepEqual(r.moved.map((w) => [w.word, w.start, w.end]), [["Men", 2.5, 2.78]]);
  // a sentence that ends before the pause is no false start
  assert.equal(mergedFalseStart(dbs, -50, [{ ...words[0], word: "Men." }, ...words.slice(1)]), null);
  // nor is one whose next word starts with the sound
  assert.equal(mergedFalseStart(dbs, -50, [words[0], { ...words[1], start: 2.52 }, words[2]]), null);
});

let root, video, cutFrom;
const id = "s01-intro";
const script = "One two three. Four five six. Seven eight nine.";
// Take seconds of the nine "words" (tones), and two hums between the sentences: the first
// while the camera is on screen (scene time 0 to 3.5 s), the second after it is hidden.
const W = [[0.5, 0.9], [1.0, 1.4], [1.5, 1.9], [3.2, 3.6], [3.7, 4.1], [4.2, 4.6], [5.9, 6.3], [6.4, 6.8], [6.9, 7.3]];
const HUMS = [[2.3, 2.8], [5.0, 5.5]];

before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-edits-"));
  const registry = createRegistry(root, { reviewer: "Test", emit: () => {} });
  await registry.create("proj", { title: "Proj" });
  await registry.createVideo("proj", "rec", { title: "Rec" });
  video = await registry.get("proj", "rec");
  await video.updateScene(id, { narration: script, duration: 9, model: "test" });
  const html = readFileSync(join(video.dir, "scenes", id, "scene.html"), "utf8")
    .replace("</style>", `.cam{position:absolute;right:40px;bottom:40px;width:480px;height:270px;animation:${id}-off 0.01s linear 3.5s both}@keyframes ${id}-off{to{opacity:0}}\n</style>`)
    .replace("</div>\n</template>", `  <video class="cam" src="assets/cam/${id}.mp4" muted playsinline></video>\n</div>\n</template>`);
  await video.writeSceneHtml(id, { html, model: "test" }, "api");
  const between = (r) => r.map(([a, b]) => `between(t,${a},${b})`).join("+");
  const take = join(root, "take.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "nullsrc=s=320x180:r=30:d=8,geq=lum='16+N':cb=128:cr=128",
    "-f", "lavfi", "-i", `aevalsrc='(${between(W)})*0.3*sin(2*PI*200*t)+(${between(HUMS)})*(0.05*sin(2*PI*110*t)+0.03*sin(2*PI*220*t)+0.02*sin(2*PI*330*t))+0.001*(random(0)-0.5)':s=48000:d=8`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", take]);
  await video.addTake(id, { path: take });
  cutFrom = (await video.chooseTake(id, 1, { model: "test" })).take.cut.from;
});
after(() => rmSync(root, { recursive: true, force: true }));

test("a hum is cut where the camera is hidden and flagged where it shows", async () => {
  const words = script.split(" ").map((word, i) => ({ word, start: +(W[i][0] - cutFrom).toFixed(3), end: +(W[i][1] - cutFrom).toFixed(3) }));
  const before = (await video.listTakes())[0].audio.seconds;
  const r = await video.setNarrationWords(id, { words, model: "test" });
  assert.equal(r.adopted.narration, script);
  assert.deepEqual(r.edits.cut.map((c) => [c.kind, c.text]), [["filler", "(hum)"]]);
  const [c] = r.edits.cut;
  assert.ok(c.from > 4.6 && c.from < 5.0 && c.to > 5.5 && c.to < 5.9, JSON.stringify(c));
  assert.equal(r.edits.flagged.length, 1);
  const [f] = r.edits.flagged;
  assert.ok(f.at > 2.0 && f.at < 2.9, JSON.stringify(f));
  assert.match(f.reason, /at 2\.\d s while you are on screen/);
  // the narration is shorter by the cut, and the words after it come from the cut audio
  const t = (await video.listTakes())[0];
  assert.deepEqual(t.takes[0].segments.length, 2);
  assert.ok(Math.abs(before - t.audio.seconds - (c.to - c.from)) < 0.03, `${before} - ${t.audio.seconds} vs ${c.to - c.from}`);
  const timed = JSON.parse(readFileSync(join(video.dir, "assets", "narration", `${id}.words.json`), "utf8"));
  assert.equal(timed.map((w) => w.word).join(" "), script);
  assert.equal(timed[0].start, words[0].start, "words before the cut keep their time");
  assert.ok(Math.abs(timed[6].start - (words[6].start - (c.to - c.from))) < 0.005, `${timed[6].start}`);
  // the sound is really gone: nothing over -40 dB between "six" and "seven" in the new audio
  const level = (a, b) => Number(/max_volume: (-?[\d.]+)/.exec(spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", t.audio.path, "-af", `atrim=start=${a}:end=${b},volumedetect`, "-f", "null", "-"], { encoding: "utf8" }).stderr)[1]);
  assert.ok(level(timed[5].end + 0.05, timed[6].start - 0.05) < -40, "the hum is gone");
  assert.ok(level(timed[2].end + 0.2, timed[3].start - 0.2) > -40, "the flagged hum is still there");
  // the camera clip makes the same cut: scene time s shows the take at toTake(s - lead)
  // (frame N of the take has luma 16 + N)
  const luma = execFileSync("ffprobe", ["-v", "error", "-f", "lavfi", "-i", `movie=${t.cam.path},signalstats`, "-show_entries", "frame_tags=lavfi.signalstats.YAVG", "-of", "csv=p=0"], { encoding: "utf8" }).trim().split("\n").map(parseFloat);
  const segs = t.takes[0].segments;
  for (const s of [1.5, 6.0]) {
    const want = 16 + Math.round(toTake(s - 0.35, segs) * 30), got = luma[Math.round(s * 30)];
    assert.ok(Math.abs(got - want) <= 2.5, `scene ${s} s: luma ${got}, want ${want}`);
  }
  // the flag: a comment by scene-loop at that time, and the reason in the record-again list
  const sc = (await video.view()).scenes[0];
  const comment = sc.comments.find((x) => x.by === "scene-loop");
  assert.ok(comment && Math.abs(comment.t - f.at) < 1e-6, JSON.stringify(sc.comments));
  assert.deepEqual(sc.recordAgain, [f.reason]);
  assert.deepEqual(t.recordAgain, [f.reason]);
  // keep the take: the flag goes, the comment is done
  const k = await video.keepTake(id, { model: "test" });
  assert.deepEqual(k.flagsKept, [f.reason]);
  const after = (await video.view()).scenes[0];
  assert.deepEqual(after.recordAgain, []);
  assert.equal(after.comments.find((x) => x.id === comment.id).status, "sent");
});

test("choose_take keep cuts by hand and re-times the words of the same take", async () => {
  const t = (await video.listTakes())[0].takes[0];
  const keep = [[t.segments[0].from, 3.0], [3.1, t.segments.at(-1).to]];
  const r = await video.chooseTake(id, 1, { keep, model: "test" });
  assert.equal(r.wordsRemoved, false);
  assert.equal(r.wordsKept, 9);
  assert.deepEqual((await video.listTakes())[0].takes[0].segments.map((s) => [s.from, s.to]), keep);
});
