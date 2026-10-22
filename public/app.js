// Scene loop UI. Vanilla JS, no build step. State lives on the server; the modules
// under public/js render it and turn clicks into API calls.
import { $, h } from "./js/util.js";
import { S, api } from "./js/state.js";
import { loadProjects, pickView, renderCrumbs, renderOverview } from "./js/projects.js";
import { refresh } from "./js/data.js";
import { loadChat } from "./js/panel.js";
import { tick } from "./js/stage.js";
import "./js/keys.js";
import "./js/record.js";
import "./js/live.js";
import { showLibrary } from "./js/library.js";

await import("./js/tools.js");

const me = await api("/api/whoami");
({ reviewer: S.reviewer, guest: S.guest } = me);
document.body.classList.toggle("guest", S.guest); // a commenter: watch and comment only
// People (owners), the person's own account, and the way out when there is a login.
for (const [text, href, title] of [me.owner && me.login && ["People", "/people", "Who may log in, and to which projects"], me.account && [me.reviewer, "/account", "Your account"]].filter(Boolean))
  $("header.top").append(h("a", { class: "btn", href, title }, text));
if (me.login) $("header.top").append(h("form", { method: "post", action: "/logout", class: "logout" }, h("button", { class: "btn" }, "Log out"))); // a POST, so no other site can log you out
await loadProjects();
if (new URLSearchParams(location.search).has("library") && !S.guest) {
  S.overview = S.library = true; // no video open: the keys and live updates treat it like the overview
  document.body.classList.add("overview-mode", "library-mode");
  $(".main").hidden = $("#filmstrip").hidden = true;
  $("#library").hidden = false;
  document.title = "Library · Scene loop";
  await showLibrary();
} else if (pickView()) {
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
