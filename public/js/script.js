import { $, h, toast, mmss, audioTime, countWords } from "./util.js";
import { S, api, tc } from "./state.js";
import { player, loadPlayer } from "./stage.js";
import { refresh } from "./data.js";
import { selectScene } from "./filmstrip.js";

// ---------- script view ----------
// Every scene's narration in order, editable in place by the reviewer.
export function setScript(on = !S.script) {
  S.script = on;
  if (on) player.pause();
  document.body.classList.toggle("scripting", on);
  $("#scriptBtn").classList.toggle("on", on);
  $("#script").hidden = !on;
  if (on) renderScript();
  else loadPlayer();
}

export const scriptStatusText = (status) => {
  if (status.state === "not-agreed") return "Not agreed";
  const agreed = `Agreed by ${status.agreedBy} ${new Date(status.agreedAt).toLocaleString()}`;
  return status.state === "changed" ? `${agreed}, changed since` : agreed;
};

export const scriptMetrics = (values) => {
  const words = values.reduce((n, text) => n + countWords(text), 0);
  const chars = values.reduce((n, text) => n + String(text ?? "").length, 0);
  return { words, chars };
};

export function updateScriptCounts() {
  const textareas = [...document.querySelectorAll("#script .script-row textarea")];
  for (const ta of textareas) {
    const row = ta.closest(".script-row");
    row.querySelector(".script-count").textContent = `${countWords(ta.value)} words · ${ta.value.length} chars`;
  }
  const { words, chars } = scriptMetrics(textareas.map((ta) => ta.value));
  const totals = $("#scriptTotals");
  if (totals) totals.textContent = `${words} words · ${chars} chars · est. ${mmss(words / 2.4)} spoken · scenes ${mmss(S.data.scenes.reduce((n, s) => n + s.duration, 0))}`;
}

let scriptSavePending = Promise.resolve();
export function saveScriptNarration(s, ta) {
  const run = async () => {
    const stale = () => S.scriptStale && S.script && renderScript();
    if (ta.dataset.cancelled === "true") {
      delete ta.dataset.cancelled;
      return stale();
    }
    const narration = ta.value;
    if (narration === ta.dataset.original) return stale();
    ta.disabled = true;
    try {
      const result = await api("/api/tools/update_scene", { body: { args: { scene: s.id, narration, note: `script: ${s.id}`, model: S.reviewer }, via: "page-js" } });
      ta.dataset.original = narration;
      s.narration = narration;
      toast(result.version ? `Saved ${s.id} as project v${result.version}.` : `${s.id} is unchanged.`);
      await refresh();
    } catch (e) {
      ta.disabled = false;
      toast(`Could not save ${s.id}: ${e.message}`);
      stale();
    }
  };
  scriptSavePending = scriptSavePending.then(run, run);
  return scriptSavePending;
}

export async function toggleScriptAgreement() {
  try {
    await scriptSavePending;
    await api("/api/script/agreement", { body: {} });
    await refresh();
  } catch (e) {
    toast(`Could not change script agreement: ${e.message}`);
  }
}

export function renderScript() {
  // A project event (an agent's write, stills landing) must not rebuild the rows under a
  // reviewer who is typing: wait for the blur, which saves or cancels and then re-renders.
  const active = document.activeElement;
  if (active?.tagName === "TEXTAREA" && $("#script").contains(active)) return void (S.scriptStale = true);
  S.scriptStale = false;
  const status = S.data.scriptStatus;
  const { words, chars } = scriptMetrics(S.data.scenes.map((s) => s.narration ?? ""));
  const text = S.data.scenes.map((s, i) => `${i + 1}. ${s.title} (${tc(s.start)})\n${s.narration ?? ""}`).join("\n\n");
  $("#script").replaceChildren(
    h(
      "div",
      { class: "script-head" },
      h("div", {}, h("h2", {}, "Script"), h("div", { class: `script-status ${status.state}` }, scriptStatusText(status))),
      h("span", { class: "muted script-totals", id: "scriptTotals" }, `${words} words · ${chars} chars · est. ${mmss(words / 2.4)} spoken · scenes ${mmss(S.data.scenes.reduce((n, s) => n + s.duration, 0))}`),
      h("div", { class: "spacer" }),
      h("button", { class: `btn small ${status.state === "agreed" ? "dark" : "accent"}`, onclick: toggleScriptAgreement, title: status.state === "agreed" ? "Clear the current agreement" : "Agree the script exactly as written" }, status.state === "agreed" ? "Clear agreement" : "Script agreed"),
      h("button", { class: "btn ghost small", onclick: () => navigator.clipboard.writeText(text).then(() => toast("Script copied.")) }, "Copy"),
    ),
    ...S.data.scenes.map((s, i) => {
      const narration = s.narration ?? "";
      const ta = h("textarea", { rows: Math.max(2, narration.split("\n").length), spellcheck: true, "aria-label": `Narration for ${s.id}` }, narration);
      ta.dataset.original = narration;
      ta.addEventListener("input", updateScriptCounts);
      ta.addEventListener("blur", () => saveScriptNarration(s, ta));
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), ta.blur());
        if (e.key === "Escape") {
          e.preventDefault();
          ta.value = ta.dataset.original;
          ta.dataset.cancelled = "true";
          updateScriptCounts();
          ta.blur();
        }
      });
      return h(
        "div",
        { class: `script-row ${s.id === S.sel ? "on" : ""}`, "data-id": s.id },
        h("div", { class: "tc" }, tc(s.start), h("span", {}, `${s.duration.toFixed(2)} s`)),
        h(
          "div",
          { class: "script-body" },
          h("div", { class: "script-row-head" }, h("h3", {}, `${i + 1}. ${s.title} `, h("span", {}, s.id)), h("span", { class: "muted script-count" }, `${countWords(narration)} words · ${narration.length} chars · ${s.audio ? audioTime(s.audio.seconds) : "no audio"}${s.words ? ` · ${s.words.count} words timed` : ""}`), h("button", { class: "btn ghost small", onclick: () => (selectScene(s.id, true), setScript(false)) }, "Show scene")),
          ta,
        ),
      );
    }),
  );
}
$("#scriptBtn").onclick = () => setScript();
