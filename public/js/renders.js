import { $, h, toast, ago } from "./util.js";
import { S, api } from "./state.js";

// ---------- renders ----------
export function renderRenders() {
  const list = $("#renderList");
  list.replaceChildren(...(S.data.renders.length ? S.data.renders.map((r) => h("a", { href: r.url, target: "_blank" }, `${r.file}`, h("div", { class: "muted small" }, `${ago(r.at)} · ${Math.round(r.ms / 1000)} s`))) : [h("div", { class: "muted small", style: "padding:8px" }, "No renders yet.")]));
  $("#renderBtn").disabled = S.data.rendering;
}

$("#renderBtn").onclick = async () => {
  try {
    await api("/api/render", { body: {} });
  } catch (e) {
    toast(e.message);
  }
};
