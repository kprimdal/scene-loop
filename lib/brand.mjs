// A project's brand kit: <project>/brand/ with
//   brand.md   the rules the chat reads for every video (palette, type, logo, what not to do)
//   brand.css  fonts, colours as custom properties, logo and other shared classes; loaded in
//              every video of the project before the video's own theme.css
//   anything else the two use: fonts/, logos, images.
// Every video of the project sees the folder as assets/brand/ (a link the app keeps), so
// brand.css names its files assets/brand/fonts/x.woff2 and the previews, the renders and a
// render worker resolve them like any other asset. A video's theme.css and frame.md stay for
// what is particular to that video.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { walkFiles } from "./walk.mjs";

export const BRAND_DIR = "brand";
export const BRAND_LINK = join("assets", "brand");
const IMAGE = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const FONT = new Set([".woff2", ".woff", ".ttf", ".otf"]);
export const BRAND_FILE = /^(?!\.)(?!.*\/\.)[\w.-]+(\/[\w.-]+)*$/; // relative, no dot files, no ..
const MAX_FILE = 25 * 1024 * 1024;

const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

export const BRAND_STARTER_MD = `# Brand

What every video in this project looks like. The chat reads this before it writes a scene.

## Colours

<!-- Name each colour and say what it is for. The values live in brand.css as --brand-* properties. -->

## Type

<!-- Which font for headlines, body and code, and the weights. -->

## Logo

<!-- Where it may sit (intro and outro only? a corner?), how big, on which backgrounds. -->

## Don't
`;

export const BRAND_STARTER_CSS = `/* The project's brand, loaded in every video before its theme.css.
   Files in the brand folder are assets/brand/... from a scene or a theme. */

/* @font-face { font-family: "Brand Sans"; src: url("assets/brand/fonts/brand-sans.woff2") format("woff2"); font-weight: 100 900; } */

:root {
  /* --brand-ink: #111111; */
  /* --brand-paper: #FAFAFA; */
  /* --brand-accent: #2F6FEB; */
}
`;

// What the page shows: the colours (custom properties with a colour value), the fonts
// (@font-face families and their files) and the logos (image files with "logo" in the name).
const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([^)]*\))$/i;
export function brandSummary(css, files) {
  const text = (css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const colours = [];
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    const value = m[2].trim();
    if (COLOUR.test(value) && !colours.some((c) => c.name === m[1])) colours.push({ name: m[1], value });
  }
  // The brand's own colours (--brand-*) first, then the rest as written.
  colours.sort((a, b) => b.name.startsWith("--brand-") - a.name.startsWith("--brand-"));
  const fonts = [];
  for (const m of text.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const family = /font-family\s*:\s*["']?([^"';]+)["']?/.exec(m[1])?.[1]?.trim();
    const src = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(m[1])?.[1];
    const weight = /font-weight\s*:\s*([^;]+)/.exec(m[1])?.[1]?.trim() ?? null;
    const style = /font-style\s*:\s*([^;]+)/.exec(m[1])?.[1]?.trim() ?? null;
    if (family) fonts.push({ family, src: src ?? null, weight, style });
  }
  const logos = files.filter((f) => IMAGE.has(extname(f.path).toLowerCase()) && /logo/i.test(f.path)).map((f) => f.path);
  return { colours, fonts, logos };
}

// The brand of the project in projectDir, or null when it has none.
export function readBrand(projectDir) {
  const d = join(projectDir, BRAND_DIR);
  if (!existsSync(d)) return null;
  const markdown = readIf(join(d, "brand.md"));
  const css = readIf(join(d, "brand.css"));
  const files = walkFiles(d).map((f) => ({ path: f.path, size: f.size, kind: f.path === "brand.md" || f.path === "brand.css" ? "kit" : FONT.has(extname(f.path).toLowerCase()) ? "font" : IMAGE.has(extname(f.path).toLowerCase()) ? "image" : "file" }));
  return { dir: d, markdown, css, files, ...brandSummary(css, files) };
}

// Keeps <video>/assets/brand a link to the project's brand folder. Leaves a real folder of that
// name alone (it would be the video's own files) and says so.
export function linkBrand(videoDir, projectDir) {
  const brand = join(projectDir, BRAND_DIR);
  const link = join(videoDir, BRAND_LINK);
  const target = relative(dirname(link), brand);
  const st = lstatSync(link, { throwIfNoEntry: false });
  if (!existsSync(brand)) {
    if (st?.isSymbolicLink()) unlinkSync(link);
    return null;
  }
  if (st && !st.isSymbolicLink()) return `${link} is a folder of the video's own, so the project's brand is not linked there`;
  if (st && readlinkSync(link) === target) return null;
  if (st) unlinkSync(link);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
  return null;
}

// Writes a file into the brand folder (a font, a logo). Returns its path in the folder.
export function writeBrandFile(projectDir, path, bytes) {
  if (!BRAND_FILE.test(path ?? "") || path.split("/").includes("..")) throw new Error("path: a relative path in the brand folder, e.g. fonts/brand-sans.woff2 or logo.svg");
  if (path === "brand.md" || path === "brand.css") throw new Error("brand.md and brand.css are written with set_brand");
  if (bytes.length > MAX_FILE) throw new Error("at most 25 MB per brand file");
  const f = join(projectDir, BRAND_DIR, path);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, bytes);
  return path;
}

export const brandFile = (projectDir, path) => {
  if (!BRAND_FILE.test(path ?? "") || path.split("/").includes("..")) return null;
  const f = join(projectDir, BRAND_DIR, path);
  return existsSync(f) && lstatSync(f).isFile() ? f : null;
};
