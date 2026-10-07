// Word-anchor resolver, inlined after scene markup and before scene scripts and the clock.
// The matching lives in anchor-core.js (inlined just before this), shared with the server.
(function () {
  var cfg = window.__slConfig, all = window.__anchors = window.__anchors || [], core = __slAnchorCore;
  window.__at = window.__at || {}; window.__anchorWarnings = window.__anchorWarnings || [];
  cfg.scenes.forEach(function (scene) {
    var words = scene.words || [];
    var lead = Number(scene.narrationLead == null ? 0.35 : scene.narrationLead);
    var warn = function (m) { m = scene.id + ": " + m; window.__anchorWarnings.push(m); console.warn(m); };
    function at(spec, fallback) {
      var r = core.at(words, lead, spec, fallback);
      r.warnings.forEach(warn);
      return r.t;
    }
    window.__at[scene.id] = at;
    document.querySelectorAll('[data-slot="' + scene.id + '"] [data-at]').forEach(function (el) {
      var specs = el.getAttribute("data-at").trim().split(/\s+/), style = getComputedStyle(el);
      var delays = style.animationDelay.split(",").map(parseFloat), count = style.animationName.split(",").length, shift = 0, out = [];
      for (var i = 0; i < count; i++) {
        var delay = delays[i % delays.length]; if (i < specs.length) shift = at(specs[i], delay) - delay;
        out.push(delay + shift + "s"); all.push({ scene: scene.id, id: el.id || el.tagName, spec: specs[Math.min(i, specs.length - 1)], css: delay, t: delay + shift });
      }
      el.style.animationDelay = out.join(",");
    });
  });
})();
