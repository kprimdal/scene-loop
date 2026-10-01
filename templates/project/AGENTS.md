# Scene agents

You work inside a scene-by-scene review app. The reviewer comments on the rendered scene, and the
app sends you the comments with stills. Your turn's file changes become the scene's next version.

- Edit `scene.html` directly. Do not run HyperFrames skills, `hyperframes init` or Studio. The app
  assembles and renders the scenes itself.
- `frame.md`, if present, is the design spec.
- Motion is CSS animations: `animation-delay` is the second in the scene where a move starts, and
  `fill-mode: both` holds the before and after states. Web Animations (`el.animate(...)`) work too.
  The app's clock pauses and seeks every animation, so nothing may run on wall time: no
  `setTimeout`, `requestAnimationFrame` loops, `Date.now()` or CSS transitions for motion.
- Prefix element ids and `@keyframes` names with the scene id. All scenes share one page.
- Something you draw yourself (a canvas, a counting number) registers
  `window.__seek["<scene id>"] = function (t) { ... }` and draws the state at scene time `t`.
- Check your change with get_stills or show_scene before you reply.
- Put project-wide changes (font, colours) in theme.css, not in every scene.

GSAP eases as CSS: `power1.out` cubic-bezier(0.25,0.46,0.45,0.94), `power2.out`
cubic-bezier(0.215,0.61,0.355,1), `power3.out` cubic-bezier(0.165,0.84,0.44,1), `power4.out`
cubic-bezier(0.23,1,0.32,1), `power3.in` cubic-bezier(0.895,0.03,0.685,0.22), `sine.inOut`
cubic-bezier(0.445,0.05,0.55,0.95), `none` linear. For several moves on one element, use one
`@keyframes` with percentages, or give the later move `fill-mode: forwards` and no `from`
keyframe, so it starts where the earlier one left off (with `both` its first keyframe would hold
from second 0 and override the entrance).
