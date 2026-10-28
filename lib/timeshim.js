// Time for scene scripts, inlined at the top of every assembled page by lib/assemble.mjs,
// before anything else runs. requestAnimationFrame, setTimeout, setInterval, Date,
// performance.now and Math.random no longer follow the wall clock: the page clock
// (lib/clock.js) moves them with every seek, so a counter, a canvas loop or a chart library's
// own animation shows the same picture in the preview, the stills and the render. The idea is
// the Kinetograph project's "determinism shim".
//
// Each scene has its own time, in its own seconds, the time window.__seek[id] gets: code a
// scene's <script> runs (and the callbacks it registers, and theirs) reads that scene's time.
// Other code (a library loaded in <head>) reads the page's time.
//
// A seek forward steps the frame grid from where the scene was: at each frame the timers due
// by then fire in order, then the requestAnimationFrame callbacks run with that frame's time.
// So a page opened at 12 s and a page played from 0 to 12 s run the same callbacks at the
// same times and draw the same frame; a render splits a scene over fresh pages and must get
// the same pictures. A seek back cannot undo what a script did: the scene's time is set back
// and one frame runs, so code that draws from the time it is given (not on top of the
// previous frame) shows the right picture there too. Animations a callback starts (a class
// that starts a CSS animation or transition, el.animate()) start at that frame's time.
(function () {
  if (window.__slTime) return;
  var real = {
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    now: performance.now.bind(performance),
    Date: Date,
    random: Math.random,
  };
  window.__slReal = real;

  var BASE = Date.UTC(2026, 0, 1); // what new Date() says at time 0, the same everywhere
  var MAX_STEPS = 30 * 120; // frames one seek replays at most; a longer jump skips ahead
  var clocks = {}; // "" for the page, else a scene id -> { t, timers, frames, used, drawnAt }
  var current = null, seq = 0;
  function clock(key) {
    key = key || "";
    return clocks[key] || (clocks[key] = { key: key, t: 0, timers: [], frames: [], used: false, drawnAt: null });
  }
  function nowMs() { return clock(current).t * 1000; }

  performance.now = function () { return nowMs(); };
  function SLDate() {
    var args = [].slice.call(arguments);
    if (!(this instanceof SLDate)) return new real.Date(BASE + nowMs()).toString();
    if (!args.length) args = [BASE + nowMs()];
    return new (Function.prototype.bind.apply(real.Date, [null].concat(args)))();
  }
  SLDate.prototype = real.Date.prototype;
  SLDate.now = function () { return BASE + Math.round(nowMs()); };
  SLDate.UTC = real.Date.UTC;
  SLDate.parse = real.Date.parse;
  window.Date = SLDate;

  // mulberry32, one fixed seed per page
  var seed = 0x5ce1e100;
  Math.random = function () {
    seed = (seed + 0x6d2b79f5) | 0;
    var r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };

  function timer(fn, ms, args, every) {
    var c = clock(current);
    c.used = true;
    var f = typeof fn === "function" ? fn : new Function(String(fn));
    var t = { id: ++seq, due: c.t + Math.max(0, Number(ms) || 0) / 1000, fn: f, args: args, every: every ? Math.max(1, Number(ms) || 0) / 1000 : 0, scene: current };
    c.timers.push(t);
    return t.id;
  }
  function drop(list, id) {
    for (var k in clocks) {
      var l = clocks[k][list];
      for (var i = 0; i < l.length; i++) if (l[i].id === id) return void l.splice(i, 1);
    }
  }
  window.setTimeout = function (fn, ms) { return timer(fn, ms, [].slice.call(arguments, 2), false); };
  window.setInterval = function (fn, ms) { return timer(fn, ms, [].slice.call(arguments, 2), true); };
  window.clearTimeout = window.clearInterval = function (id) { drop("timers", id); };
  window.requestAnimationFrame = function (fn) {
    var c = clock(current);
    c.used = true;
    c.frames.push({ id: ++seq, fn: fn, scene: current });
    return seq;
  };
  window.cancelAnimationFrame = function (id) { drop("frames", id); };

  function run(scene, fn, args) {
    var prev = current;
    current = scene;
    try { fn.apply(window, args); } catch (e) { real.setTimeout(function () { throw e; }); } finally { current = prev; }
  }

  // Animations that callbacks start begin at the time they were started: { key, t } on the
  // animation, read by lib/clock.js.
  function marked() {
    var a = document.getAnimations();
    for (var i = 0; i < a.length; i++) if (!a[i].__slSeen) a[i].__slSeen = true;
  }
  function birth(c) {
    var a = document.getAnimations();
    for (var i = 0; i < a.length; i++) {
      if (a[i].__slSeen) continue;
      a[i].__slSeen = true;
      a[i].__slBorn = { key: c.key, t: c.t };
      a[i].pause();
    }
  }

  // Fires what is due by `to`, then the frame callbacks at `to` (once per time).
  function stepTo(c, to) {
    var ran = false, guard = 0;
    for (;;) {
      var next = null;
      for (var i = 0; i < c.timers.length; i++) {
        var x = c.timers[i];
        if (x.due <= to + 1e-9 && (!next || x.due < next.due || (x.due === next.due && x.id < next.id))) next = x;
      }
      if (!next || ++guard > 10000) break;
      if (!ran) (marked(), ran = true);
      c.t = Math.max(c.t, next.due);
      if (next.every) next.due += next.every;
      else c.timers.splice(c.timers.indexOf(next), 1);
      run(next.scene, next.fn, next.args);
    }
    c.t = to;
    if (c.drawnAt !== to && c.frames.length) {
      if (!ran) (marked(), ran = true);
      var frames = c.frames;
      c.frames = [];
      for (var j = 0; j < frames.length; j++) run(frames[j].scene, frames[j].fn, [to * 1000]);
    }
    c.drawnAt = to;
    if (ran) birth(c);
  }

  // Moves one clock (a scene id, or "" for the page) to t seconds.
  function advance(key, t, fps) {
    var c = clock(key);
    if (!c.used) { c.t = t; return; }
    if (t < c.t - 1e-9) {
      var back = t - c.t;
      for (var i = 0; i < c.timers.length; i++) c.timers[i].due += back; // timers keep their spacing
      stepTo(c, t);
      return;
    }
    var k = Math.floor(c.t * fps + 1e-6) + 1, last = Math.ceil(t * fps - 1e-6) - 1;
    if (last - k + 1 > MAX_STEPS) k = last - MAX_STEPS + 1;
    for (; k <= last; k++) stepTo(c, k / fps);
    stepTo(c, t);
  }

  window.__slTime = {
    enter: function (id) { current = id; },
    leave: function () { current = null; },
    advance: advance,
    used: function (key) { return !!(clocks[key || ""] && clocks[key || ""].used); },
  };
})();
