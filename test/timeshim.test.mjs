// Scene scripts on the page clock (lib/timeshim.js): requestAnimationFrame, timers, Date,
// performance.now and Math.random move with seek(), so a fresh page opened at a time shows
// what a page played up to it shows. Needs Chrome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildScene } from "../lib/assemble.mjs";
import { withPage, findChrome } from "../lib/chrome.mjs";
import { analyze } from "../lib/composite.mjs";

let chrome = true;
try { findChrome(); } catch { chrome = false; }

const HTML = `<template>
<style>
  #s1-late { opacity: 0; transition: opacity 1s linear; }
  #s1-late.on { opacity: 1; }
</style>
<div id="root" data-composition-id="s1" data-width="640" data-height="360" data-duration="3">
  <div id="s1-count">-</div><div id="s1-ticks">-</div><div id="s1-late">late</div><div id="s1-wave"></div>
</div>
<script>
(function () {
  var start = performance.now(), frames = 0;
  function tick(now) {
    frames++;
    document.getElementById("s1-count").textContent = ((now - start) / 1000).toFixed(3) + " " + frames;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  var ticks = 0;
  setInterval(function () { ticks++; document.getElementById("s1-ticks").textContent = ticks + " " + (Date.now() - new Date(2026, 0, 1).getTime()) + " " + Math.random().toFixed(6); }, 250);
  setTimeout(function () { document.getElementById("s1-late").classList.add("on"); }, 1000);
  setTimeout(function () { document.getElementById("s1-wave").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, fill: "both" }); }, 2000);
})();
</script>
</template>
`;
const sb = { width: 640, height: 360, background: "#fff", scenes: [{ id: "s1", start: 0, duration: 3 }], duration: 3 };

let dir, url;
before(() => {
  if (!chrome) return;
  dir = mkdtempSync(join(tmpdir(), "sl-time-"));
  mkdirSync(join(dir, "scenes", "s1"), { recursive: true });
  url = pathToFileURL(join(buildScene(dir, sb, "s1", HTML, "b"), "index.html")).href;
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

const STATE = `({ count: document.getElementById("s1-count").textContent, ticks: document.getElementById("s1-ticks").textContent, late: getComputedStyle(document.getElementById("s1-late")).opacity, wave: getComputedStyle(document.getElementById("s1-wave")).opacity })`;
async function at(times, fn) {
  return withPage({ width: 640, height: 360 }, async (page) => {
    await page.goto(url);
    await page.evaluate("window.__sl.ready");
    let state;
    for (const t of times) {
      await page.evaluate(`window.__sl.seek(${t})`);
      state = await page.evaluate(STATE);
    }
    if (fn) state.extra = await fn(page);
    assert.deepEqual(page.errors, []);
    return state;
  });
}

test("a page opened at a time shows what a page played up to it shows", { skip: !chrome && "no Chrome" }, async () => {
  const fresh = await at([1.5]);
  const stepped = await at([0.5, 1.0, 1.5]);
  const played = await at(Array.from({ length: 46 }, (_, i) => i / 30));
  assert.deepEqual(stepped, fresh);
  assert.deepEqual(played, fresh);
  assert.equal(fresh.count, "1.500 46", "the frame callback ran at every frame from 0 to 1.5 s");
  assert.match(fresh.ticks, /^6 1500 0\.\d{6}$/, "six interval ticks, Date at 1.5 s");
  assert.ok(Math.abs(Number(fresh.late) - 0.5) < 0.02, `a transition started at 1 s is half way at 1.5 s: ${fresh.late}`);
  assert.equal(fresh.wave, "1", "the timer that starts an animation at 2 s has not fired at 1.5 s");
});

test("an animation a timer starts runs from that time", { skip: !chrome && "no Chrome" }, async () => {
  const s = await at([2.5]);
  assert.ok(Math.abs(Number(s.wave) - 0.5) < 0.02, `el.animate() from a timer at 2 s is half way at 2.5 s: ${s.wave}`);
  assert.equal(s.late, "1");
});

test("a seek back shows the time it went to, for code that draws from the time it is given", { skip: !chrome && "no Chrome" }, async () => {
  const s = await at([2, 0.5]);
  assert.match(s.count, /^0\.500 /);
});

test("the static-stretch shortcut leaves such a scene to render frame by frame", { skip: !chrome && "no Chrome" }, async () => {
  const s = await at([0], (page) => analyze(page));
  assert.match(s.extra.reason, /timers or requestAnimationFrame/);
});
