import { $, h, ago, audioTime } from "./util.js";
import { S, api, scene, latest, viewed } from "./state.js";
import { player, setMode, renderTrack, loadPlayer } from "./stage.js";

const AGENT = { claude: "Claude", codex: "Codex", chat: "Chat", manual: "Manual edit", restore: "Restore", import: "Import" };

// ---------- versions ----------
export function renderVersions() {
  const sc = scene();
  const i = S.data.scenes.indexOf(sc);
  $("#sceneLabel").textContent = `Scene ${i + 1} of ${S.data.scenes.length} · ${sc.id}`;
  $("#title").textContent = `· ${S.data.title}`;
  $("#versionsTitle").textContent = `Versions · ${sc.id}`;
  $("#versionsBtn").textContent = `Versions (${sc.versions.length})`;
  $("#versionsBtn").classList.toggle("on", !!S.showVersions);
  $("#versionsSec").hidden = !S.showVersions;
  $("#viewing").replaceChildren(
    S.mode === "scene" ? `viewing v${viewed(sc)}${S.view[sc.id] ? " (pinned)" : " (latest)"}` : `whole video uses v${S.picked[sc.id] ?? latest(sc)}`,
  );
  const scriptMark = S.data.scriptStatus.state === "agreed" ? "agreed" : S.data.scriptStatus.state === "changed" ? "changed" : "not agreed";
  $("#narration").replaceChildren(
    h("span", {}, h("b", {}, "Script "), sc.narration ?? "", h("span", { class: `script-mark ${S.data.scriptStatus.state}` }, scriptMark)),
    sc.audio ? h("span", { class: "narration-audio" }, h("audio", { controls: true, preload: "none", src: sc.audio.url }), h("span", { class: "muted" }, audioTime(sc.audio.seconds) + (sc.audio.stale ? " · stale: script changed since the take" : ""))) : null,
  );
  const box = $("#versions");
  box.replaceChildren(
    ...sc.versions.map((v) => {
      const comments = sc.comments.filter((c) => (v.comments ?? []).includes(c.id));
      const isView = S.mode === "scene" && v.v === viewed(sc);
      return h(
        "div",
        { class: `ver ${isView ? "on" : ""}` },
        h("div", {}, h("div", { class: "vnum" }, `v${v.v}`), h("div", { class: "vmeta" }, AGENT[v.agent] ?? v.agent), v.via ? h("div", { class: "vmeta" }, `via ${v.via === "webmcp" ? "WebMCP" : v.via === "page-js" ? "page JS" : v.via}`) : null, h("div", { class: "vmeta" }, ago(v.at ?? v.date)), v.ms ? h("div", { class: "vmeta" }, `${Math.round(v.ms / 1000)} s turn`) : null),
        h(
          "div",
          { class: "strip" },
          v.stills.length
            ? v.stills.map((st) => h("img", { src: st.url, title: `${st.t}s`, onclick: () => viewVersion(v.v, st.t) }))
            : Array.from({ length: 5 }, () => h("div", { class: "noimg" }, "stills…")),
        ),
        h(
          "div",
          { class: "acts" },
          isView ? null : h("button", { class: "btn", onclick: () => viewVersion(v.v) }, "View"),
          sc.versions.length > 1 ? h("button", { class: "btn ghost", onclick: () => openCompare(v.v) }, "Compare") : null,
          v.v !== latest(sc) ? h("button", { class: "btn ghost", title: "Bring this version back as a new version", onclick: () => restore(v.v) }, "Restore") : null,
        ),
        h("div", { class: "what" }, comments.length || v.note ? [...comments.map((c) => `“${c.text}”`), ...(v.note ? [`Note: ${v.note}`] : [])].join("  ") : v.v === 1 ? "First version." : v.from ? `Restored from v${v.from}.` : (v.subject ?? "").replace(/^[\w-]+ v\d+: /, "")),
      );
    }),
  );
  renderCompare();
}

export function showVersions(on = !S.showVersions) {
  S.showVersions = on;
  renderVersions();
  if (on) $(".left").scrollTo({ top: $("#versionsSec").offsetTop - 12, behavior: "smooth" });
}
$("#versionsBtn").onclick = () => showVersions();

export function viewVersion(v, t) {
  const sc = scene();
  if (S.mode !== "scene") setMode("scene");
  if (v === latest(sc)) delete S.view[sc.id];
  else S.view[sc.id] = v;
  renderVersions();
  renderTrack();
  loadPlayer().then(() => t != null && player.seek(t));
}

export function openCompare(b) {
  const sc = scene();
  const a = viewed(sc);
  S.compare = { a: a === b ? (sc.versions.find((x) => x.v !== b) ?? sc.versions[0]).v : a, b };
  S.showVersions = true;
  renderVersions();
}

export function renderCompare() {
  const el = $("#compare");
  const sc = scene();
  const on = S.compare && S.mode === "scene";
  el.hidden = $("#flipBtn").hidden = $("#closeCompare").hidden = !on;
  if (!on) return;
  const row = (v) => {
    const ver = sc.versions.find((x) => x.v === v);
    return h("div", { class: "row" }, h("b", {}, `v${v}`), ...(ver?.stills ?? []).map((st) => h("img", { src: st.url, onclick: () => viewVersion(v, st.t) })));
  };
  const times = sc.versions.find((x) => x.v === S.compare.a)?.stills.map((st) => `${st.t}s`) ?? [];
  el.replaceChildren(h("div", { class: "row" }, h("span"), ...times.map((t) => h("div", { class: "times" }, t))), row(S.compare.a), row(S.compare.b));
}

export function flip() {
  if (!S.compare) return;
  const t = player.currentTime;
  const next = viewed() === S.compare.a ? S.compare.b : S.compare.a;
  viewVersion(next, t);
}

export async function restore(v) {
  if (!confirm(`Bring v${v} back as a new version of ${S.sel}?`)) return;
  delete S.view[S.sel];
  await api(`/api/scene/${S.sel}/restore`, { body: { v } });
}
