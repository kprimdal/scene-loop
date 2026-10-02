import { $, h } from "./util.js";
import { S, scene, latest } from "./state.js";
import { player, loadPlayer } from "./stage.js";
import { renderScript } from "./script.js";
import { renderVersions } from "./versions.js";
import { loadChat, renderPanel } from "./panel.js";

// ---------- filmstrip ----------
export function renderFilmstrip() {
  const strip = $("#filmstrip");
  strip.replaceChildren(
    ...S.data.scenes.map((s, i) => {
      const lv = latest(s);
      const v = s.versions.at(-1);
      const poster = v.stills.at(-1) ?? s.versions.findLast((x) => x.stills.length)?.stills.at(-1);
      const pins = s.comments.filter((c) => c.status === "pending").length;
      return h(
        "button",
        { class: `card ${s.id === S.sel ? "on" : ""}`, "data-id": s.id, onclick: () => selectScene(s.id, true) },
        h(
          "div",
          { class: "thumb" },
          h("span", { class: "num" }, i + 1),
          poster ? h("img", { src: poster.url, alt: "" }) : h("div", { class: "noimg" }),
          h(
            "div",
            { class: "badges" },
            lv > 1 ? h("span", { class: "badge" }, `v${lv}`) : null,
            pins ? h("span", { class: "badge pins" }, pins) : null,
          ),
        ),
        h("div", { class: "cap" }, h("b", {}, s.title), h("span", { class: "muted" }, `${s.duration.toFixed(2)}s`)),
      );
    }),
  );
}

export function selectScene(id, fromStrip) {
  S.sel = id;
  if (S.script) renderScript();
  S.compare = null;
  if (S.mode === "whole" && fromStrip) player.seek(scene(id).start + 0.02);
  renderFilmstrip();
  $("#filmstrip").querySelector(".card.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  renderVersions();
  loadChat();
  renderPanel();
  if (S.mode === "scene") loadPlayer();
}
