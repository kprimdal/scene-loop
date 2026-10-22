import { $, h, toast, ago } from "./util.js";
import { S, api } from "./state.js";

// ---------- renders ----------
export function renderRenders() {
  const list = $("#renderList");
  const rs = S.data.renders;
  const row = (r) =>
    h("div", { class: "row" },
      h("a", { href: r.url, target: "_blank" }, `${r.file}`, h("div", { class: "muted small" }, `${ago(r.at)} · ${Math.round(r.ms / 1000)} s`)),
      S.guest ? null : h("button", { class: "x", title: "Delete this render", onclick: () => removeRenders({ files: [r.file] }, r.file) }, "×"),
    );
  list.replaceChildren(...(rs.length ? rs.map(row) : [h("div", { class: "muted small", style: "padding:8px" }, "No renders yet.")]));
  if (rs.length > 1 && !S.guest) list.append(h("button", { class: "btn ghost small all", onclick: () => removeRenders({ keep: 1 }, `the ${rs.length - 1} older renders`) }, "Delete all but the newest"));
  $("#renderBtn").disabled = S.data.rendering;
}

// Delete renders after a confirm: the mp4 files go. The list follows through the project event.
async function removeRenders(args, what) {
  if (!confirm(`Delete ${what}? The file${args.keep != null ? "s are" : " is"} deleted.`)) return;
  try {
    const r = await api("/api/tools/delete_renders", { body: { args: { ...args, model: S.reviewer }, via: "page-js" } });
    toast(`Deleted ${r.deleted.length === 1 ? r.deleted[0] : `${r.deleted.length} renders`} (${(r.freedBytes / 1e6).toFixed(0)} MB).`);
  } catch (e) {
    toast(`Could not delete: ${e.message}`);
  }
}

$("#renderBtn").onclick = async () => {
  try {
    await api("/api/render", { body: {} });
  } catch (e) {
    toast(e.message);
  }
};
