import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFiles } from "../lib/walk.mjs";
import { filesFor } from "../lib/remote.mjs";

// A video the way a server holds it after previews: each scene's .preview/build links assets/
// and scenes/ back into the video, which is the loop that broke the render worker.
function video() {
  const v = mkdtempSync(join(tmpdir(), "sl-walk-"));
  const put = (rel, body = "x") => (mkdirSync(join(v, rel, ".."), { recursive: true }), writeFileSync(join(v, rel), body));
  put("storyboard.json", "{}");
  put("assets/theme.css");
  put("assets/fonts/a.woff2");
  put("assets/narration/s01.mp3");
  put("assets/narration.m4a");
  put("assets/takes/s01/1.webm");
  put("assets/clips/named.mp4");
  put("assets/clips/raw.mp4");
  truncateSync(join(v, "assets/clips/named.mp4"), 26 * 1024 * 1024);
  truncateSync(join(v, "assets/clips/raw.mp4"), 26 * 1024 * 1024);
  put("assets/node_modules/pkg/index.js");
  put("assets/.git/HEAD");
  for (const id of ["s01-intro", "s02-end"]) {
    put(`scenes/${id}/scene.html`, "<template></template>");
    put(`scenes/${id}/.preview/build/index.html`);
    put(`scenes/${id}/.preview/stills/a.png`);
    symlinkSync("../../../../assets", join(v, "scenes", id, ".preview", "build", "assets"));
    symlinkSync("../../..", join(v, "scenes", id, ".preview", "build", "scenes"));
  }
  symlinkSync("..", join(v, "scenes", "s01-intro", "up")); // a cycle outside .preview
  symlinkSync("../../assets/theme.css", join(v, "scenes", "s02-end", "theme.css")); // a linked file
  symlinkSync("missing", join(v, "assets", "dangling"));
  return v;
}

test("walkFiles terminates on symlink cycles and leaves out .preview, node_modules and .git", () => {
  const v = video();
  try {
    const paths = walkFiles(v).map((f) => f.path).sort();
    assert.deepEqual(paths, [
      "assets/clips/named.mp4",
      "assets/clips/raw.mp4",
      "assets/fonts/a.woff2",
      "assets/narration.m4a",
      "assets/narration/s01.mp3",
      "assets/takes/s01/1.webm",
      "assets/theme.css",
      "scenes/s01-intro/scene.html",
      "scenes/s02-end/scene.html",
      "storyboard.json",
    ]);
    // Without the skip list it still ends, and takes the preview files but no links.
    const all = walkFiles(v, "scenes", { skip: [] }).map((f) => f.path).sort();
    assert.deepEqual(all, [
      "scenes/s01-intro/.preview/build/index.html",
      "scenes/s01-intro/.preview/stills/a.png",
      "scenes/s01-intro/scene.html",
      "scenes/s02-end/.preview/build/index.html",
      "scenes/s02-end/.preview/stills/a.png",
      "scenes/s02-end/scene.html",
    ]);
    const f = walkFiles(v, "assets/fonts")[0];
    assert.equal(f.size, 1);
    assert.ok(f.mtimeMs > 0);
    assert.deepEqual(walkFiles(v, "nope"), []);
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test("filesFor sends the worker assets and scenes, without previews, links, narration, takes or unnamed large files", () => {
  const v = video();
  try {
    const files = filesFor(v, ['<video src="assets/clips/named.mp4">']);
    assert.deepEqual(files.map((f) => f.path).sort(), [
      "assets/clips/named.mp4",
      "assets/fonts/a.woff2",
      "assets/theme.css",
      "scenes/s01-intro/scene.html",
      "scenes/s02-end/scene.html",
    ]);
    const named = files.find((f) => f.path === "assets/clips/named.mp4");
    assert.equal(named.size, 26 * 1024 * 1024);
    assert.equal(named.mtime, Math.floor(named.mtime));
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});
