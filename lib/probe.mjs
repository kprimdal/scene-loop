// Reads a scene's layout in the page instead of from a picture: what the chat cannot be
// trusted to see in five stills (text cut off by its box or the frame, text on text, text too
// small to read, a broken image), and where each element is, so a comment's box can name the
// elements under it. From the Kinetograph project's lint and inspect, done here with Chrome's
// own layout. An element that an animation is moving at that moment is left out of the
// checks: half way through a slide-in is not a layout. Coordinates are canvas pixels.

// Runs in the page (stringified). opts: { width, height, elements: bool, region: {x,y,w,h}|null }.
// Returns { issues: [{ kind, element, text, message }], elements?: [...] }.
function probeInPage(opts) {
  const W = opts.width, H = opts.height, SLACK = 2;
  const scene = document.querySelector("[data-slot] .scene") || document.body;
  const moving = new Set();
  for (const a of document.getAnimations()) {
    const target = a.effect && a.effect.target;
    const ct = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
    if (!target || !ct || ct.localTime == null) continue;
    const delay = a.effect.getTiming().delay || 0;
    if (ct.localTime > delay && ct.localTime < delay + ct.activeDuration) moving.add(target);
  }
  const isMoving = (el) => { for (let e = el; e && e !== scene; e = e.parentElement) if (moving.has(e)) return true; return false; };
  const r = (x) => Math.round(x);
  const box = (b) => ({ x: r(b.left), y: r(b.top), w: r(b.width), h: r(b.height) });
  const describe = (el) => {
    if (el.id) return "#" + el.id;
    let up = el.parentElement;
    while (up && up !== scene && !up.id) up = up.parentElement;
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const index = el.parentElement ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName).indexOf(el) : 0;
    return (up && up !== scene ? "#" + up.id + " " : "") + el.tagName.toLowerCase() + cls + (index > 0 ? ":nth-of-type(" + (index + 1) + ")" : "");
  };
  // Visible: displayed, not hidden, its opacity through every ancestor above 5%.
  const opacityOf = (el) => {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none") return 0;
      o *= Number(cs.opacity);
    }
    return getComputedStyle(el).visibility === "hidden" ? 0 : o;
  };
  // The rectangle of an element's own text (its direct text nodes), or null.
  const textRect = (el) => {
    let rect = null;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const b of range.getClientRects()) {
        if (!b.width || !b.height) continue;
        rect = rect ? { left: Math.min(rect.left, b.left), top: Math.min(rect.top, b.top), right: Math.max(rect.right, b.right), bottom: Math.max(rect.bottom, b.bottom) } : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      }
    }
    return rect && { ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top };
  };
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").trim().replace(/\s+/g, " ");
  const past = (inner, outer) => Math.max(outer.left - inner.left, outer.top - inner.top, inner.right - outer.right, inner.bottom - outer.bottom);
  const issues = [];
  const add = (kind, el, message) => issues.push({ kind, element: describe(el), text: ownText(el).slice(0, 60), message });
  const canvas = { left: 0, top: 0, right: W, bottom: H };
  const texts = [];
  for (const el of scene.querySelectorAll("*")) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    if (el.tagName === "IMG" && el.complete && el.naturalWidth === 0 && el.getAttribute("src")) add("broken-image", el, "The image did not load: " + el.getAttribute("src"));
    const t = textRect(el);
    if (!t || isMoving(el)) continue;
    const opacity = opacityOf(el);
    if (opacity < 0.05) continue;
    if (t.right <= 0 || t.bottom <= 0 || t.left >= W || t.top >= H) continue; // wholly off the frame: not seen
    // Cut off by an ancestor that clips (overflow other than visible), the frame included.
    let clippedBy = null, shown = { ...t };
    for (let e = el.parentElement; e && e !== scene.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const b = e.getBoundingClientRect();
      if (past(t, b) > SLACK && !clippedBy) clippedBy = e;
      shown = { left: Math.max(shown.left, b.left), top: Math.max(shown.top, b.top), right: Math.min(shown.right, b.right), bottom: Math.min(shown.bottom, b.bottom) };
    }
    if (shown.right - shown.left <= 0 || shown.bottom - shown.top <= 0) continue; // clipped away completely: not seen
    if (past(t, canvas) > SLACK) add("off-frame", el, "Text runs " + r(past(t, canvas)) + " px past the edge of the frame.");
    else if (clippedBy && clippedBy !== scene) add("clipped", el, "Text is cut off by " + describe(clippedBy) + " (overflow " + getComputedStyle(clippedBy).overflow + "): it runs " + r(past(t, clippedBy.getBoundingClientRect())) + " px past it.");
    else {
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      if (!cs.display.startsWith("inline") && cs.display !== "contents" && b.width > 0 && past(t, b) > SLACK) add("overflow", el, "Text runs " + r(past(t, b)) + " px out of its own box (" + r(b.width) + "x" + r(b.height) + " px): a word too long for the width or more lines than the height.");
    }
    // Drawn size: font-size times the element's scale on screen.
    const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
    const scale = el.offsetHeight ? el.getBoundingClientRect().height / el.offsetHeight : 1;
    const px = fs * scale;
    if (opacity >= 0.5 && px > 0 && px < Math.min(W, H) * 0.018) add("small-text", el, "Text is " + r(px) + " px high on a " + W + "x" + H + " frame: hard to read on a phone. " + r(Math.min(W, H) * 0.022) + " px or more reads well.");
    if (opacity >= 0.5) texts.push({ el, t, area: t.width * t.height });
  }
  // Text on text: two visible texts sharing more than a fifth of the smaller one's area.
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.t.right, b.t.right) - Math.max(a.t.left, b.t.left), h = Math.min(a.t.bottom, b.t.bottom) - Math.max(a.t.top, b.t.top);
      if (w > 0 && h > 0 && w * h > 0.2 * Math.min(a.area, b.area) && w * h > 100) add("overlap", a.el, "Text overlaps " + describe(b.el) + (ownText(b.el) ? ' ("' + ownText(b.el).slice(0, 40) + '")' : "") + ".");
    }
  }
  const out = { issues };
  if (opts.elements) {
    const reg = opts.region;
    const list = [];
    for (const el of scene.querySelectorAll("*")) {
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1 || b.right <= 0 || b.bottom <= 0 || b.left >= W || b.top >= H) continue;
      const opacity = opacityOf(el);
      if (opacity < 0.05) continue;
      const cs = getComputedStyle(el);
      const text = ownText(el);
      const tag = el.tagName.toLowerCase();
      const painted = /^(img|video|svg|canvas)$/.test(tag) || cs.backgroundImage !== "none" || !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0;
      if (!el.id && !text && !painted) continue;
      let cover = null;
      if (reg) {
        const w = Math.min(b.right, reg.x + reg.w) - Math.max(b.left, reg.x), h = Math.min(b.bottom, reg.y + reg.h) - Math.max(b.top, reg.y);
        if (w <= 0 || h <= 0) continue;
        cover = (w * h) / (b.width * b.height); // how much of the element is inside the box
      }
      list.push({
        element: describe(el), tag, ...(text ? { text: text.slice(0, 80) } : {}), box: box(b), opacity: Math.round(opacity * 100) / 100,
        ...(text ? { fontSize: r((parseFloat(cs.fontSize) || 0) * (el.offsetHeight ? b.height / el.offsetHeight : 1)), font: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(), color: cs.color } : {}),
        ...(isMoving(el) ? { moving: true } : {}), ...(cover != null ? { inside: Math.round(cover * 100) / 100 } : {}),
      });
    }
    // In a box: the elements most inside it first, then the smaller one (the more specific).
    if (reg) list.sort((a, b) => b.inside - a.inside || a.box.w * a.box.h - b.box.w * b.box.h);
    out.elements = list.slice(0, reg ? 12 : 200);
  }
  return out;
}

export const probeExpression = (opts) => `(${probeInPage.toString()})(${JSON.stringify(opts)})`;

// Times worth checking besides the stills: just after each animation in the scene comes to
// rest, where a layout is final. Scene seconds, in the page.
export const REST_TIMES = `(() => {
  const out = [];
  for (const a of document.getAnimations()) {
    const ct = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming();
    if (ct && isFinite(ct.endTime)) out.push(ct.endTime / 1000 + 0.02);
  }
  return out;
})()`;

// Merges per-time issues into one entry per kind and element, with the times it was seen.
export function mergeIssues(perTime) {
  const byKey = new Map();
  for (const { t, issues } of perTime) {
    for (const i of issues) {
      const key = `${i.kind} ${i.element} ${i.message.replace(/\d+ px/g, "")}`;
      if (!byKey.has(key)) byKey.set(key, { ...i, times: [] });
      const e = byKey.get(key);
      if (!e.times.includes(t)) e.times.push(t);
    }
  }
  return [...byKey.values()].slice(0, 40);
}

// Check times: the still times plus the rest times inside the scene that are 50 ms or more
// from any other, sorted, at most `max` (the rest times then spread evenly).
const round2 = (t) => Math.round(t * 100) / 100;
export function checkTimes(stillTimes, restTimes, duration, max = 24) {
  const stills = [...stillTimes];
  const extra = [];
  for (const t of [...restTimes].filter((t) => t > 0 && t < duration - 0.01).map(round2).sort((a, b) => a - b)) {
    if (stills.every((x) => Math.abs(x - t) >= 0.05) && (!extra.length || t - extra.at(-1) >= 0.05)) extra.push(t);
  }
  const room = Math.max(0, max - stills.length);
  const picked = extra.length <= room ? extra : Array.from({ length: room }, (_, i) => extra[Math.floor((i * extra.length) / room)]);
  return [...new Set([...stills, ...picked])].sort((a, b) => a - b);
}
