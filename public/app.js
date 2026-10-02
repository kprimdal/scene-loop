// Scene loop UI. Vanilla JS, no build step. State lives on the server; the modules
// under public/js render it and turn clicks into API calls.
import { $ } from "./js/util.js";
import { S, api } from "./js/state.js";
import { loadProjects, pickView, renderCrumbs, renderOverview } from "./js/projects.js";
import { refresh } from "./js/data.js";
import { loadChat } from "./js/panel.js";
import { tick } from "./js/stage.js";
import "./js/keys.js";
import "./js/live.js";

await import("./js/tools.js");

S.reviewer = (await api("/api/whoami")).reviewer;
await loadProjects();
if (pickView()) {
  renderCrumbs();
  await refresh();
  await loadChat();
  requestAnimationFrame(tick);
} else {
  S.overview = true;
  document.body.classList.add("overview-mode");
  $(".main").hidden = $("#filmstrip").hidden = true;
  $("#overview").hidden = false;
  document.title = "Projects · Scene loop";
  renderOverview();
}
