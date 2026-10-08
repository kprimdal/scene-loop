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
  built-in browser) through the page tools in `public/js/tools.js` (WebMCP + `window.sceneLoop`). The
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
- **main deploys itself.** A commit on `main` in Kristian's clone is pushed by a post-commit hook,
  and agent-server pulls origin/main every 5 minutes and restarts the service at
  scene-loop.dev.primux.app (`/usr/local/bin/scene-loop-deploy`, log in
  `/var/log/scene-loop-deploy.log`). So a commit on main is a deploy: work in progress goes on a
  branch, and main gets what has been tested. Service settings live in `/etc/default/scene-loop`
  and the unit file (`--no-login`, `CHROME_FLAGS=--no-sandbox` because it runs as root).
- **Branch work on agent-server goes in a worktree** (`git worktree add /srv/work/scene-loop-<name>
  -b <name> main`), never in `/srv/work/scene-loop` itself: the deploy cron hard-resets that
  checkout to origin/main (it skips when the checkout is not on main, but do not rely on it).
- A project folder gets a `project.md` next to `storyboard.json` (or at the project root in the
  `videos/` layout). Without it the chat has no pronunciation or voice rules, and `instructions`
  shows false in `list_projects`.

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
- **Before production starts, check that the tool is current where the work happens.**
  `git -C /srv/work/scene-loop log -1` must match the Mac's main, the service must answer, and
  the project must show `instructions: true`. On 2026-10-02 the server ran the previous day's
  HyperFrames build for five hours because main had not been pushed; the script, the narration
  and the first cut all happened outside the tool as a result.
- The script is read in the tool, not in chat. Put the narration into the scenes first, open
  the Script view, and let Kristian read and edit it there. The tool keeps no agreed/not agreed
  state (removed 2026-10-08); his word in chat is the go for paid voice. Comments on scenes
  are the review; exported cuts opened as artifact pages are not.
- Run one dry take of a screen recording before the real one: the brief's failure modes (the
  wrong tool answering, a connector pulling in material, a 15-minute wait) show up on the first
  run, not in the plan.
- Diff every TTS take against the script (ElevenLabs Scribe or whisper) before it goes in. In
  video-lab 001, three of four takes slipped a word or a name.
- Sound, from video-lab 001: SFX about 11 dB under the speak, music 15 to 16 dB under, pauses in
  the speak at most 0.9 s, a scene starts 0.35 s before its first word.
- A free Danish draft voice is still open: `say` and piper have no usable Danish. Candidates from
  the lab's landscape research are Røst-v3-chatterbox, Chatterbox Multilingual and VoxCPM2; all
  need forced alignment for word timing. The lab's #1 open experiment is word anchors instead of
  absolute seconds, so a voice swap does not re-time every scene.
