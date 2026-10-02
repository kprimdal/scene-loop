import { $, toast } from "./util.js";
import { S } from "./state.js";
import { loadProjects, renderCrumbs, renderOverview } from "./projects.js";
import { refresh } from "./data.js";
import { panelKey, renderChat } from "./panel.js";

// ---------- live updates ----------
const es = new EventSource("/api/events");
let refreshT;
const mine = (m) => { const d = JSON.parse(m.data || "{}"); return !S.overview && (!d.project || (d.project === S.project && (!d.video || d.video === S.video))); };
// The overview follows every change (new projects and videos, posters, renders), debounced.
let ovT;
const overviewLater = () => S.overview && (clearTimeout(ovT), (ovT = setTimeout(() => loadProjects().then(renderOverview), 400)));
es.addEventListener("projects", () => (S.overview ? overviewLater() : loadProjects().then(renderCrumbs)));
es.addEventListener("project", (m) => {
  overviewLater();
  if (!mine(m)) return;
  clearTimeout(refreshT);
  refreshT = setTimeout(refresh, 150);
});
es.addEventListener("chat", (m) => {
  if (!mine(m)) return;
  const { key, entry } = JSON.parse(m.data);
  if (key !== panelKey()) return;
  S.chat.push(entry);
  renderChat();
});
es.addEventListener("render", (m) => {
  if (JSON.parse(m.data).state === "done") overviewLater();
  if (!mine(m)) return;
  const d = JSON.parse(m.data);
  $("#renderState").textContent = d.state === "progress" ? `Rendering ${d.pct}%` : d.state === "start" ? "Rendering…" : d.state === "done" ? "Render done" : d.state === "failed" ? "Render failed" : "";
  if (d.state === "done") toast("Render done. Open it under Renders.");
  if (d.state === "failed") toast(`Render failed: ${d.error?.slice(-300)} (full log: renders/last-render-error.log)`);
});
es.addEventListener("toast", (m) => mine(m) && toast(JSON.parse(m.data).text));
