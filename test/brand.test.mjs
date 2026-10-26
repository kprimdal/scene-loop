import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRegistry, TEMPLATE_DIR } from "../lib/projects.mjs";
import { callTool } from "../lib/tools.mjs";
import { filesFor } from "../lib/remote.mjs";
import { brandSummary, imageSize } from "../lib/brand.mjs";

const CSS = `@font-face { font-family: "Brand Sans"; src: url("assets/brand/fonts/brand-sans.woff2") format("woff2"); font-weight: 100 900; }
:root { --brand-ink: #111111; --brand-accent: rgb(47 111 235); --brand-gap: 24px; }
.scene { font-family: "Brand Sans" !important; }
`;

// A 3×2 png.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGP4z8DwHwYZYBwAj8EM9Lc7k2cAAAAASUVORK5CYII=", "base64");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sl-brand-"));
  cpSync(TEMPLATE_DIR, join(root, "one", "videos", "demo"), { recursive: true });
  cpSync(TEMPLATE_DIR, join(root, "old"), { recursive: true }); // a video-folder project
  const registry = createRegistry(root, { reviewer: "Tester", emit() {} });
  const ctx = { registry, via: "mcp", origin: "http://localhost" };
  const call = (name, args = {}) => callTool(name, { project: "one", video: "demo", model: "Tester", ...args }, ctx);
  return { root, registry, call };
}

test("a project's brand kit: saved as a version, linked into every video, in every page and in the rules", async (t) => {
  const { root, registry, call } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const v = await registry.get("one", "demo");
  const sb0 = v.storyboard();
  const key0 = v.clipKey(sb0.scenes[0], 1, "<template></template>", sb0, 30);

  const none = await call("get_brand");
  assert.equal(none.exists, false);
  assert.match(none.starter.css, /assets\/brand\//);
  assert.equal((await call("get_rules")).brand, null);
  assert.equal(existsSync(join(v.dir, "assets", "brand")), false);

  const saved = await call("set_brand", { markdown: "# Brand\nThe logo sits on the outro only.", css: CSS, note: "first brand" });
  assert.ok(saved.version >= 1);
  assert.equal(saved.videos, 1);
  const tags = execFileSync("git", ["--git-dir", join(root, "one", ".history"), "tag", "-l", "project/v*"], { encoding: "utf8" });
  assert.match(tags, /project\/v\d/);
  assert.equal((await call("set_brand", { css: CSS })).unchanged, true);

  await call("add_brand_file", { path: "fonts/brand-sans.woff2", base64: Buffer.from("not really a font").toString("base64") });
  await call("add_brand_file", { path: "logo.svg", base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64") });
  await assert.rejects(call("add_brand_file", { path: "../escape.txt", base64: "eA==" }), /relative path/);
  await assert.rejects(call("add_brand_file", { path: "brand.css", base64: "eA==" }), /set_brand/);

  // The video sees the brand folder as assets/brand.
  assert.ok(lstatSync(join(v.dir, "assets", "brand")).isSymbolicLink());
  assert.equal(readFileSync(join(v.dir, "assets", "brand", "fonts", "brand-sans.woff2"), "utf8"), "not really a font");

  const b = await call("get_brand");
  assert.equal(b.exists, true);
  assert.deepEqual(b.colours.map((c) => c.name), ["--brand-ink", "--brand-accent"]);
  assert.deepEqual(b.fonts.map((f) => [f.family, f.url]), [["Brand Sans", "/brand/one/fonts/brand-sans.woff2"]]);
  assert.deepEqual(b.logos.map((l) => l.asset), ["assets/brand/logo.svg"]);
  assert.equal(registry.brandPath("one", "fonts/brand-sans.woff2"), join(root, "one", "brand", "fonts", "brand-sans.woff2"));
  assert.equal(registry.brandPath("one", "../project.md"), null);

  // The rules carry it, and the page has the brand before the video's theme.
  const rules = await call("get_rules");
  assert.match(rules.brand.markdown, /outro only/);
  assert.deepEqual(rules.brand.files.sort(), ["assets/brand/fonts/brand-sans.woff2", "assets/brand/logo.svg"]);
  assert.match(rules.brandContract, /assets\/brand/);
  await call("set_theme_css", { css: ".scene { color: var(--brand-ink); }" });
  const { url } = await v.sceneBuildUrl(sb0.scenes[0].id, "disk");
  const build = join(v.dir, url.split("?")[0].replace(/^\/p\/one\/demo\//, ""));
  const html = readFileSync(build, "utf8");
  assert.ok(html.indexOf('id="project-brand"') > 0 && html.indexOf('id="project-brand"') < html.indexOf('id="project-theme"'));
  assert.equal(readFileSync(join(build, "..", "assets", "brand", "fonts", "brand-sans.woff2"), "utf8"), "not really a font");

  // A render worker gets the brand files as assets/brand/...; the storyboard on disk never holds the css.
  assert.ok(filesFor(v.dir, [html]).some((f) => f.path === "assets/brand/fonts/brand-sans.woff2"));
  await call("set_video", { title: "Renamed" });
  assert.equal(JSON.parse(readFileSync(join(v.dir, "storyboard.json"), "utf8")).brandCss, undefined);

  // The brand is part of a clip's key; a new video gets the link too.
  const sb1 = v.storyboard();
  assert.notEqual(v.clipKey(sb1.scenes[0], 1, "<template></template>", sb1, 30), key0);
  await call("create_video", { name: "second" });
  assert.ok(lstatSync(join(root, "one", "videos", "second", "assets", "brand")).isSymbolicLink());
  assert.equal((await registry.list()).find((p) => p.name === "one").brand, true);

  // Images: listed apart from the logos, with their size, in the page and in the rules; removable.
  await call("add_brand_file", { path: "images/team.png", base64: PNG.toString("base64") });
  const withImage = await call("get_brand");
  assert.deepEqual(withImage.images.map((i) => [i.path, i.width, i.height, i.url]), [["images/team.png", 3, 2, "/brand/one/images/team.png"]]);
  assert.deepEqual(withImage.logos.map((l) => l.path), ["logo.svg"]);
  assert.deepEqual((await call("get_rules")).brand.images, [{ asset: "assets/brand/images/team.png", width: 3, height: 2 }]);
  await call("set_theme_css", { css: '.scene { background: url("assets/brand/images/team.png"); }' });
  const gone = await call("remove_brand_file", { path: "images/team.png" });
  assert.equal(gone.removed, "images/team.png");
  assert.deepEqual(gone.stillNamedIn, ["demo"]);
  assert.equal(existsSync(join(root, "one", "brand", "images")), false);
  assert.deepEqual((await call("get_brand")).images, []);
  await assert.rejects(call("remove_brand_file", { path: "brand.css" }), /set_brand/);
  await assert.rejects(call("remove_brand_file", { path: "nope.png" }), /no file/);

  // A video-folder project has no project above it, so no brand.
  await assert.rejects(callTool("get_brand", { project: "old", model: "Tester" }, { registry, via: "mcp" }), /single video folder/);
});

test("without a brand the storyboard has no brandCss, so clip keys stay as they were", async (t) => {
  const { root, registry } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const v = await registry.get("one", "demo");
  const sb = v.storyboard();
  assert.equal("brandCss" in sb, false);
});

test("brandSummary reads colours, fonts and logos and skips comments", () => {
  const s = brandSummary(`/* --brand-old: #000; */ :root { --a: #fff; --b: 12px; --c: hsl(10 20% 30%); --brand-x: #123; } @font-face { font-family: 'X'; src: url(assets/brand/x.woff2); font-style: italic; }`, [{ path: "img/logo-dark.svg" }, { path: "photo.jpg" }]);
  assert.deepEqual(s.colours, [{ name: "--brand-x", value: "#123" }, { name: "--a", value: "#fff" }, { name: "--c", value: "hsl(10 20% 30%)" }]);
  assert.deepEqual(s.fonts, [{ family: "X", src: "assets/brand/x.woff2", weight: null, style: "italic" }]);
  assert.deepEqual(s.logos, ["img/logo-dark.svg"]);
  assert.deepEqual(s.images, ["photo.jpg"]);
});

test("imageSize reads png, gif, jpeg, webp and svg headers", (t) => {
  const d = mkdtempSync(join(tmpdir(), "sl-img-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const at = (name, bytes) => (writeFileSync(join(d, name), bytes), imageSize(join(d, name)));
  assert.deepEqual(at("a.png", PNG), { width: 3, height: 2 });
  assert.deepEqual(at("a.gif", Buffer.from("R0lGODlhBQAEAIAAAP///wAAACwAAAAABQAEAAACBISPqVcAOw==", "base64")), { width: 5, height: 4 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 40, 0, 120, 1, 1, 0x11, 0]);
  assert.deepEqual(at("a.jpg", jpeg), { width: 120, height: 40 });
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0); webp.write("WEBP", 8); webp.write("VP8X", 12); webp.writeUIntLE(639, 24, 3); webp.writeUIntLE(359, 27, 3);
  assert.deepEqual(at("a.webp", webp), { width: 640, height: 360 });
  assert.deepEqual(at("a.svg", '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="200px" height="50">'), { width: 200, height: 50 });
  assert.deepEqual(at("b.svg", '<svg viewBox="0 0 120 30" width="100%">'), { width: 120, height: 30 });
  assert.deepEqual(at("c.svg", "<svg/>"), {});
  assert.deepEqual(at("x.txt", "hello"), {});
});
