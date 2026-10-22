export const $ = (s) => document.querySelector(s);
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};

export function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4200);
}

export const ago = (iso) => {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};
export const mmss = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const audioTime = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  return `${minutes}:${(value - minutes * 60).toFixed(1).padStart(4, "0")}`;
};
// 0 → "0 B", 1234 → "1.2 kB", 2.7e9 → "2.7 GB" (decimal units, as Finder shows them)
export const bytes = (n) => {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let i = 0, v = Math.max(0, Number(n) || 0);
  while (v >= 999.5 && i < units.length - 1) v /= 1000, i++;
  return `${i === 0 ? v : v < 9.95 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};
export const countWords =(text) => String(text ?? "").trim().split(/\s+/).filter(Boolean).length;

// A word diff from `from` to `to`, for the Script view: [{ op: "same" | "ins" | "del", text }].
// Words match when they agree in letters and digits, so a moved comma is no change.
export function wordDiff(from, to) {
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const a = String(from ?? "").split(/\s+/).filter(Boolean), b = String(to ?? "").split(/\s+/).filter(Boolean);
  const A = a.map(norm), B = b.map(norm);
  const lcs = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && A[i] === B[j]) out.push({ op: "same", text: b[j++] }), i++;
    else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ op: "del", text: a[i++] });
    else out.push({ op: "ins", text: b[j++] });
  }
  return out;
}
