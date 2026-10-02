// <scene-player src="…/index.html">: the preview. An iframe over an assembled build,
// scaled to fit, driven through the page clock (window.__sl.seek in the build, see
// lib/clock.js). The clock lives here: play() advances time on requestAnimationFrame
// and seeks the page every frame, the same seek() the renderer uses. The soundtrack plays
// in this document, not in the iframe, so the play click counts as the user gesture.
// Interface: src, ready, duration, currentTime, paused, play(), pause(), seek(t).
class ScenePlayer extends HTMLElement {
  static observedAttributes = ["src"];

  constructor() {
    super();
    this.ready = false;
    this.duration = 0;
    this.paused = true;
    this._t = 0;
    this._frame = null; // the iframe on show; a new src loads in a second one and swaps in when ready
    this._page = null; // window.__sl of the frame on show
    this._audio = null;
    this._size = { width: 1920, height: 1080 };
    this._loads = 0;
    new ResizeObserver(() => this._fit()).observe(this);
  }

  connectedCallback() {
    this.style.position ||= "relative";
    this.style.overflow = "hidden";
  }

  get currentTime() {
    return this._t;
  }

  // Every set of src loads, even to the same URL: the page sets it only when the build
  // behind it changed (a new version, theme, duration or order).
  attributeChangedCallback(name, old, src) {
    if (src) this._load(src);
  }

  async _load(src) {
    const n = ++this._loads;
    this.pause();
    this.ready = false;
    const f = document.createElement("iframe");
    f.setAttribute("scrolling", "no");
    f.setAttribute("tabindex", "-1");
    f.style.cssText = "position:absolute;left:0;top:0;border:0;transform-origin:0 0;pointer-events:none;visibility:hidden";
    this.append(f);
    const loaded = new Promise((r) => f.addEventListener("load", r, { once: true }));
    f.src = src;
    await loaded;
    const sl = f.contentWindow.__sl;
    if (!sl) return n === this._loads ? (f.remove(), this.dispatchEvent(new CustomEvent("error", { detail: "no page clock in " + src }))) : f.remove();
    await sl.ready;
    if (n !== this._loads) return f.remove(); // a newer src won
    this._frame?.remove();
    this._frame = f;
    this._page = sl;
    this._size = { width: sl.width, height: sl.height };
    this.duration = sl.duration;
    f.style.visibility = "visible";
    this._fit();
    this._audio?.pause();
    this._audio = null;
    if (sl.audio?.src) {
      this._audio = new Audio(new URL(sl.audio.src, f.contentWindow.location.href).href);
      this._audio.preload = "auto";
      this._mediaStart = Number(sl.audio.mediaStart) || 0;
    }
    this._t = 0;
    sl.seek(0);
    this.ready = true;
    this.dispatchEvent(new Event("ready"));
  }

  _fit() {
    if (!this._frame) return;
    const { width, height } = this._size;
    const k = Math.min(this.clientWidth / width, this.clientHeight / height) || 1;
    Object.assign(this._frame.style, { width: width + "px", height: height + "px", transform: `scale(${k})`, left: (this.clientWidth - width * k) / 2 + "px", top: (this.clientHeight - height * k) / 2 + "px" });
  }

  seek(t) {
    this._t = Math.max(0, Math.min(Number(t) || 0, this.duration));
    this._page?.seek(this._t);
    if (!this.paused) {
      this._t0 = performance.now() - this._t * 1000;
      this._syncAudio(true);
    }
  }

  play() {
    if (!this.ready || !this.paused) return;
    if (this._t >= this.duration - 0.01) this._t = 0;
    this.paused = false;
    this._t0 = performance.now() - this._t * 1000;
    this._syncAudio(true);
    const step = () => {
      if (this.paused) return;
      const t = (performance.now() - this._t0) / 1000;
      if (t >= this.duration) {
        this._t = this.duration;
        this._page.seek(this._t);
        return this.pause();
      }
      this._t = t;
      this._page.seek(t);
      this._syncAudio(false);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  pause() {
    this.paused = true;
    cancelAnimationFrame(this._raf);
    this._audio?.pause();
  }

  // The picture follows the wall clock; the soundtrack is nudged back when it drifts.
  _syncAudio(force) {
    const a = this._audio;
    if (!a) return;
    const want = this._mediaStart + this._t;
    if (force || Math.abs(a.currentTime - want) > 0.15) a.currentTime = want;
    if (a.paused) a.play().catch(() => {});
  }
}

customElements.define("scene-player", ScenePlayer);
