// Word-anchor resolution, shared by the page (inlined before anchors.js) and the server
// (list_scenes reports anchors that don't resolve). No DOM in here.
//   at(words, lead, spec, fallback) -> { t, resolved, warnings }
// spec: "word:brush", "word:brush#2", "sentence:2", with an offset "+0.3" / "-0.25" and
// alternatives separated by "|". A word may contain hyphens or apostrophes ("soft-bristled"):
// matching strips everything but letters and digits, and an offset is a sign followed by digits.
var __slAnchorCore = (function () {
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
  var SPEC = /^(word|sentence):(.+?)(?:#(\d+))?([+-]\d*\.?\d+)?$/;
  function one(words, keys, lead, spec, warn) {
    var m = SPEC.exec(spec.trim());
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
  function at(words, lead, spec, fallback) {
    var keys = words.map(function (w) { return norm(w.word); }), warnings = [];
    var warn = function (m) { warnings.push(m); };
    var alternatives = String(spec).split("|");
    for (var i = 0; i < alternatives.length; i++) {
      var time = one(words, keys, lead, alternatives[i], warn);
      if (time != null) { if (i) warn(alternatives[0] + " not found, used " + alternatives[i]); return { t: time, resolved: true, warnings: warnings }; }
    }
    warn(spec + " not found, kept the CSS time " + fallback + " s");
    return { t: fallback, resolved: false, warnings: warnings };
  }
  return { norm: norm, near: near, at: at, SPEC: SPEC };
})();
