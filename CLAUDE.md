# scene-loop: agent setup

Read `README.md` first. Kristian's own video tool, built in the open.

## Rules

- **Public repo.** No client material ever: no scripts, footage, images, brand assets or names from
  client work (Vikan, AP3 clients, anyone). Client video projects live outside this repo and are
  passed in as `node server.mjs <projectDir>`.
- **License:** PolyForm Noncommercial 1.0.0 for our code. Dependencies must be MIT or equally
  permissive (BSD, ISC). Apache-2.0 only with Kristian's OK. No GPL linked in; ffmpeg and Chrome run
  as separate programs. Note any new third-party code in `NOTICE.md`.
- **No npm install today.** Plain Node 22 ESM, no build step. Adding a dependency is a decision.
- **The agent is the chat next to the page** (Claude Code desktop or the ChatGPT desktop app's
  built-in browser) through the page tools in `public/app.js` (WebMCP + `window.sceneLoop`). The
  server never calls a model and holds no keys.
- **Direction:** HTML scenes with CSS/WAAPI motion, rendered by our own renderer (`lib/chrome.mjs`,
  `lib/clock.js`, `lib/render.mjs`: Chrome over CDP, frozen clock, ffmpeg, per-scene clip cache).
  HyperFrames is gone; old GSAP scenes still play through the clock. Python is for synthesized sound
  and maybe intros/outros, not scenes.

## Working

- Run against a scratch copy of `templates/project`, never against a real project, when testing:
  `cp -R templates/project /tmp/sl-test && node server.mjs /tmp/sl-test --port 4301`.
- Check the page with agent-browser in its own session; `agent-browser webmcp list` shows the tools.
- Lab notes and measurements go to video-lab (`~/Websites/Primux/video-lab`), one experiment per
  folder with a `findings.md`.
- Don't push without Kristian's go.

## Producing a video

- **Narration is rendered last, once.** Paid text-to-speech (ElevenLabs) only runs after Kristian
  has approved the script word for word. Until then, preview with a free local voice (`say` on
  the Mac, `piper` if installed), or one short paid sample when the choice of voice itself is the
  question. Rule set 2026-10-02 after a demo narration was rendered twice because the script
  changed after the first render.
- Script first, then screen recording, then assembly. The narration length sets each scene's
  duration, so a changed script means re-timing every scene after it.
- Keep per-scene narration as separate audio files named after the scene id, so a change to one
  block re-renders one block.
