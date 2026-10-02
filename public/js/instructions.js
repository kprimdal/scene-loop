import { $, toast } from "./util.js";
import { S, api } from "./state.js";
import { loadProjects, renderCrumbs, renderOverview } from "./projects.js";

// ---------- project instructions (project.md) ----------
let insProject = null;
let insLoaded = "";
export async function openInstructions(project = S.project) {
  try {
    const r = await api(`/api/tools/get_project_instructions`, { body: { args: { project }, via: "page-js" } });
    insProject = r.project;
    insLoaded = r.markdown ?? r.starter;
    $("#insText").value = insLoaded;
    $("#drawerSub").textContent = `${r.title} · ${r.file}`;
    $("#insState").textContent = r.markdown == null ? "No project.md yet. Save makes one." : "";
    $("#drawer").hidden = $("#drawerShade").hidden = false;
    $("#insText").focus();
  } catch (e) {
    toast(e.message);
  }
}

export function closeInstructions(force) {
  if (!force && $("#insText").value !== insLoaded && !confirm("Close without saving your changes?")) return;
  $("#drawer").hidden = $("#drawerShade").hidden = true;
}

export async function saveInstructions() {
  try {
    $("#insState").textContent = "Saving…";
    const r = await api(`/api/tools/set_project_instructions`, { body: { args: { project: insProject, markdown: $("#insText").value, note: "edited in the page", model: S.reviewer }, via: "page-js" } });
    insLoaded = $("#insText").value;
    $("#insState").textContent = r.unchanged ? "No changes." : `Saved as project v${r.version}.`;
    await loadProjects();
    if (S.overview) renderOverview();
    else renderCrumbs();
  } catch (e) {
    $("#insState").textContent = e.message;
  }
}

$("#instructionsBtn").onclick = () => openInstructions();
$("#drawerClose").onclick = $("#insCancel").onclick = $("#drawerShade").onclick = () => closeInstructions();
$("#insSave").onclick = saveInstructions;
$("#insText").addEventListener("keydown", (e) => {
  if (e.key === "s" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), saveInstructions());
  if (e.key === "Escape") closeInstructions();
});
