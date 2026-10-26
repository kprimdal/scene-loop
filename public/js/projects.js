import { $, h, toast, bytes } from "./util.js";
import { S, api } from "./state.js";
import { openInstructions } from "./instructions.js";

const Q = new URLSearchParams(location.search);

// ---------- projects and videos ----------
// A project holds videos. The page shows the front page (every project), one project's page
// (its videos), or the viewer for one video. Moving between them loads a fresh page.
export const proj = (name = S.project) => S.projects.find((p) => p.name === name);
export const videoCount = () => S.projects.reduce((n, p) => n + p.videos.length, 0);
export const videoUrl = (project, video, extra = {}) => "/?" + new URLSearchParams({ project, video, ...extra });
export const projectUrl = (project) => "/?" + new URLSearchParams({ project });
export const go = (url) => (location.href = url);

export async function loadProjects() {
  const r = await fetch("/api/projects").then((x) => x.json());
  S.projects = r.projects;
  S.single = r.single;
  S.root = r.root;
}

// Which view the URL means. /?all=1 is the front page (every project). /?project=x is that
// project's page. / is the front page when there are several projects; with one, its page, or
// the viewer when it holds exactly one video. A video-folder project (an older layout) is its
// one video, so ?project=x still opens it, as old links expect.
export function pickView() {
  if (Q.has("all")) return ((S.project = S.video = null), false);
  if (!S.project && S.video) S.project = S.projects.find((p) => p.videos.some((v) => v.name === S.video))?.name ?? null;
  if (!S.project) {
    if (S.projects.length !== 1) return false;
    S.project = S.projects[0].name;
  }
  const p = proj();
  if (!p) return (toast(`No project ${S.project}`), (S.project = S.video = null), false);
  if (!S.video) {
    if (p.videos.length !== 1 || (Q.has("project") && p.layout === "project" && !S.single)) return false;
    S.video = p.videos[0].name;
  }
  if (!p.videos.some((v) => v.name === S.video)) return (toast(`No video ${S.video} in ${p.title}`), (S.video = null), false);
  return true;
}

export function renderCrumbs() {
  const p = proj();
  // Always a way back: the overview is where new projects and videos are made.
  $("#projectSel").replaceChildren(...S.projects.filter((x) => x.videos.length).map((x) => h("option", { value: x.name, selected: x.name === S.project }, x.title)));
  $("#videoSel").replaceChildren(...p.videos.map((v) => h("option", { value: v.name, selected: v.name === S.video }, v.title)));
}

$("#projectSel").onchange = (e) => go(projectUrl(e.target.value));
$("#videoSel").onchange = (e) => go(videoUrl(S.project, e.target.value));

export async function newProject() {
  const name = prompt("Folder name for the new project (letters, digits, - _ .):");
  if (!name) return;
  try {
    await api("/api/tools/create_project", { body: { args: { name, title: name }, via: "page-js" } });
    await newVideo(name);
  } catch (e) {
    toast(e.message);
  }
}

export async function newVideo(project) {
  const name = prompt(`Folder name for a new video in ${project} (letters, digits, - _ .):`, "video-1");
  if (!name) return;
  try {
    await api("/api/tools/create_video", { body: { args: { project, name, title: name }, via: "page-js" } });
    go(videoUrl(project, name));
  } catch (e) {
    toast(e.message);
  }
}
$("#newProject").onclick = newProject;

async function deleteVideo(e, project, v) {
  e.preventDefault();
  e.stopPropagation();
  if (!confirm(`Delete "${v.title}" (${v.name})?\n\nIt moves to ${project}/.trash on the server, where it can be restored.`)) return;
  try {
    await api(`/api/videos/${encodeURIComponent(project)}/${encodeURIComponent(v.name)}`, { method: "DELETE" });
    toast(`${v.name} moved to ${project}/.trash`);
  } catch (err) {
    toast(err.message);
  }
}

// ---------- overview: the front page and a project's page ----------
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const tagList = (p) => (p.tags.length ? h("div", { class: "tags" }, p.tags.map((t) => h("span", { class: "tag" }, t))) : null);
const insButton = (p) => h("button", { class: "btn small owner-only", title: "The project's instructions for the chat (I)", onclick: (e) => (e.preventDefault(), e.stopPropagation(), openInstructions(p.name)) }, p.instructions ? "Instructions" : "Add instructions");

// The tooltip on a size: where the bytes are, largest part first, parts under 1 MB left out.
const DISK_LABELS = { renders: "renders", takes: "takes and camera clips", cache: "render cache and previews", stills: "stills and state", versions: "versions", files: "scenes and assets", trash: ".trash" };
const diskTitle = (d) =>
  Object.entries(DISK_LABELS).map(([k, label]) => [d[k] ?? 0, label]).filter(([n]) => n >= 1e6).sort((a, b) => b[0] - a[0]).map(([n, label]) => `${bytes(n)} ${label}`).join("\n") || "under 1 MB";
const diskLine = (p) => [h("span", { title: diskTitle(p.disk) }, bytes(p.disk.total)), p.disk.trash ? ` (${bytes(p.disk.trash)} in .trash)` : ""];

// Both live in #overview and re-render from S.projects, so a live update keeps whichever is open.
export function renderOverview() {
  const p = S.project && proj();
  if (S.project && !p) S.project = S.video = null; // the project went away: back to the front page
  $("#ovFront").hidden = !!p;
  $("#ovProject").hidden = !p;
  if (p) return renderProject(p);
  document.title = "Projects · Scene loop";
  const tags = new Map();
  for (const p of S.projects) for (const t of p.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  if (S.tag && !tags.has(S.tag)) S.tag = null;
  const shown = S.projects.filter((p) => !S.tag || p.tags.includes(S.tag));
  $("#ovCount").textContent = `${plural(S.projects.length, "project")} · ${plural(videoCount(), "video")} · ${bytes(S.projects.reduce((n, p) => n + (p.disk?.total ?? 0), 0))} on disk`;
  $("#tagChips").replaceChildren(
    ...(tags.size
      ? [
          h("button", { class: `chip ${S.tag ? "" : "on"}`, onclick: () => ((S.tag = null), renderOverview()) }, "All"),
          ...[...tags].sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => h("button", { class: `chip ${S.tag === t ? "on" : ""}`, onclick: () => ((S.tag = S.tag === t ? null : t), renderOverview()) }, t, h("span", {}, n))),
        ]
      : []),
  );
  if (!S.projects.length) {
    $("#ovGrid").replaceChildren(h("div", { class: "ov-empty" }, S.single ? "No video here." : `No projects in ${S.root} yet. Click New project, or ask the chat to create_project.`));
    return;
  }
  // One short card per project; the whole card is a link to its page.
  $("#ovGrid").replaceChildren(
    ...shown.map((p) => {
      const posters = p.videos.filter((v) => v.poster).slice(0, 4);
      return h(
        "a",
        { class: "pcard", href: projectUrl(p.name) },
        h("div", { class: "pcard-head" }, h("div", { style: "min-width:0" }, h("h2", {}, p.title), h("div", { class: "muted small" }, `${p.name} · ${plural(p.videos.length, "video")} · `, ...diskLine(p))), h("div", { class: "spacer" }), insButton(p)),
        tagList(p),
        posters.length ? h("div", { class: "posters" }, posters.map((v) => h("img", { src: v.poster, alt: "", loading: "lazy" }))) : null,
      );
    }),
  );
}

// One project: a row per video with poster, duration, scene count and render date.
function renderProject(p) {
  document.title = `${p.title} · Scene loop`;
  $("#pTitle").textContent = p.title;
  $("#pSub").replaceChildren(`${p.name} · ${plural(p.videos.length, "video")} · `, ...diskLine(p));
  $("#pTags").replaceChildren(...(p.tags.length ? [tagList(p)] : []));
  $("#pActions").replaceChildren(insButton(p), p.layout === "project" ? h("button", { class: "btn dark owner-only", onclick: () => newVideo(p.name) }, "+ New video") : "");
  $("#pVideos").replaceChildren(
    ...(p.videos.length
      ? p.videos.map((v) => {
          const f = v.fps || 30;
          const frames = Math.round(v.duration * f), secs = Math.floor(frames / f);
          const dur = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}:${String(frames - secs * f).padStart(2, "0")}`;
          return h(
            "a",
            { class: "vrow", href: videoUrl(p.name, v.name) },
            v.poster ? h("img", { src: v.poster, alt: "", loading: "lazy" }) : h("div", { class: "noimg" }),
            h("div", { style: "min-width:0" }, h("b", {}, v.title), h("div", { class: "muted small" }, v.name)),
            h("div", { class: "facts" }, h("div", {}, h("b", {}, dur), ` · ${plural(v.scenes, "scene")}`), h("div", {}, v.latestRender ? `rendered ${new Date(v.latestRender.at).toLocaleDateString()}` : "not rendered"), h("div", { title: diskTitle(v.disk) }, bytes(v.disk.total))),
            p.layout === "project" ? h("button", { class: "vdel owner-only", title: "Delete video", "aria-label": `Delete ${v.title}`, onclick: (e) => deleteVideo(e, p.name, v) }, "×") : null,
          );
        })
      : [h("div", { class: "novideos" }, p.layout === "project" ? "No videos yet. Click New video, or ask the chat to create_video." : "No videos yet.")]),
  );
}
