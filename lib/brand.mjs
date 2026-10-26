// A project's brand kit: <project>/brand/ with
//   brand.md   the rules the chat reads for every video (palette, type, logo, what not to do)
//   brand.css  fonts, colours as custom properties, logo and other shared classes; loaded in
//              every video of the project before the video's own theme.css
//   anything else the two use: fonts/, logos, images/ (photos, icons, backgrounds).
// Every video of the project sees the folder as assets/brand/ (a link the app keeps), so
// brand.css names its files assets/brand/fonts/x.woff2 and the previews, the renders and a
// render worker resolve them like any other asset. A video's theme.css and frame.md stay for
// what is particular to that video.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

## Images

<!-- What each image in the kit is and when a scene may use it, e.g. images/team.jpg: the team, for the outro only. -->

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
// (@font-face families and their files), the logos (image files with "logo" in the name) and
// the other images.
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
  const isImage = (f) => IMAGE.has(extname(f.path).toLowerCase());
  const logos = files.filter((f) => isImage(f) && /logo/i.test(f.path)).map((f) => f.path);
  const images = files.filter((f) => isImage(f) && !logos.includes(f.path)).map((f) => f.path);
  return { colours, fonts, logos, images };
}

// The brand of the project in projectDir, or null when it has none.
export function readBrand(projectDir) {
  const d = join(projectDir, BRAND_DIR);
  if (!existsSync(d)) return null;
  const markdown = readIf(join(d, "brand.md"));
  const css = readIf(join(d, "brand.css"));
  const files = walkFiles(d).map((f) => {
    const ext = extname(f.path).toLowerCase();
    const kind = f.path === "brand.md" || f.path === "brand.css" ? "kit" : FONT.has(ext) ? "font" : IMAGE.has(ext) ? "image" : "file";
    return { path: f.path, size: f.size, kind, ...(kind === "image" ? imageSize(join(d, f.path)) : {}) };
  });
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

// Removes a file from the brand folder, and the folders it leaves empty.
export function removeBrandFile(projectDir, path) {
  if (path === "brand.md" || path === "brand.css") throw new Error("brand.md and brand.css are part of the kit; change them with set_brand");
  const f = brandFile(projectDir, path);
  if (!f) throw new Error(`no file ${path} in the brand folder`);
  unlinkSync(f);
  const root = join(projectDir, BRAND_DIR);
  for (let d = dirname(f); d !== root && d.startsWith(root); d = dirname(d)) {
    try { rmdirSync(d); } catch { break; }
  }
  return path;
}

// { width, height } of a png, gif, jpeg, webp or svg from its first bytes, or {} when they
// do not say. The chat places a logo by its aspect; the page shows the size.
export function imageSize(file) {
  let buf;
  try {
    const fd = openSync(file, "r");
    buf = Buffer.alloc(256 * 1024);
    buf = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
    closeSync(fd);
  } catch {
    return {};
  }
  const size = (width, height) => (width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : {});
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return size(buf.readUInt32BE(16), buf.readUInt32BE(20));
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "GIF") return size(buf.readUInt16LE(6), buf.readUInt16LE(8));
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8X") return size(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
    if (chunk === "VP8L") { const b = buf.readUInt32LE(21); return size(1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)); }
    if (chunk === "VP8 ") return size(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    return {};
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length; ) {
      if (buf[i] !== 0xff) return {};
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return size(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return {};
  }
  const svg = /<svg\b[^>]*>/i.exec(buf.toString("utf8"))?.[0];
  if (svg) {
    const attr = (n) => new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`).exec(svg)?.[1];
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(svg);
    const w = Number(attr("width") ?? vb?.[1]), h = Number(attr("height") ?? vb?.[2]);
    return size(w, h);
  }
  return {};
}

export const brandFile = (projectDir, path) => {
  if (!BRAND_FILE.test(path ?? "") || path.split("/").includes("..")) return null;
  const f = join(projectDir, BRAND_DIR, path);
  return existsSync(f) && lstatSync(f).isFile() ? f : null;
};
