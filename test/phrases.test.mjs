import { test } from "node:test";
import assert from "node:assert/strict";
import { phrases } from "../public/js/phrases.js";

const words = (x) => x.split(/\s+/).filter(Boolean).length;

test("long sentences become short phrases under the lens", () => {
  const text = "Hvis du for eksempel tager en helt almindelig opgave, så beder du AI'en om at samle priser fra tre leverandører. Den svarer, at oversigten er klar, og der er en pæn tabel og en anbefaling. Det ser færdigt ud.";
  const out = phrases(text);
  assert.equal(out.join(" "), text.replace(/\s+/g, " "));
  for (const p of out) assert.ok(words(p) <= 10, p);
  assert.equal(out.at(-1), "Det ser færdigt ud.");
});

test("short sentences stay whole", () => {
  assert.deepEqual(phrases("Passer fakta? Find noget i kilden."), ["Passer fakta?", "Find noget i kilden."]);
});

test("keep the take only after a spelling fix", async () => {
  const { spellingOnly } = await import("../lib/video.mjs");
  assert.equal(spellingOnly(["Christian", "byggede", "det."], "Kristian byggede det."), null);
  assert.match(spellingOnly(["Men", "er", "den", "det?"], "Men er det?"), /4 words/);
  assert.match(spellingOnly(["på", "tabellen."], "i tabellen."), /"på"/);
  assert.match(spellingOnly(null, "x"), /no timed words/);
});
