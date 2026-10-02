// Word-anchor resolver, inlined after scene markup and before scene scripts and the clock.
(function () {
  var cfg = window.__slConfig, all = window.__anchors = window.__anchors || [];
  window.__at = window.__at || {}; window.__anchorWarnings = window.__anchorWarnings || [];
  var norm = function (w) { return String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); };
  var near = function (a, b) {
    if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
    for (var i = 0, j = 0, d = 0; i < a.length || j < b.length;) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return true;
  };
  cfg.scenes.forEach(function (scene) {
    var words = scene.words || [], keys = words.map(function (w) { return norm(w.word); });
    var lead = Number(scene.narrationLead == null ? 0.35 : scene.narrationLead);
    var warn = function (m) { m = scene.id + ": " + m; window.__anchorWarnings.push(m); console.warn(m); };
    function one(spec) {
      var m = /^(word|sentence):([^#+-]+)(?:#(\d+))?([+-][\d.]+)?$/.exec(spec.trim());
      if (!m) return null;
      var n = Number(m[3] || 1), off = Number(m[4] || 0), hit = [];
      if (m[1] === "sentence") {
        for (var i = 0, sentence = 1; i < words.length; i++) { if (sentence === Number(m[2])) { hit.push(i); break; } if (/[.!?]["')]*$/.test(words[i].word)) sentence++; }
        n = 1;
      } else {
        var key = norm(m[2]); keys.forEach(function (word, i) { if (word === key) hit.push(i); });
        if (hit.length < n) {
          var fuzzy = []; keys.forEach(function (word, i) { if (near(word, key)) fuzzy.push(i); });
          if (fuzzy.length >= n) warn(spec + " not heard, used '" + words[fuzzy[n - 1]].word + "'");
          hit = fuzzy;
        }
      }
      return hit.length >= n ? Math.round((words[hit[n - 1]].start + lead + off) * 1000) / 1000 : null;
    }
    function at(spec, fallback) {
      var alternatives = spec.split("|");
      for (var i = 0; i < alternatives.length; i++) {
        var time = one(alternatives[i]);
        if (time != null) { if (i) warn(alternatives[0] + " not found, used " + alternatives[i]); return time; }
      }
      warn(spec + " not found, kept the CSS time " + fallback + " s"); return fallback;
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
