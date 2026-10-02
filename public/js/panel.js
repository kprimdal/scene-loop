import { $, h, toast } from "./util.js";
import { S, api, scene, latest, viewed, sceneAt, tc } from "./state.js";
import { player } from "./stage.js";
import { viewVersion } from "./versions.js";

const AGENT = { claude: "Claude", codex: "Codex", chat: "Chat", manual: "Manual edit", restore: "Restore", import: "Import" };

// ---------- side panel ----------
export const panelKey = () => S.sel;

export async function loadChat() {
  const key = panelKey();
  const entries = await api(`/api/chat/${key}`);
  if (key !== panelKey()) return;
  S.chat = entries;
  renderChat();
}

export function renderChat() {
  const box = $("#chat");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const out = [];
  let tools = null;
  for (const e of S.chat) {
    if (e.role === "tool" || e.role === "status") {
      if (!tools) out.push((tools = h("details", { class: "tools" }, h("summary", {}))));
      tools.append(h("div", { title: e.text }, e.text));
      tools.firstChild.textContent = `${tools.childElementCount - 1} steps`;
      continue;
    }
    tools = null;
    if (e.role === "system") out.push(h("div", { class: "sys" }, e.text));
    else out.push(h("div", { class: `msg ${e.role}` }, h("span", { class: "who" }, e.role === "user" ? S.reviewer : AGENT[e.agent]), e.text));
  }
  box.replaceChildren(...(out.length ? out : [h("div", { class: "empty" }, "Nothing yet. Pin a comment on the frame; the chat next to this page picks it up.")]));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// The right panel is the scene's activity and its open comments. The agent is the chat
// next to this page (left side), which picks comments up through get_pending_comments.
const CHAT_PROMPT = "Apply my pending comments in scene-loop (get_pending_comments), save each scene with write_scene_html, and show me the result.";

export function renderPanel() {
  const sc = scene();
  $("#panelTitle").textContent = `${S.data.scenes.indexOf(sc) + 1}. ${sc.title}`;
  $("#panelSub").textContent = `${sc.id} · ${sc.duration.toFixed(2)} s`;
  const pending = sc.comments.filter((c) => c.status === "pending");
  const allPending = S.data.scenes.reduce((n, s) => n + s.comments.filter((c) => c.status === "pending").length, 0);
  $("#pending").replaceChildren(
    ...(pending.length
      ? [
          h("h4", {}, `Open comments · ${pending.length}`),
          ...pending.map((c) =>
            h(
              "div",
              { class: "pin" },
              c.still ? h("img", { src: c.still, onclick: () => viewVersion(c.version, c.t) }) : h("div", { class: "noimg", onclick: () => viewVersion(c.version, c.t) }),
              h("div", {}, h("div", { class: "t" }, `v${c.version} · ${tc(c.t)}`), c.text),
              h("button", { class: "x", title: "Remove", onclick: () => api(`/api/scene/${sc.id}/comments/${c.id}`, { method: "DELETE" }) }, "×"),
            ),
          ),
        ]
      : []),
  );
  $("#handoff").textContent = allPending ? `${allPending} open comment${allPending > 1 ? "s" : ""} for the chat` : "⌘↵ to add";
  $("#copyPrompt").hidden = !allPending;
}

export async function addNote() {
  const text = $("#note").value.trim();
  if (!text) return;
  let sc = scene(), t = player.currentTime || 0, v = viewed();
  if (S.mode === "whole") {
    sc = sceneAt(t);
    t -= sc.start;
    v = S.picked[sc.id] ?? latest(sc);
  }
  try {
    await api(`/api/scene/${sc.id}/comments`, { body: { version: v, t: Math.round(t * 100) / 100, region: null, text } });
    $("#note").value = "";
  } catch (e) {
    toast(e.message);
  }
}

$("#addNote").onclick = addNote;
$("#note").addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && addNote());
$("#copyPrompt").onclick = async () => {
  await navigator.clipboard.writeText(CHAT_PROMPT).catch(() => {});
  toast("Copied. Paste it in the chat next to this page.");
};
