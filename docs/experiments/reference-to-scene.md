# Reference to scene: meadow camera reveal

This 7-second experiment tests whether scene-loop can approximate the composition and depth cues of one existing environment shot with original HTML/SVG/CSS. It can express the broad layered reveal. It does not reproduce the reference's material detail, lighting, physical camera motion or sound. This result supports a layered illustration workflow, not a general recreation claim.

## Reference and rights

- **Film/creator:** Big Buck Bunny (2008), Blender Foundation / Peach open movie project.
- **Source:** [official movie download directory](https://download.blender.org/peach/bigbuckbunny_movies/), `big_buck_bunny_480p_h264.mov.zip`.
- **Selected original range:** **00:03.000 inclusive to 00:10.000 exclusive**, before the stream shot. Local comparison time 0 corresponds to original time 3 seconds. There is no cut within the selection.
- **License:** [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/), verified against [Blender's license and excerpt attribution instructions](https://peach.blender.org/about/) on 2026-10-25.
- **Required excerpt credit:** (c) copyright 2008, Blender Foundation / www.bigbuckbunny.org.
- **Comparison changes:** trimmed, original 853 × 480 video scaled to 854 × 480 for even H.264 dimensions, H.264 re-encode, six-channel audio downmixed to stereo AAC. No source code or film assets are included here. Original sample geometry is under this repository's license.

The downloaded movie, selected excerpt, extracted frames/audio, transcript and comparison renders stay outside the repository. The private PR review artifact holds a reusable excerpt and matched frames. The sample needs none of them at runtime.

## Observed sequence and selected intent

All 7 one-second sample frames were inspected, plus exact endpoint frames. The camera appears to tilt down and advance; this is an inference from screen-space movement, not a recovered camera solve.

| Local time | Evidence in the reference | Selected target |
| --- | --- | --- |
| 0 s (original 3 s) | Pink cloud fills the left; pale light at upper right. Tree cluster enters from lower right. Meadow is below frame. | Warm/cool palette and asymmetric composition. |
| 1–3 s | Ridge and distant fields rise into view. The large conifer rises faster than the ridge. | Separate rates for sky, ridge, fields and tree cluster. |
| 4–6 s | Foreground slope, grass, rocks and flowers enter. Conifer nearly fills the height; little trees remain at left. | Delayed foreground reveal and a continuous move without cuts. |
| 6.958 s | Meadow foreground fills the lower area. Tree cluster remains right-heavy. | Hold the spatial hierarchy through the last encoded frame. |

The test deliberately selects a stylized environment rather than character acting. It exercises the proposed environment/city idea's depth and camera cues, but it supplies no evidence about dense city occlusion, buildings, orbiting cameras or 3D asset reconstruction.

## Attempt and one correction

[The sample](../../examples/reference-study/README.md) uses five inline SVG groups inside the scene HTML. Five linear CSS keyframe animations use the existing frozen clock. The foliage, cloud outline, rocks and flowers are original simplified geometry. No Python-drawn frames, external engine, model call, paid media service or dependency was used.

The first attempt rendered successfully. Its tree started too high, and its distant ridge ended too low. One focused correction adjusted the tree's initial offset by +45 px and increased the ridge's upward travel by 40 px. The private artifact preserves the first MP4 and midpoint frame beside the corrected evidence. No further polish pass was made.

| Layer | Corrected authored travel across 7 s | Interpretation |
| --- | --- | --- |
| Sky | y: 0 → −145 px | Slowest backdrop. |
| Ridge | y: 0 → −235 px | Distant landscape reveal. |
| Fields | y: 0 → −215 px | A separate contour, not physical perspective. |
| Trees | translate (0,45) → (−14,−282) px; scale 1 → 1.04, origin (580,540) | Faster rise and mild approach. Translation is before the effect of scale about the origin. |
| Foreground | translate (0,0) → (−20,−300) px | Late reveal from below frame. |

These values are authored screen-space estimates, not measured Blender camera coordinates. Independent layer rates do not constitute a coherent 3D camera. The ridge even travels faster than the field layer; contours hide some of this mismatch in the chosen shot.

## What worked and what did not

| Dimension | Actual result | Gap and next appropriate tool/asset |
| --- | --- | --- |
| Layout | Right-heavy tree mass, open left side, pink sky, cool ridge and green meadow remain readable. | Round canopy blobs and a regular conifer silhouette differ visibly. An artist-authored layered illustration would improve the shape language. |
| Motion/depth | Independent continuous transforms produce a convincing general downward reveal in this one fixed view. | It resembles stacked illustration planes. There is no geometric parallax within a tree, recovered lens, depth of field or camera solve. Use a 3D environment/rendered plate for a close match or a camera orbit. |
| Timing | Both excerpts run 7.000 s at 24 fps. Foreground enters later than background. | Reference speed changes and perspective are not recovered. Linear rates only approximate the trajectory. No claim of frame-perfect reference tracking. |
| Light/material | Palette and broad depth separation survive. | Volumetric cloud edges, translucent foliage, dense grass, soft shadows and surface response are absent. More CSS alone does not establish feasibility for those qualities. |
| Sound | Reference audio is present and playable. Attempt contains no audio stream. | Sound is omitted, so the attempt is incomplete as an audiovisual match. Music/ambience assets and a deliberate mix are separate work. No substitute sound was generated. |

### Audio analysis

The original has 48 kHz six-channel AAC. The excerpt retains a stereo downmix. It was converted to 16 kHz mono PCM for local `whisper-cli`, using `ggml-large-v3-turbo.bin` and automatic language detection. Output was only `¶¶`, an unusable non-speech result; there is **no usable narration**, and no words are inferred from that output.

The measured mono peak is −13.30 dBFS and RMS is −36.51 dBFS. Waveform and spectrum inspection show non-silent tonal bands and changing broad-band energy. This establishes a soundtrack, not isolated stems or a reliable inventory of individual sounds. The artifact lets the reviewer listen to the actual reference while the attempt remains silent. No claim of listening-based music/instrument identification is made.

## Reproduction and verification

Start from a copy of `templates/project`, overlay the example, then start `server.mjs`; see the sample README. Export through the app's `render` tool or the supplied standalone wrapper around `buildWhole` and `renderClip`. Source acquisition for a private comparison:

```sh
# Run outside the repository. Preserve the archive and extracted original.
curl -L --fail https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_480p_h264.mov.zip -o source.zip
unzip source.zip
ffmpeg -ss 3 -i big_buck_bunny_480p_h264.mov -t 7 -map 0:v:0 -map 0:a:0 -vf scale=854:480 -r 24 -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -ac 2 -movflags +faststart reference.mp4
ffmpeg -i reference.mp4 -ar 16000 -ac 1 audio.wav
whisper-cli -m ~/.cache/summarize/models/ggml-large-v3-turbo.bin -l auto -otxt -of transcript audio.wav
```

The app's final export completed with 168 frames, 854 × 480 px, 24 fps, 7.000 s and no audio. Representative frames at 0, 3 and 167/24 s were inspected in the actual render and the preview's assembled page. Preview/export pixel comparisons show the same geometry and timing; H.264/JPEG colour and edge loss remains. These comparisons measure preview/export agreement, not resemblance to the reference.

Seeking 0 → 3 → 6.958333 → 3 → 0 → 6.958333 s produced byte-identical endpoint PNGs. The repeated midpoint changed 91 of 409,920 pixels, at most 6/255 per channel, on SVG edges. Thus layout/timing replay is repeatable, but this CSS/SVG attempt does not promise pixel-identical captures for every seek order. No page errors or asset requests occurred in the assembled preview; all scene assets are inline.

The PR artifact records desktop/mobile delivery and control checks. Full product tests are unnecessary for this docs/example-only change. No production modules were edited.

## Proposed reference record for task 6 (not an implemented schema)

Evidence above suggests keeping these distinctions explicit:

```json
{
  "source": {"title":"Big Buck Bunny", "creator":"Blender Foundation", "url":"https://peach.blender.org/download/", "mediaFile":"big_buck_bunny_480p_h264.mov", "license":"CC-BY-3.0", "attribution":"(c) copyright 2008, Blender Foundation / www.bigbuckbunny.org"},
  "range": {"startSeconds":3, "endSeconds":10, "sourceFps":24, "sourceSize":[853,480]},
  "intent":"Study a downward environment reveal and layered depth cues",
  "observedAnalysis":"Continuous environment shot; warm sky, cool ridge, right-heavy tree mass; foreground reveals late; soundtrack present; no usable speech transcription",
  "selectedQualities":["composition", "palette/depth separation", "relative layer movement", "7-second reveal"],
  "constraints":["original vector geometry only", "single viewpoint", "no source assets in public repo", "attempt silent", "not a physical camera solve"],
  "attemptEvidence":{"technique":"inline SVG + scene-local CSS keyframes", "durationSeconds":7, "fps":24, "size":[854,480], "iterations":2},
  "gaps":["foliage/material detail", "volumetric light", "true 3D occlusion/parallax", "soundtrack", "minor SVG edge raster variation on seek"]
}
```

These are proposed fields, not task-6 requirements or a library API. A future record should also resolve the private excerpt location and evidence links separately from public reusable sample files. Keep the observation, the intended quality and the outcome distinct: a reference is not a promise that the renderer can reproduce it.
