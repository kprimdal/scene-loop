# Meadow reference study (approximation)

An original 7-second layered SVG/CSS scene. It approximates selected composition and motion qualities from Big Buck Bunny's opening environment shot. It does not reproduce its assets, foliage, lighting, sound or true camera geometry. No external assets, fonts, scripts or packages are required.

From the scene-loop repository root, start with a **new scratch copy** of the template, then overlay the sample before starting the server:

```sh
cp -R templates/project /tmp/sl-reference-study
cp -R examples/reference-study/. /tmp/sl-reference-study/
node server.mjs /tmp/sl-reference-study --port 4301
```

Use another scratch path if that directory already exists. Open the local app, seek the scene and choose **Render mp4**. `list_projects` should show `instructions: true`. On a root Linux host, prefix Node commands with `CHROME_FLAGS=--no-sandbox` as required by that host.

For a reproducible standalone export through the same assembler, frozen clock and Chrome/ffmpeg renderer:

```sh
node examples/reference-study/render.mjs /tmp/sl-reference-study /tmp/reference-attempt.mp4
ffprobe -v error -show_entries stream=width,height,r_frame_rate,nb_frames -show_entries format=duration /tmp/reference-attempt.mp4
```

Expected: 854 × 480 px, 24 fps, 168 frames, 7.000 seconds, no audio stream. The final encoded frame is at 6.958333 seconds. All motion uses scene-local CSS keyframes; no wall-time transitions or loops.

The inline geometry is original. The reference media is deliberately absent. [Experiment evidence and source attribution](../../docs/experiments/reference-to-scene.md) describe the selected qualities and observed limits. This is a specific experiment, not an arbitrary-video reconstruction tool.
