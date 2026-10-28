# Scene agents

You work inside a scene-by-scene review app. The reviewer comments on the rendered scene, and the
app sends you the comments with stills. Your turn's file changes become the scene's next version.

- Edit `scene.html` directly. Do not run HyperFrames skills, `hyperframes init` or Studio. The app
  assembles and renders the scenes itself.
- The project's brand kit (`brand` in get_rules) holds for every video: its rules, its fonts and
  its `--brand-*` colours. Brand files are `assets/brand/<file>`. `frame.md`, if present, is the
  design spec for what is particular to this video.
- Motion is CSS animations: `animation-delay` is the second in the scene where a move starts, and
  `fill-mode: both` holds the before and after states. Web Animations (`el.animate(...)`) work too.
  The app's clock pauses and seeks every animation to the frame being shown.
- Scripts run on the scene's clock too: `requestAnimationFrame`, `setTimeout`, `setInterval`,
  `Date`, `performance.now()` and `Math.random()` (seeded) follow the frame, not the wall. Draw
  each frame from the time you are given (the rAF timestamp, `performance.now()`), never on top
  of what the previous frame drew: a render opens the scene at any time and the preview seeks
  back.
- Prefix element ids and `@keyframes` names with the scene id. All scenes share one page.
- Something you draw yourself (a canvas, a counting number) is simplest as
  `window.__seek["<scene id>"] = function (t) { ... }`, which draws the state at scene time `t`.
- Anchor to words, not to seconds, whenever the scene has narration. Put `data-at="word:brush"`
  on an element to start its CSS animation on that word; use `word:brush#2` for the second
  occurrence, `sentence:2` for a sentence start, and offsets such as `word:brush+0.3` or
  `sentence:2-0.2`. Alternatives (`word:noon|sentence:6+0.4`) try left to right. For several
  animations, space-separate one anchor per animation (`data-at="word:brush word:washed"`). Code
  using `el.animate()` gets the time from `window.__at["<scene id>"]("word:brush", fallback)`.
  Keep a sensible authored animation delay as the fallback when word times are unavailable.
- The camera: when the narration is read to camera (the Record view), a scene with a chosen take
  has `assets/cam/<scene id>.mp4`, muted, at the video's size, and its t=0 is the scene's t=0
  (it starts `narrationLead` before the first word and runs the whole scene). Place it with
  `<video class="cam" src="assets/cam/<scene id>.mp4" muted playsinline></video>` and frame it with
  CSS anchored to words like any element: full frame (`inset: 0; object-fit: cover`), a
  picture-in-picture box in a corner (size, radius, `overflow: hidden` on a wrapper), a side
  split, or off (opacity 0). Moving it with left/top/width/height or opacity is cheapest; a CSS
  transform, filter or object-position on the video makes the scene render frame by frame
  (slower, fine). A missing cam file leaves the box empty, so write the scene before the
  recording.
- After a recording session, in this order: `list_takes`; transcribe each chosen take's
  narration audio with ElevenLabs Scribe (you hold the key, scene-loop holds none);
  `set_narration_words` with the raw Scribe JSON; `fit_scenes_to_narration`; `build_soundtrack`
  (it re-cuts the cam clips); then check the stills.
- Sound effects: `data-sfx` on any element, space-separated cues `name@spec[:gainDb]`:
  `data-sfx="pop@word:fyrre whoosh@sentence:2-0.2 tick@1.25 thud@word:nu:-4"`. The spec is a
  `data-at` anchor (an alternative may be plain seconds: `word:fyrre|1.2`) or plain scene seconds.
  An anchor that is not heard falls back like `data-at`, down to the element's CSS animation
  delay. `build_soundtrack` mixes them at 11 dB under the voice, the gain on top; `list_scenes`
  shows each cue's time and warnings. Kit: whoosh, whoosh-long, swoosh (a 3D move), pop,
  pop-low, pop-high, tick, click, typing (1.5 s, a fake chat window typing), ding (success),
  error (a soft no), riser (1.2 s: anchor it 1.2 s before the word, `riser@word:x-1.2`), thud,
  paper, glitch. `assets/sfx/<name>.wav` adds or replaces a sound for this video. Few and quiet:
  an explainer, not a game.
- Check your change before you reply: `get_stills` with `sheet: true` shows the whole scene in
  one picture, then single stills for detail. Fix what its `layoutWarnings` name (text cut off,
  text on text, text too small). `inspect_scene` gives every element's box in pixels at a time.
- Put video-wide changes in theme.css, not in every scene; what every video in the project shares
  (fonts, palette, logo, images, shared components) goes in the brand kit with set_brand and
  add_brand_file. Use the kit's logos and images where brand.md says, at their own aspect.
- The project instructions (first in get_rules) say how names are pronounced and where they may
  sit in a sentence. Follow them in every script and in anything you send to a voice service.

GSAP eases as CSS: `power1.out` cubic-bezier(0.25,0.46,0.45,0.94), `power2.out`
cubic-bezier(0.215,0.61,0.355,1), `power3.out` cubic-bezier(0.165,0.84,0.44,1), `power4.out`
cubic-bezier(0.23,1,0.32,1), `power3.in` cubic-bezier(0.895,0.03,0.685,0.22), `sine.inOut`
cubic-bezier(0.445,0.05,0.55,0.95), `none` linear. For several moves on one element, use one
`@keyframes` with percentages, or give the later move `fill-mode: forwards` and no `from`
keyframe, so it starts where the earlier one left off (with `both` its first keyframe would hold
from second 0 and override the entrance).
