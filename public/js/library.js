import { $, h, toast, audioTime } from "./util.js";
import { S, api } from "./state.js";
import { videoUrl } from "./projects.js";
import { showStyles } from "./styles.js";
import { refresh } from "./data.js";

// ---------- the shared library (music beds) ----------
// /?library=1 is the Library view: every item with a player, its metadata and the videos that
// use it. In a video, the Music menu in the header shows the bed and sets one from the library.
// Both read list_library; writes go through the same tools the chat uses, and the upload
// through /api/library/upload (owners only, the file as the body).
const tool = (name, args = {}) => api(`/api/tools/${name}`, { body: { args, via: "page-js" } });
let lib = { items: [], tags: [] };
export const loadLibrary = async () => (lib = await tool("list_library", { kind: "music" }));

const facts = (it) => [audioTime(it.duration), it.loop ? "loops" : null, it.bpm ? `${it.bpm} bpm` : null, [it.source, it.sourceModel].filter(Boolean).join(" · "), it.created].filter(Boolean).join(" · ");
const usedLinks = (it) =>
  it.usedIn.length
    ? it.usedIn.map((u) => h("a", { class: `used ${u.bed ? "bed" : ""}`, href: videoUrl(u.project, u.video), title: u.bed ? `The music of ${u.project}/${u.video} (${u.path})` : `A copy in ${u.path}, not set as the music` }, `${u.project} / ${u.video}`, u.bed ? null : h("span", {}, " (copy)")))
    : [h("span", { class: "muted" }, "Not used yet")];

export function renderLibrary() {
  const shown = lib.items.filter((it) => !S.libTag || it.tags.includes(S.libTag));
  $("#libCount").textContent = `${lib.items.length} music bed${lib.items.length === 1 ? "" : "s"}`;
  $("#libTags").replaceChildren(
    ...(lib.tags.length
      ? [h("button", { class: `chip ${S.libTag ? "" : "on"}`, onclick: () => ((S.libTag = null), renderLibrary()) }, "All"), ...lib.tags.map((t) => h("button", { class: `chip ${S.libTag === t ? "on" : ""}`, onclick: () => ((S.libTag = S.libTag === t ? null : t), renderLibrary()) }, t))]
      : []),
  );
  $("#libList").replaceChildren(
    ...(shown.length
      ? shown.map((it) =>
          h(
            "article",
            { class: "pcard lib-item", id: `lib-${it.id}` },
            h("div", { class: "pcard-head" }, h("div", { style: "min-width:0" }, h("h2", {}, it.title), h("div", { class: "muted small" }, `${it.id} · ${facts(it)}`)), h("div", { class: "spacer" })),
            h("audio", { controls: true, preload: "none", src: it.url }),
            it.tags.length ? h("div", { class: "tags" }, it.tags.map((t) => h("span", { class: "tag" }, t))) : null,
            h(
              "dl",
              { class: "lib-meta" },
              it.prompt ? [h("dt", {}, "Prompt"), h("dd", { class: "prompt" }, it.prompt)] : null,
              [h("dt", {}, "Rights"), h("dd", {}, it.license || h("span", { class: "muted" }, "not noted"))],
              it.note ? [h("dt", {}, "Note"), h("dd", {}, it.note)] : null,
              [h("dt", {}, "Used in"), h("dd", { class: "used-in" }, usedLinks(it))],
            ),
          ),
        )
      : [h("div", { class: "ov-empty" }, lib.items.length ? "No music with that tag." : "No music in the library yet. Add a file, or ask the chat to add_to_library.")]),
  );
}

export async function showLibrary() {
  await loadLibrary();
  renderLibrary();
  await showStyles();
}

// ---------- the Music menu in a video ----------
export async function renderMusicMenu() {
  if (!S.data || !$("#musicMenu").open) return;
  try {
    await loadLibrary();
  } catch (e) {
    return $("#musicList").replaceChildren(h("div", { class: "muted small", style: "padding:8px" }, e.message));
  }
  const cur = S.data.music;
  const from = S.data.musicLibrary && lib.items.find((it) => it.id === S.data.musicLibrary);
  $("#musicList").replaceChildren(
    h(
      "div",
      { class: "music-now" },
      h("div", { class: "muted small" }, "Music bed"),
      cur ? h("div", {}, h("b", {}, from ? from.title : cur.split("/").pop()), h("span", { class: "muted small" }, from ? ` · library ${from.id}` : S.data.musicLibrary ? ` · library ${S.data.musicLibrary} (removed)` : ` · ${cur}`)) : h("div", { class: "muted" }, "None"),
      cur ? h("audio", { controls: true, preload: "none", src: `/p/${encodeURIComponent(S.project)}/${encodeURIComponent(S.video)}/${cur.split("/").map(encodeURIComponent).join("/")}` }) : null,
      cur ? h("button", { class: "btn ghost small", onclick: () => setBed(null) }, "Remove bed") : null,
    ),
    h("div", { class: "muted small music-sub" }, "From the library"),
    ...(lib.items.length
      ? lib.items.map((it) =>
          h(
            "div",
            { class: `music-item ${S.data.musicLibrary === it.id ? "on" : ""}` },
            h("div", { style: "min-width:0" }, h("b", {}, it.title), h("div", { class: "muted small" }, facts(it))),
            h("audio", { controls: true, preload: "none", src: it.url }),
            h("button", { class: "btn small", disabled: S.data.musicLibrary === it.id, onclick: () => setBed(it.id) }, S.data.musicLibrary === it.id ? "In use" : "Use"),
          ),
        )
      : [h("div", { class: "muted small", style: "padding:6px 8px" }, "The library is empty.")]),
    h("a", { class: "music-open", href: "/?" + new URLSearchParams({ library: "1", project: S.project, video: S.video, scene: S.sel, section: "music" }) }, "Open the library →"),
  );
}

async function setBed(id) {
  try {
    if (id) {
      const r = await tool("use_library_music", { item: id, model: S.reviewer });
      toast(`${r.title} is the music now. Build the soundtrack to hear it under the voice.`);
    } else {
      await tool("set_video", { music: null, note: "music removed in the page", model: S.reviewer });
      toast("Music bed removed. Build the soundtrack again to take it out.");
    }
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

$("#musicMenu").addEventListener("toggle", renderMusicMenu);

// ---------- adding a file ----------
const TYPES = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac" };
function openAdd() {
  $("#libForm").reset();
  $("#libForm").elements.created.value = new Date().toISOString().slice(0, 10);
  $("#libState").textContent = "";
  $("#libDrawer").hidden = $("#drawerShade").hidden = false;
}
const closeAdd = () => ($("#libDrawer").hidden = $("#drawerShade").hidden = true);

async function saveAdd() {
  const f = $("#libForm").elements;
  const file = f.file.files[0];
  if (!file) return ($("#libState").textContent = "Pick a file.");
  if (!f.title.value.trim()) return ($("#libState").textContent = "Give it a title.");
  const type = TYPES[file.name.split(".").pop().toLowerCase()];
  if (!type) return ($("#libState").textContent = "mp3, wav, m4a, ogg or flac.");
  const meta = { title: f.title.value.trim(), source: f.source.value.trim() || "file", sourceModel: f.sourceModel.value.trim() || undefined, prompt: f.prompt.value.trim() || undefined, created: f.created.value || undefined, license: f.license.value.trim() || undefined, tags: f.tags.value, loop: f.loop.checked, bpm: f.bpm.value ? Number(f.bpm.value) : undefined, note: f.note.value.trim() || undefined };
  $("#libState").textContent = `Uploading ${(file.size / 1e6).toFixed(1)} MB…`;
  $("#libSave").disabled = true;
  try {
    const r = await fetch(`/api/library/upload?${new URLSearchParams({ meta: JSON.stringify(meta), name: file.name })}`, { method: "POST", headers: { "Content-Type": type }, body: file });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    closeAdd();
    toast(`${j.title} is in the library as ${j.id}.`);
    if (S.library) await showLibrary();
  } catch (e) {
    $("#libState").textContent = e.message;
  } finally {
    $("#libSave").disabled = false;
  }
}

$("#libAdd").onclick = openAdd;
$("#libClose").onclick = $("#libCancel").onclick = closeAdd;
$("#drawerShade").addEventListener("click", () => !$("#libDrawer").hidden && closeAdd());
$("#libSave").onclick = saveAdd;
$("#libDrawer").addEventListener("keydown", (e) => e.key === "Escape" && closeAdd());
