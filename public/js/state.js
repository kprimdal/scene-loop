const Q = new URLSearchParams(globalThis.location?.search ?? "");
export const S = {
  project: Q.get("project"),
  video: Q.get("video"),
  projects: [],
  overview: false,
  tag: null, // overview tag filter
  script: false, // script view instead of the stage
  data: null,
  mode: "scene",
  sel: null,
  view: {}, // sceneId -> pinned version; absent = follow latest
  compare: null, // { a, b }
  picked: {}, // whole video: sceneId -> version used
  loadedKey: null,
  chat: [],
  reviewer: "You",
};

// Every API call carries the current project and video (?project=&video=), from the URL.
export const api = async (path, opts = {}) => {
  const q = [S.project && "project=" + encodeURIComponent(S.project), S.video && "video=" + encodeURIComponent(S.video)].filter(Boolean).join("&");
  if (q) path += (path.includes("?") ? "&" : "?") + q;
  const r = await fetch(path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers: { "Content-Type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); // the login ran out (self-hosted)
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
};

export const scene = (id = S.sel) => S.data.scenes.find((s) => s.id === id);
export const latest = (sc) => sc.versions.at(-1).v;
export const viewed = (sc = scene()) => S.view[sc.id] ?? latest(sc);
export const sceneAt = (t) => S.data.scenes.findLast((s) => t >= s.start - 1e-6) ?? S.data.scenes[0];

// Timecode the way editing tools show it: m:ss:ff, frames on the storyboard's fps (30 by default).
export const fps = () => S.data?.fps || 30;
export const toFrame = (t) => Math.round(t * fps());
export function tc(t) {
  if (!Number.isFinite(t)) return "–";
  const f = toFrame(t), s = Math.floor(f / fps());
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}:${String(f - s * fps()).padStart(2, "0")}`;
}
