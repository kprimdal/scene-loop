import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRegistry, TEMPLATE_DIR } from "../lib/projects.mjs";
import { callTool } from "../lib/tools.mjs";
import { filesFor } from "../lib/remote.mjs";
import { brandSummary } from "../lib/brand.mjs";

const CSS = `@font-face { font-family: "Brand Sans"; src: url("assets/brand/fonts/brand-sans.woff2") format("woff2"); font-weight: 100 900; }
:root { --brand-ink: #111111; --brand-accent: rgb(47 111 235); --brand-gap: 24px; }
.scene { font-family: "Brand Sans" !important; }
`;

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
});
