import { $, h, toast } from "./util.js";
import { S, api } from "./state.js";
import { openInstructions } from "./instructions.js";

const Q = new URLSearchParams(location.search);

// ---------- projects and videos ----------
// A project holds videos. The page shows either the overview (every project, its tags and
// videos) or the viewer for one video. Moving between them loads a fresh page.
export const proj = (name = S.project) => S.projects.find((p) => p.name === name);
export const videoCount = () => S.projects.reduce((n, p) => n + p.videos.length, 0);
export const videoUrl = (project, video, extra = {}) => "/?" + new URLSearchParams({ project, video, ...extra });
export const go = (url) => (location.href = url);

export async function loadProjects() {
  const r = await fetch("/api/projects").then((x) => x.json());
  S.projects = r.projects;
  S.single = r.single;
  S.root = r.root;
}

// Which view the URL means. /?all=1 is the overview; / is the overview when there is more
// than one video in all, else the viewer on the only one. A project alone opens its only video.
export function pickView() {
  if (Q.has("all") || !videoCount()) return false;
  if (!S.project && S.video) S.project = S.projects.find((p) => p.videos.some((v) => v.name === S.video))?.name ?? null;
  if (!S.project) {
    if (S.projects.length !== 1) return false;
    S.project = S.projects[0].name;
  }
  const p = proj();
  if (!p) return (toast(`No project ${S.project}`), (S.project = S.video = null), false);
  if (!S.video) {
    if (p.videos.length !== 1 && !(Q.get("project") && p.videos.length)) return false;
    S.video = p.videos[0].name;
  }
  if (!p.videos.some((v) => v.name === S.video)) return (toast(`No video ${S.video} in ${p.title}`), (S.video = null), false);
  return true;
}

export function renderCrumbs() {
  const p = proj();
  // Always a way back: the overview is where new projects and videos are made.
  $("#allProjects").hidden = $("#allSep").hidden = !!S.single;
  $("#projectSel").replaceChildren(...S.projects.filter((x) => x.videos.length).map((x) => h("option", { value: x.name, selected: x.name === S.project }, x.title)));
  $("#videoSel").replaceChildren(...p.videos.map((v) => h("option", { value: v.name, selected: v.name === S.video }, v.title)));
}

$("#projectSel").onchange = (e) => go(videoUrl(e.target.value, proj(e.target.value).videos[0].name));
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

// ---------- overview ----------
export function renderOverview() {
  const tags = new Map();
  for (const p of S.projects) for (const t of p.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  if (S.tag && !tags.has(S.tag)) S.tag = null;
  const shown = S.projects.filter((p) => !S.tag || p.tags.includes(S.tag));
  $("#ovCount").textContent = `${S.projects.length} project${S.projects.length === 1 ? "" : "s"} · ${videoCount()} video${videoCount() === 1 ? "" : "s"}`;
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
  $("#ovGrid").replaceChildren(
    ...shown.map((p) =>
      h(
        "article",
        { class: "pcard" },
        h(
          "div",
          { class: "pcard-head" },
          h("div", {}, h("h2", {}, p.title), h("div", { class: "muted small" }, `${p.name} · ${p.videos.length} video${p.videos.length === 1 ? "" : "s"}`)),
          h("div", { class: "spacer" }),
          h("button", { class: "btn small", title: "The project's instructions for the chat", onclick: () => openInstructions(p.name) }, p.instructions ? "Instructions" : "Add instructions"),
        ),
        p.tags.length ? h("div", { class: "tags" }, p.tags.map((t) => h("span", { class: "tag" }, t))) : null,
        h(
          "div",
          { class: "vrows" },
          p.videos.length
            ? p.videos.map((v) => {
                const f = v.fps || 30;
                const frames = Math.round(v.duration * f), secs = Math.floor(frames / f);
                const dur = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}:${String(frames - secs * f).padStart(2, "0")}`;
                return h(
                  "a",
                  { class: "vrow", href: videoUrl(p.name, v.name) },
                  v.poster ? h("img", { src: v.poster, alt: "", loading: "lazy" }) : h("div", { class: "noimg" }),
                  h("div", { style: "min-width:0" }, h("b", {}, v.title), h("div", { class: "muted small" }, v.name)),
                  h("div", { class: "facts" }, h("div", {}, h("b", {}, dur), ` · ${v.scenes} scene${v.scenes === 1 ? "" : "s"}`), h("div", {}, v.latestRender ? `rendered ${new Date(v.latestRender.at).toLocaleDateString()}` : "not rendered")),
                );
              })
            : h("div", { class: "novideos" }, "No videos yet."),
        ),
        p.layout === "project" ? h("div", { class: "pcard-foot" }, h("button", { class: "btn ghost small", onclick: () => newVideo(p.name) }, "+ New video")) : null,
      ),
    ),
  );
}
