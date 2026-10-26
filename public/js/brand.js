import { $, h, toast, bytes } from "./util.js";
import { S, api } from "./state.js";

// ---------- a project's brand kit (lib/brand.mjs) ----------
// On the project's page, above its videos: the logos, the colours, the fonts drawn in
// themselves and the rules. Edit opens brand.md and brand.css side by side; Add file puts a
// font or a logo in the brand folder.
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
        h("div", {}, h("b", {}, "Brand"), h("div", { class: "muted small" }, "No brand kit yet. Fonts, colours, logo and rules that every video in this project uses, so a new video starts on brand.")),
        h("div", { class: "spacer" }),
        h("button", { class: "btn small owner-only", onclick: () => openBrand(p.name, b) }, "Add brand kit"),
      ),
    );
  }
  loadFonts(b);
  const families = [...new Set(b.fonts.map((f) => f.family))];
  const others = b.files.filter((f) => f.kind !== "kit" && f.kind !== "font" && !b.logos.some((l) => l.path === f.path));
  box.replaceChildren(
    h("div", { class: "brand-head" },
      h("b", {}, "Brand"),
      h("span", { class: "muted small" }, `brand/ · used by every video here as assets/brand/`),
      h("div", { class: "spacer" }),
      h("label", { class: "btn small owner-only", title: "Put a font, a logo or an image in the brand folder" }, "Add file", h("input", { type: "file", hidden: true, accept: ".woff2,.woff,.ttf,.otf,.svg,.png,.jpg,.jpeg,.webp,.gif", onchange: (e) => addFile(p.name, e.target) })),
      h("button", { class: "btn small owner-only", onclick: () => openBrand(p.name, b) }, "Edit"),
    ),
    h("div", { class: "brand-grid" },
      b.logos.length ? h("div", { class: "brand-sec" }, h("div", { class: "brand-label" }, "Logo"), h("div", { class: "brand-logos" }, b.logos.map((l) => h("figure", {}, h("img", { src: l.url, alt: l.path }), h("figcaption", { class: "muted small" }, l.path))))) : null,
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
    b.markdown ? h("details", { class: "brand-rules" }, h("summary", {}, "Rules (brand.md)"), h("pre", {}, b.markdown)) : null,
  );
}

async function addFile(project, input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  const font = /\.(woff2?|ttf|otf)$/i.test(file.name);
  const path = prompt("Where in the brand folder?", (font ? "fonts/" : "") + file.name.toLowerCase().replace(/[^\w.-]+/g, "-"));
  if (!path) return;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const r = await tool("add_brand_file", { project, path, base64: btoa(bin), model: S.reviewer });
    toast(r.next ?? `Added ${r.asset}`);
    shown = null;
  } catch (e) {
    toast(e.message);
  }
}

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
