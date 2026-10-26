import { $, h, toast, bytes } from "./util.js";
import { S, api } from "./state.js";

// ---------- a project's brand kit (lib/brand.mjs) ----------
// On the project's page, above its videos: the logos, the colours, the fonts drawn in
// themselves, the images and the rules. Edit opens brand.md and brand.css side by side; Add
// files (or a drop on the panel) puts fonts, logos and images in the brand folder.
const tool = (name, args) => api(`/api/tools/${name}`, { body: { args, via: "page-js" } });

let shown = null; // { project, json } of what the panel shows, so a live update that changed nothing does not redraw it
const loadedFonts = new Set();

// The fonts under their own names, prefixed so a brand font never replaces the page's own.
function loadFonts(b) {
  for (const f of b.fonts ?? []) {
    if (!f.url) continue;
    const key = `${f.family}|${f.url}|${f.weight}|${f.style}`;
    if (loadedFonts.has(key)) continue;
    loadedFonts.add(key);
    const face = new FontFace(`brand-${f.family}`, `url("${f.url}")`, { ...(f.weight ? { weight: f.weight } : {}), ...(f.style ? { style: f.style } : {}) });
    face.load().then((x) => document.fonts.add(x)).catch(() => {});
  }
}

// A kit of product mockups can hold a hundred colours; the first ones show, the rest fold away.
const SWATCHES = 18;
const swatch = (c) => h("div", { class: "swatch", title: `var(${c.name})` }, h("span", { class: "chip-c", style: `background:${c.value}` }), h("div", {}, h("div", { class: "small" }, c.name.replace(/^--/, "")), h("div", { class: "muted small mono" }, c.value)));

// A logo or an image: the picture on a checkerboard (a white logo shows), its path and size.
// A click copies the path a scene uses; × takes it out of the kit.
// A logo named white, light or inverse is for dark backgrounds, so it starts on a dark one; ◐ swaps.
function tile(project, img, cls) {
  const dims = img.width ? `${img.width}×${img.height} · ` : "";
  const dark = cls.includes("logo") && /white|light|invers|negativ|knockout/i.test(img.path);
  const fig = h("figure", { class: cls + (dark ? " dark" : ""), title: `${img.asset}\nClick to copy the path a scene uses` },
    h("img", { src: img.url, alt: img.path, loading: "lazy", onclick: () => copy(img.asset) }),
    h("figcaption", {}, h("div", { class: "small" }, img.path), h("div", { class: "muted small" }, dims + bytes(img.size))),
    h("button", { class: "tile-x owner-only", title: `Remove ${img.path} from the brand kit`, onclick: () => removeFile(project, img.path) }, "×"),
    h("button", { class: "tile-bg", title: "Light or dark background", onclick: () => fig.classList.toggle("dark") }, "◐"),
  );
  return fig;
}
const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast(`Copied ${text}`), () => toast(text)) ?? toast(text);

export async function renderBrand(p) {
  const box = $("#pBrand");
  if (p.layout !== "project" || S.guest) return (box.hidden = true);
  let b;
  try {
    b = await tool("get_brand", { project: p.name });
  } catch (e) {
    box.hidden = false;
    return box.replaceChildren(h("div", { class: "muted small" }, e.message));
  }
  const json = JSON.stringify(b);
  if (shown?.project === p.name && shown.json === json) return;
  shown = { project: p.name, json };
  box.hidden = false;
  if (!b.exists) {
    return box.replaceChildren(
      h("div", { class: "brand-empty" },
        h("div", {}, h("b", {}, "Brand"), h("div", { class: "muted small" }, "No brand kit yet. Fonts, colours, logos, images and rules that every video in this project uses, so a new video starts on brand.")),
        h("div", { class: "spacer" }),
        h("button", { class: "btn small owner-only", onclick: () => openBrand(p.name, b) }, "Add brand kit"),
      ),
    );
  }
  loadFonts(b);
  const families = [...new Set(b.fonts.map((f) => f.family))];
  const others = b.files.filter((f) => f.kind === "file");
  box.replaceChildren(
    h("div", { class: "brand-head" },
      h("b", {}, "Brand"),
      h("span", { class: "muted small" }, `brand/ · used by every video here as assets/brand/`),
      h("div", { class: "spacer" }),
      h("label", { class: "btn small owner-only", title: "Put fonts, logos and images in the brand folder. You can also drop files on this panel." }, "Add files", h("input", { type: "file", hidden: true, multiple: true, accept: ACCEPT, onchange: (e) => addFiles(p.name, e.target) })),
      h("button", { class: "btn small owner-only", onclick: () => openBrand(p.name, b) }, "Edit"),
    ),
    h("div", { class: "brand-grid" },
      b.logos.length ? h("div", { class: "brand-sec" }, h("div", { class: "brand-label" }, "Logo"), h("div", { class: "brand-logos" }, b.logos.map((l) => tile(p.name, l, "brand-tile logo")))) : null,
      h("div", { class: "brand-sec" }, h("div", { class: "brand-label" }, "Colours"),
        b.colours.length
          ? [h("div", { class: "brand-swatches" }, b.colours.slice(0, SWATCHES).map(swatch)),
             b.colours.length > SWATCHES ? h("details", { class: "brand-more" }, h("summary", {}, `${b.colours.length - SWATCHES} more colour${b.colours.length - SWATCHES === 1 ? "" : "s"}`), h("div", { class: "brand-swatches" }, b.colours.slice(SWATCHES).map(swatch))) : null]
          : h("div", { class: "muted small" }, "No colours in brand.css yet. Name them as custom properties, e.g. --brand-accent: #2F6FEB.")),
      h("div", { class: "brand-sec" }, h("div", { class: "brand-label" }, "Type"),
        families.length
          ? h("div", { class: "brand-fonts" }, families.map((f) => h("div", { class: "font-row" }, h("div", { class: "font-sample", style: `font-family:"brand-${f}", ui-sans-serif` }, "Aa Bb Cc 123 æøå"), h("div", { class: "muted small" }, f, ` · ${b.fonts.filter((x) => x.family === f).length} file${b.fonts.filter((x) => x.family === f).length === 1 ? "" : "s"}`))))
          : h("div", { class: "muted small" }, "No fonts yet. Add the file, then declare it with @font-face in brand.css.")),
      others.length ? h("div", { class: "brand-sec" }, h("div", { class: "brand-label" }, "Other files"), h("div", { class: "muted small mono" }, others.map((f) => h("div", {}, `${f.path} · ${bytes(f.size)}`)))) : null,
    ),
    b.images.length ? h("div", { class: "brand-sec brand-images-sec" }, h("div", { class: "brand-label" }, `Images · ${b.images.length}`), h("div", { class: "brand-images" }, b.images.map((i) => tile(p.name, i, "brand-tile")))) : null,
    b.markdown ? h("details", { class: "brand-rules" }, h("summary", {}, "Rules (brand.md)"), h("pre", {}, b.markdown)) : null,
  );
}

const ACCEPT = ".woff2,.woff,.ttf,.otf,.svg,.png,.jpg,.jpeg,.webp,.gif";
const FONT = /\.(woff2?|ttf|otf)$/i, IMAGE = /\.(svg|png|jpe?g|webp|gif)$/i;
// Where a file goes in the brand folder: fonts in fonts/, a logo at the top, other images in images/.
const placeFor = (name) => {
  const n = name.toLowerCase().replace(/[^\w.-]+/g, "-").replace(/^[-.]+/, "");
  return FONT.test(n) ? `fonts/${n}` : IMAGE.test(n) && !/logo/.test(n) ? `images/${n}` : n;
};

// One file asks where it goes; several (or a drop) go where placeFor puts them.
async function addFiles(project, files) {
  if (files instanceof HTMLInputElement) {
    const input = files;
    files = [...input.files];
    input.value = "";
  }
  files = files.filter((f) => FONT.test(f.name) || IMAGE.test(f.name));
  if (!files.length) return toast("Fonts and images only: woff2, woff, ttf, otf, svg, png, jpg, webp, gif.");
  let paths = files.map((f) => placeFor(f.name));
  if (files.length === 1) {
    const path = prompt("Where in the brand folder?", paths[0]);
    if (!path) return;
    paths = [path];
  }
  const added = [];
  for (const [i, file] of files.entries()) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let j = 0; j < buf.length; j += 0x8000) bin += String.fromCharCode(...buf.subarray(j, j + 0x8000));
      const r = await tool("add_brand_file", { project, path: paths[i], base64: btoa(bin), model: S.reviewer });
      added.push(r);
    } catch (e) {
      toast(`${file.name}: ${e.message}`);
    }
  }
  shown = null;
  if (added.length === 1) toast(added[0].next ?? `Added ${added[0].asset}`);
  else if (added.length) toast(`Added ${added.length} files to the brand kit.${added.some((r) => r.next) ? " Declare the fonts with @font-face in brand.css." : ""}`);
}

async function removeFile(project, path) {
  if (!confirm(`Remove ${path} from the brand kit? Every video in the project loses it.`)) return;
  try {
    const r = await tool("remove_brand_file", { project, path, model: S.reviewer });
    shown = null;
    toast(r.stillNamedIn ? `Removed ${path}. Still named in ${r.stillNamedIn.join(", ")}.` : `Removed ${path}.`);
  } catch (e) {
    toast(e.message);
  }
}

// Files dropped anywhere on the panel go in the kit.
const panel = $("#pBrand");
panel.addEventListener("dragover", (e) => {
  if (S.guest || !shown || !e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  panel.classList.add("drop");
});
panel.addEventListener("dragleave", (e) => !panel.contains(e.relatedTarget) && panel.classList.remove("drop"));
panel.addEventListener("drop", (e) => {
  panel.classList.remove("drop");
  if (S.guest || !shown || !e.dataTransfer?.files.length) return;
  e.preventDefault();
  addFiles(shown.project, [...e.dataTransfer.files]);
});

// ---------- the editor: brand.md and brand.css ----------
let editing = null; // { project, md, css } as loaded
function openBrand(project, b) {
  editing = { project, md: b.markdown ?? b.starter?.markdown ?? "", css: b.css ?? b.starter?.css ?? "" };
  $("#brandMd").value = editing.md;
  $("#brandCss").value = editing.css;
  $("#brandSub").textContent = b.dir;
  $("#brandState").textContent = b.exists ? "" : "No brand kit yet. Save makes one.";
  $("#brandDrawer").hidden = $("#brandShade").hidden = false;
  for (const id of ["#brandMd", "#brandCss"]) $(id).scrollTop = 0;
  $("#brandMd").setSelectionRange(0, 0);
  $("#brandMd").focus();
}
const dirty = () => editing && ($("#brandMd").value !== editing.md || $("#brandCss").value !== editing.css);
export function closeBrand(force) {
  if ($("#brandDrawer").hidden) return;
  if (!force && dirty() && !confirm("Close without saving your changes?")) return;
  $("#brandDrawer").hidden = $("#brandShade").hidden = true;
}
async function saveBrand() {
  try {
    $("#brandState").textContent = "Saving…";
    const markdown = $("#brandMd").value, css = $("#brandCss").value;
    const r = await tool("set_brand", { project: editing.project, markdown, css, note: "edited in the page", model: S.reviewer });
    editing = { ...editing, md: markdown, css };
    $("#brandState").textContent = r.unchanged ? "No changes." : `Saved as project v${r.version}. ${r.videos === 1 ? "1 video uses" : `${r.videos} videos use`} it.`;
    shown = null;
  } catch (e) {
    $("#brandState").textContent = e.message;
  }
}

$("#brandClose").onclick = $("#brandCancel").onclick = () => closeBrand();
$("#brandShade").onclick = () => closeBrand();
$("#brandSave").onclick = saveBrand;
for (const id of ["#brandMd", "#brandCss"])
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), saveBrand());
    if (e.key === "Escape") closeBrand();
  });
