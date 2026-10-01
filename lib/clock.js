// The page clock, inlined into every assembled page by lib/assemble.mjs. Nothing in the
// page runs on wall time: seek(t) puts every scene at its own local time, pauses every
// CSS animation and Web Animation and sets its currentTime, seeks legacy GSAP timelines
// (window.__timelines[id]) and calls any window.__seek[id](t) a scene registered for
// drawing it does itself. The preview player and the renderer both drive the page only
// through seek(), so what the page shows is what the render gets.
(function () {
  var cfg = window.__slConfig;
  var slots = cfg.scenes.map(function (s) {
    return { id: s.id, start: s.start, duration: s.duration, fade: s.fade || 0, el: document.querySelector('[data-slot="' + s.id + '"]') };
  });
  var byId = {};
  slots.forEach(function (s) { byId[s.id] = s; });
  window.__seek = window.__seek || {};

  function slotOf(node) {
    var el = node && node.closest ? node.closest("[data-slot]") : null;
    return el ? byId[el.getAttribute("data-slot")] : null;
  }

  function seek(t) {
    t = Math.max(0, Math.min(Number(t) || 0, cfg.duration));
    slots.forEach(function (s, i) {
      var next = slots[i + 1];
      var local = t - s.start;
      var end = next ? next.start + Math.min(next.fade, next.duration) : cfg.duration + 1; // held under the next scene's fade
      var on = local >= 0 && t < end;
      s.local = Math.max(0, Math.min(local, s.duration));
      s.el.style.visibility = on ? "visible" : "hidden";
      s.el.style.opacity = s.fade && local >= 0 && local < s.fade ? String(local / s.fade) : "1";
    });
    var anims = document.getAnimations();
    for (var i = 0; i < anims.length; i++) {
      var a = anims[i], s = slotOf(a.effect && a.effect.target);
      if (a.playState !== "paused") a.pause();
      a.currentTime = (s ? s.local : t) * 1000; // outside a scene (theme.css on body): video time
    }
    var waits = [];
    slots.forEach(function (s) {
      var tl = window.__timelines && window.__timelines[s.id];
      if (tl && tl.seek) (tl.pause(), tl.seek(s.local, false));
      if (typeof window.__seek[s.id] === "function") window.__seek[s.id](s.local);
      s.el.querySelectorAll("video").forEach(function (v) {
        v.pause();
        var want = s.local + Number(v.getAttribute("data-media-start") || 0);
        if (Math.abs(v.currentTime - want) > 0.001) {
          waits.push(new Promise(function (r) { v.addEventListener("seeked", r, { once: true }); }));
          v.currentTime = want;
        }
      });
    });
    return waits.length ? Promise.all(waits).then(function () { return t; }) : t;
  }

  var ready = Promise.all(
    [document.fonts.ready]
      .concat([].map.call(document.images, function (img) {
        // load events, not img.decode(): decode() never settles in a background tab of full Chrome
        return img.complete ? null : new Promise(function (r) { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); });
      }))
      .concat([].map.call(document.querySelectorAll("video"), function (v) {
        return v.readyState >= 2 ? null : new Promise(function (r) { v.addEventListener("loadeddata", r, { once: true }); v.addEventListener("error", r, { once: true }); });
      })),
  ).then(function () { return seek(0); }).then(function () { api.isReady = true; return api; });

  var api = { duration: cfg.duration, width: cfg.width, height: cfg.height, fps: cfg.fps, audio: cfg.audio, scenes: cfg.scenes, seek: seek, ready: ready, isReady: false };
  window.__sl = api;
  seek(0);
})();
