// Needs Chrome (chrome-headless-shell or Google Chrome) and a network socket; skipped without Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { findChrome, launch } from "../lib/chrome.mjs";

let chrome = null;
try { chrome = findChrome(); } catch {}

test("a navigate that never answers fails the goto and leaves no unhandled rejection", { skip: !chrome && "no Chrome found" }, async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const srv = createServer(() => {}).listen(0, "127.0.0.1"); // accepts, never responds
  await new Promise((r) => srv.once("listening", r));
  const b = await launch();
  try {
    const page = await b.newPage();
    const t0 = Date.now();
    await assert.rejects(page.goto(`http://127.0.0.1:${srv.address().port}/`, 1500), /no answer from Chrome in 1.5 s/);
    assert.ok(Date.now() - t0 < 5000, "fails at the given timeout, not the 60 s default");
    await new Promise((r) => setTimeout(r, 2000)); // past the load wait's own timer
    await page.close();
  } finally {
    await b.close();
    srv.close();
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled.map(String), []);
});

test("a navigate error rejects the goto itself", { skip: !chrome && "no Chrome found" }, async () => {
  const b = await launch();
  try {
    const page = await b.newPage();
    await assert.rejects(page.goto("file:///nonexistent/scene-loop-test/index.html", 5000), /ERR_FILE_NOT_FOUND/);
    await page.close();
  } finally {
    await b.close();
  }
});
