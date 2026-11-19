import { $, h, toast, ago, bytes } from "./util.js";
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
  if (!S.guest) list.append(h("button", { class: "btn ghost small all", id: "pruneBtn", title: "Delete what only older versions use, after showing how much each part frees", onclick: openPrune }, "Free disk space…"));
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

// Free disk space: a dry run of prune_video first, its numbers per part with a box each, and
// only then the delete. Takes and media are raw recordings and copies nothing can bring back.
const PRUNE_PARTS = [
  ["renders", "Older renders", (d) => `Every render but the newest ${d.keptRenders === 1 ? "one" : d.keptRenders}, and unfinished render files.`, false, true],
  ["takes", "Unused takes", "Recordings no scene uses. The chosen takes stay.", true, true],
  ["stills", "Older versions' stills", "Each scene's latest version keeps its stills. Comment stills stay.", false, true],
  ["media", "Older versions' camera clip and voice", "An older version then plays the current camera clip and voice.", true, true],
  ["cache", "Render cache", "The next render renders every scene again.", false, false],
];
async function openPrune() {
  $("#renderList").closest("details").open = false;
  if (S.data.rendering) return toast("A render is running. Free disk space after it finishes.");
  let dry;
  try {
    dry = await api("/api/tools/prune_video", { body: { args: { renders: true, takes: true, stills: true, media: true, cache: true, dryRun: true }, via: "page-js" } });
  } catch (e) {
    return toast(`Could not count: ${e.message}`);
  }
  const boxes = {};
  const total = h("b", {});
  const go = h("button", { class: "btn dark", onclick: () => prune() }, "Delete");
  const sum = () => {
    const n = PRUNE_PARTS.reduce((a, [k]) => a + (boxes[k].checked ? dry.byBucket[k] : 0), 0);
    total.textContent = bytes(n);
    go.disabled = n === 0;
  };
  const dialog = h("dialog", { class: "prune-dialog" },
    h("h2", {}, "Free disk space"),
    h("p", { class: "muted small" }, "What this video can delete now. The latest version of every scene, the chosen takes, the newest renders, the version history and the scenes stay."),
    h("div", { class: "prune-parts" }, PRUNE_PARTS.map(([k, label, note, irreversible, on]) => {
      boxes[k] = h("input", { type: "checkbox", name: k, checked: on && dry.byBucket[k] > 0, disabled: dry.byBucket[k] === 0, onchange: sum });
      return h("label", { class: "prune-part" }, boxes[k],
        h("span", {}, h("span", {}, label, irreversible ? h("span", { class: "prune-irrev" }, "irreversible") : null), h("span", { class: "muted small" }, typeof note === "function" ? note(dry) : note)),
        h("span", { class: "prune-size" }, bytes(dry.byBucket[k])));
    })),
    h("div", { class: "prune-foot" }, h("span", {}, "Frees ", total), h("div", { class: "spacer" }), h("button", { class: "btn", onclick: () => dialog.close() }, "Cancel"), go),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  sum();
  dialog.showModal();
  async function prune() {
    const args = Object.fromEntries(PRUNE_PARTS.map(([k]) => [k, boxes[k].checked]));
    const lost = PRUNE_PARTS.filter(([k, , , irreversible]) => irreversible && args[k]).map(([, label]) => label.toLowerCase());
    if (lost.length && !confirm(`Delete for good: ${lost.join(" and ")}? Nothing can bring them back.`)) return;
    go.disabled = true;
    try {
      const r = await api("/api/tools/prune_video", { body: { args: { ...args, model: S.reviewer }, via: "page-js" } });
      toast(`Freed ${bytes(r.freedBytes)}.`);
      dialog.close();
    } catch (e) {
      toast(`Could not delete: ${e.message}`);
      go.disabled = false;
    }
  }
}

$("#renderBtn").onclick = async () => {
  try {
    await api("/api/render", { body: {} });
  } catch (e) {
    toast(e.message);
  }
};
