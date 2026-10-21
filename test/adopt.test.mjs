// Record first, fix the script after: a take's words adopted into the narration, "keep the
// take" after a text fix, and later scenes keeping their render clips when an earlier take
// changes length.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { narrationWords, numberOf } from "../lib/words.mjs";
import { createRegistry } from "../lib/projects.mjs";

// Transcript words half a second apart, as Scribe or whisper would give them.
const heard = (text, t0 = 0.1) => text.split(" ").map((word, i) => ({ word, start: Math.round((t0 + i * 0.5) * 1000) / 1000, end: Math.round((t0 + i * 0.5 + 0.4) * 1000) / 1000 }));

test("numbers said as words are numbers", () => {
  assert.deepEqual([numberOf(["fyrre"]), numberOf(["toogfyrre"]), numberOf(["et", "hundrede", "og", "fyrre"]), numberOf(["forty-two"]), numberOf(["1.000"]), numberOf(["40%"])], [40, 42, 140, 42, 1000, 40]);
  assert.equal(numberOf(["og"]), null);
  assert.equal(numberOf(["kunder"]), null);
});

test("adopt: matching words keep the script's spelling, differing words come from the take, numbers stay as written", () => {
  const script = "Vi har 40 kunder i ScanTech.\n\nDe er meget glade!";
  const take = heard("vi har fyrre kunder hos scantech og de er glade");
  const r = narrationWords({ words: take, script, adopt: true });
  assert.equal(r.text, "Vi har 40 kunder hos ScanTech. og\n\nDe er glade!");
  assert.deepEqual(r.changes, [{ written: "i", spoken: "hos" }, { written: "", spoken: "og" }, { written: "meget", spoken: "" }]);
  // every word was heard: its times are the take's, none interpolated
  const times = new Set(take.map((w) => `${w.start}-${w.end}`));
  assert.ok(r.words.every((w) => times.has(`${w.start}-${w.end}`)), JSON.stringify(r.words));
  assert.deepEqual(r.words.map((w) => w.word), ["Vi", "har", "40", "kunder", "hos", "ScanTech.", "og", "De", "er", "glade!"]);
  // without adopt the script's words stay, and the unheard one is interpolated
  const plain = narrationWords({ words: take, script });
  assert.deepEqual(plain.unmatched, ["meget"]);
});

test("adopt keeps a sentence end the take made and punctuation between heard words", () => {
  assert.equal(narrationWords({ words: heard("we grew forty percent this year."), script: "We grew 40% this year – really.", adopt: true }).text, "We grew 40% this year.");
  assert.equal(narrationWords({ words: heard("A so B"), script: "A – B", adopt: true }).text, "A – so B");
  assert.throws(() => narrationWords({ words: [], script: "Hello", adopt: true }), /no words/);
});

let root, video;
const id = "s01-intro";
before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-adopt-"));
  const registry = createRegistry(root, { reviewer: "Test", emit: () => {} });
  await registry.create("proj", { title: "Proj" });
  await registry.createVideo("proj", "rec", { title: "Rec" });
  video = await registry.get("proj", "rec");
  await video.updateScene(id, { narration: "Hello Kristian, welcome to the show.", model: "test" });
  // An audio-only take: "speech" from 0.5 to 2.5 s.
  const file = join(root, "take.wav");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "aevalsrc='if(between(t,0.5,2.5),0.3*sin(2*PI*220*t),0)+0.001*(random(0)-0.5)':s=48000:d=3", file]);
  await video.addTake(id, { path: file });
  await video.chooseTake(id, 1, { model: "test" });
});
after(() => rmSync(root, { recursive: true, force: true }));

const scene = () => video.storyboard().scenes.find((s) => s.id === id);
const taken = async () => (await video.listTakes()).find((s) => s.scene === id);

test("set_narration_words adopts a recorded take by default: written line kept, take still current", async () => {
  const r = await video.setNarrationWords(id, { words: heard("Hello Christian, welcome to our show."), model: "test" });
  assert.equal(r.adopted.narration, "Hello Christian, welcome to our show.");
  assert.deepEqual(r.adopted.changes, [{ written: "Kristian,", spoken: "Christian," }, { written: "the", spoken: "our" }]);
  assert.equal(scene().narration, "Hello Christian, welcome to our show.");
  assert.equal(scene().narrationWritten, "Hello Kristian, welcome to the show.");
  const t = await taken();
  assert.deepEqual([t.stale, t.audio.stale, t.takes[0].stale, t.words], [false, false, false, true], "the adoption does not make its own take stale");
  assert.deepEqual(r.anchorWarnings, []);
  assert.deepEqual(r.sfxWarnings, []);
  const words = JSON.parse(readFileSync(join(video.dir, "assets", "narration", `${id}.words.json`), "utf8"));
  assert.equal(words.map((w) => w.word).join(" "), scene().narration);
  // adopting again on the same audio still compares with the line the take was read from
  const again = await video.setNarrationWords(id, { words: heard("Hello Christian, welcome to our show."), model: "test" });
  assert.equal(again.adopted.written, "Hello Kristian, welcome to the show.");
  assert.equal(scene().narrationWritten, "Hello Kristian, welcome to the show.");
  assert.equal((await video.listScenes()).find((s) => s.id === id).narrationWritten, "Hello Kristian, welcome to the show.");
});

test("keep the take: a spelling fix re-hashes and re-spells the words without a new take", async () => {
  const before = JSON.parse(readFileSync(join(video.dir, "assets", "narration", `${id}.words.json`), "utf8"));
  const u = await video.updateScene(id, { narration: "Hello Kristian, welcome to our show.", model: "test" });
  assert.match(u.recordAgain, /old take stays in the video/);
  assert.equal((await taken()).stale, true);
  const k = await video.keepTake(id, { model: "test" });
  assert.deepEqual([k.kept, k.unmatched], [true, []]);
  const t = await taken();
  assert.deepEqual([t.stale, t.audio.stale, t.takes.length], [false, false, 1]);
  const words = JSON.parse(readFileSync(join(video.dir, "assets", "narration", `${id}.words.json`), "utf8"));
  assert.equal(words[1].word, "Kristian,");
  assert.deepEqual(words.map((w) => [w.start, w.end]), before.map((w) => [w.start, w.end]), "the words keep their times");
  assert.equal((await video.keepTake(id, {})).kept, false, "nothing to keep");
  // more than spelling: the take does not have the new word
  await video.updateScene(id, { narration: "Hello Kristian, welcome to our big show.", model: "test" });
  const more = await video.keepTake(id, {});
  assert.deepEqual(more.unmatched, ["big"]);
  assert.match(more.warning, /record the scene again/);
  // the Script view's Checked clears the written line
  await video.updateScene(id, { narrationWritten: null, model: "test" });
  assert.equal(scene().narrationWritten, undefined);
});

test("audio from a voice service is not adopted unless asked", async () => {
  const other = "s02-voice";
  await video.createScene({ id: other, title: "Voice", duration: 3, narration: "A written line.", model: "test" });
  const file = join(root, "voice.wav");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=200:d=1.5", file]);
  await video.setNarrationAudio(other, { path: file, model: "test" });
  const r = await video.setNarrationWords(other, { words: heard("A written lime."), model: "test" });
  assert.equal(r.adopted, undefined);
  assert.equal(video.storyboard().scenes.find((s) => s.id === other).narration, "A written line.");
  const a = await video.setNarrationWords(other, { words: heard("A written lime."), adopt: true, model: "test" });
  assert.equal(a.adopted.narration, "A written lime.");
});

test("a later scene that only moves in time keeps its render clip", async () => {
  const fps = 30;
  const key = (sid) => {
    const sb = video.storyboard();
    const s = sb.scenes.find((x) => x.id === sid);
    return video.clipKey(s, 1, readFileSync(join(video.dir, "scenes", sid, "scene.html"), "utf8"), sb, fps);
  };
  // whole frames, but not whole milliseconds: the stored start is rounded
  await video.updateScene(id, { duration: 100 / fps, model: "test" });
  const k1 = key("s02-voice");
  await video.updateScene(id, { duration: 131 / fps, model: "test" });
  assert.notEqual(video.storyboard().scenes[1].start, 100 / fps);
  assert.equal(key("s02-voice"), k1);
});
