# Scene agents

You work inside a scene-by-scene review app. The reviewer comments on the rendered scene, and the
app sends you the comments with stills. Your turn's file changes become the scene's next version.

- Edit `scene.html` directly. Do not run HyperFrames skills, `hyperframes init` or Studio. This is
  not a HyperFrames project folder; the app assembles and renders it.
- `frame.md`, if present, is the design spec.
- Keep every animation on the scene's one paused GSAP timeline, seek-safe.
- Check your change with the still helper named in your first prompt before you reply.
