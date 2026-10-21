import { test } from "node:test";
import assert from "node:assert/strict";

test("keep the take only after a spelling fix", async () => {
  const { spellingOnly } = await import("../lib/video.mjs");
  assert.equal(spellingOnly(["Christian", "byggede", "det."], "Kristian byggede det."), null);
  assert.match(spellingOnly(["Men", "er", "den", "det?"], "Men er det?"), /4 words/);
  assert.match(spellingOnly(["på", "tabellen."], "i tabellen."), /"på"/);
  assert.match(spellingOnly(null, "x"), /no timed words/);
});
