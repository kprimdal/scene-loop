// Restarts in real takes: the 13 scenes of kristianprimdal.dk's "mit-ai-setup" (2026-10-22),
// Scribe transcripts and the script as written at the time. The speaker improvises, so the
// script rarely needs a phrase; on that day 14 phrases said once were taken for restarts and
// left out of the narration while the audio kept them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { narrationWords } from "../lib/words.mjs";

const scenes = JSON.parse(readFileSync(new URL("./fixtures/mit-ai-setup-takes.json", import.meta.url), "utf8"));
const words = (s) => s.words.map(([word, start, end]) => ({ word, start, end }));
const restartsOf = (s) => narrationWords({ words: words(s), script: s.script, adopt: true, edits: true }).removed.filter((x) => x.kind === "restart").map((x) => x.text);

// The restarts a listener hears, by hand from the audio's transcript: must is cut, may is a
// restart too (found or not), anything else was said once and stays.
const truth = {
  "s04-byg-tjek": { must: ["Og jeg,", "men de har også..."] },
  "s09-browser": { must: ["Så bagefter kan jeg så se..."], may: ["Så bagefter kan jeg så se de ændringer, den har været igennem, og jeg får..."] },
  "s11-puljen": { must: ["Men dog kun, øh, fra samme,", "den måde, på"], may: ["Det vil sige, at hvis der er en af mine Claude-kontier, der rammer, øhm,", "Det vil sige, at hvis der er en af mine Claude-kontier, der rammer,"] },
  "s12-filer": { must: ["og det vil sige, at jeg ikke er."] },
  "s13-afslutning": { must: ["Og du kan jo for eksempel starte med at bygge to ting."] },
};

for (const s of scenes) {
  const { must = [], may = [] } = truth[s.scene] ?? {};
  test(`${s.scene}: only what was said again is a restart`, () => {
    const found = restartsOf(s);
    assert.deepEqual(found.filter((t) => !must.includes(t) && !may.includes(t)), [], "said once, left out");
    assert.deepEqual(must.filter((t) => !found.includes(t)), [], "restart missed");
  });
}

test("a phrase said once stays in the adopted narration", () => {
  const s = scenes.find((x) => x.scene === "s02-bb");
  const r = narrationWords({ words: words(s), script: s.script, adopt: true, edits: true });
  assert.match(r.text, /Og det fede ved det hele er, at det også er open source\./);
  assert.equal(r.words.length, s.words.length);
});

// Made-up takes: the shapes a restart and a once-said phrase take, small enough to read.
const said = (spec) => {
  const out = [];
  let t = 0;
  for (const w of spec.split(" ")) {
    if (w === "|") t += 0.7;
    else out.push({ word: w, start: +t.toFixed(3), end: +(t + 0.4).toFixed(3) }), (t += 0.5);
  }
  return out;
};
const cut = (spec, script) => narrationWords({ words: said(spec), script, adopt: true, edits: true }).removed.map((x) => x.text);

test("one word in common after a pause is no restart", () => {
  assert.deepEqual(cut("Det er gratis. | Og det er open source. | Og her har jeg projekter.", "Det er gratis. Jeg har projekter."), []);
  assert.deepEqual(cut("web og så videre, | så er det vigtigt", "Det er vigtigt."), []);
});

test("two sentences that start alike are no restart", () => {
  assert.deepEqual(cut("lige meget om det er Claude Code eller | det er Codex, de står i samme liste.", "Alle tråde står i samme liste."), []);
  assert.deepEqual(cut("det er ikke den tid, jeg har arbejdet, men det er | den tid, agenterne har kørt.", "Det er ikke mine timer."), []);
});

test("a restart said again in other words is still a restart", () => {
  assert.deepEqual(cut("men de har også... | men de er også trænet forskelligt.", "De er trænet forskelligt."), ["men de har også..."]);
  assert.deepEqual(cut("Men er | Men har den læst alle mails?", "Men har den læst alle mails?"), ["Men er"]);
  assert.deepEqual(cut("Og du kan jo starte med at bygge to ting. | Og du kunne jo starte med at tage to ting fra videoen.", "Start med to ting."), ["Og du kan jo starte med at bygge to ting."]);
});
