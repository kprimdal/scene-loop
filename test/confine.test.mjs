// confine(): a render worker's pages load only their own mirror. Needs Chrome; as root, run
// with CHROME_FLAGS=--no-sandbox. confine() is process-wide, so it has a test file of its own.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { findChrome, confine, withPage } from "../lib/chrome.mjs";

let chrome = null;
try { chrome = findChrome(); } catch {}

let dir, local;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "sl-confine-"));
  for (const d of ["root/mirror-a/.clip-1", "root/mirror-a/assets", "root/mirror-b/assets", "outside"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "root/mirror-a/assets/own.txt"), "own");
  writeFileSync(join(dir, "root/mirror-b/assets/other.txt"), "other video");
  writeFileSync(join(dir, "outside/secret.txt"), "secret");
  local = createServer((req, res) => res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("local service"));
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const read = (u) => `fetch(${JSON.stringify(u)}).then((r) => r.text(), () => "BLOCKED")`;
  writeFileSync(
    join(dir, "root/mirror-a/.clip-1/index.html"),
    `<html><body><iframe id="f" src="${pathToFileURL(join(dir, "outside/secret.txt"))}"></iframe><script>
      window.result = Promise.all([${[
        "../assets/own.txt",
        pathToFileURL(join(dir, "root/mirror-b/assets/other.txt")).href,
        pathToFileURL(join(dir, "outside/secret.txt")).href,
        `http://127.0.0.1:${local.address().port}/`,
        "data:text/plain,inline",
      ].map(read).join(", ")}]);
    </script></body></html>`,
  );
  confine(join(dir, "root"), ["https://allowed.example/"]);
});
after(() => {
  local?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a confined page reads its own mirror and data: URLs, and nothing else", { skip: !chrome && "no Chrome found" }, async () => {
  await withPage({ width: 320, height: 200 }, async (page) => {
    await page.goto(pathToFileURL(join(dir, "root/mirror-a/.clip-1/index.html")).href);
    assert.deepEqual(await page.evaluate("result"), ["own", "BLOCKED", "BLOCKED", "BLOCKED", "inline"]);
    assert.equal(await page.evaluate(`(() => { try { return document.getElementById("f").contentDocument?.body?.innerText ?? "" } catch { return "" } })()`), "");
    assert.ok(page.errors.some((e) => /blocked file:.*secret\.txt/.test(e)), "a blocked load is reported as a page error, so a render on the worker fails");
  });
});
