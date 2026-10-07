import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const core = new Function(`${readFileSync(new URL("../lib/anchor-core.js", import.meta.url), "utf8")}; return __slAnchorCore;`)();
const words = [
  { word: "Use", start: 0.1, end: 0.3 }, { word: "a", start: 0.3, end: 0.35 }, { word: "soft-bristled", start: 0.4, end: 0.9 }, { word: "brush.", start: 1.0, end: 1.3 },
  { word: "Then", start: 2.0, end: 2.2 }, { word: "brush", start: 2.3, end: 2.6 }, { word: "again.", start: 2.7, end: 3.0 },
];
const at = (spec) => core.at(words, 0.35, spec, 9);

test("a hyphenated word is one word, not a word and an offset", () => {
  assert.equal(at("word:soft-bristled").t, 0.75);
  assert.equal(at("word:softbristled").t, 0.75);
  assert.deepEqual(at("word:soft-bristled").warnings, []);
});
test("occurrence and offset still parse", () => {
  assert.equal(at("word:brush#2").t, 2.65);
  assert.equal(at("word:brush+0.3").t, 1.65);
  assert.equal(at("word:brush#2-0.25").t, 2.4);
  assert.equal(at("sentence:2+0.4").t, 2.75);
});
test("alternatives, fuzzy matches and misses are reported", () => {
  assert.equal(at("word:nothere|sentence:2").warnings.length, 1);
  assert.match(at("word:brushh").warnings[0], /not heard/);
  const miss = at("word:nothere");
  assert.equal(miss.resolved, false);
  assert.equal(miss.t, 9);
});
