# scene-loop

Make videos scene by scene with the AI chat you already use. Claude or ChatGPT sits on the left and
builds the video; scene-loop sits on the right in the chat app's built-in browser, where you pin
comments on the frame, compare versions, play the whole video and render it.

I built this for my own explainer and course videos. It's early and it changes a lot.

## Why

The shape is borrowed from Caleb Porzio's
[Storyboard teaser](https://x.com/calebporzio/status/2104945478055989489): script, then scenes,
then one scoped chat per scene with versions and whole-video playback. Scenes are HTML with CSS
animations. scene-loop renders them itself: headless Chrome steps every frame on a frozen clock
and ffmpeg makes the MP4. It started on [HyperFrames](https://github.com/heygen-com/hyperframes)
by HeyGen, which showed that HTML is a good way to make video.

I tried HyperFrames' own Studio first. It's a timeline editor where you nudge positions and text
sizes, and I don't want to edit video like that. I want to point at a frame, say what's wrong, and
get a new version back.

## What it does

- Projects that hold videos. A project has instructions for the chat in `project.md` (how names
  are pronounced, tone, brand) and tags; the overview shows every project and its videos.
- Filmstrip of scenes, a preview with This scene / Whole video, and an activity panel per scene.
- A Script view: every scene's script in one readable column, with timecodes.
- Pause, drag a box on the frame, write a comment. The chat picks open comments up with a still of
  each frame and the box drawn on it.
- Every change the chat saves becomes a new version with 5 stills. You can compare versions, flip
  between them at the same timestamp, or bring an old one back. The video is always every scene's
  latest version.
- A Render button for the MP4.

## Connect a chat

scene-loop is an MCP server. Claude Code connects to it with one line:

```
claude mcp add --transport http scene-loop http://localhost:4300/mcp
```

Claude Desktop takes it as a stdio bridge in
`~/Library/Application Support/Claude/claude_desktop_config.json`, then a restart of the app:

```json
{ "mcpServers": { "scene-loop": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:4300/mcp"] } } }
```

A custom connector in Desktop's settings won't reach `localhost`; those are called from
Anthropic's cloud. `docs/server-and-mcp.md` has the details.

Then Claude has the tools: list and create projects and videos, read and write the project
instructions, video settings, create, reorder and remove scenes, a theme and design spec for all
scenes, read and write a scene, stills, pending comments, render. `get_rules` returns the
project instructions first, so the chat sees how to say the names before it writes a script or
sends one to a voice service. Stills come back as images in the tool result, so Claude sees its own frames in
the chat. Comments you pin in the page come through `get_pending_comments` with a still of the
frame and the box drawn on it. Every write becomes a version that records the model and the
channel it came through (`mcp`, `webmcp` or `page-js`).

The same tools are also on the page itself, for the built-in browser of Claude Code desktop or the
ChatGPT/Codex desktop app: through WebMCP (ChatGPT's "Site tools" discover them on their own) and
as `window.sceneLoop` in the page's JavaScript. `window.sceneLoop.help()` lists them. The page adds
`show_scene`, which drives the player.

In a chat that supports MCP Apps (Claude Desktop, claude.ai), `show_scene`, `list_scenes` and
`get_pending_comments` also open a small review view inside the chat. It shows the stills,
versions and comments, and you can pin a comment on a frame there too.

Your comments wait in the page until you tell the chat to apply them (Copy prompt gives you the
words).

## Your own plan, no API key

The agent is the chat you already use, in the app you already pay for. scene-loop never calls a
model itself and holds no keys.

## Run it

Needs Node 22, ffmpeg and Chrome. No npm install. Best is chrome-headless-shell
(`npx @puppeteer/browsers install chrome-headless-shell@stable`), which scene-loop finds in
`~/.cache`; a normal Google Chrome or Chromium works too. `CHROME_PATH` picks a specific one, `CHROME_FLAGS` adds flags.
It listens on 127.0.0.1 only, with no login. Run it on your own machine, or your own server or
Docker if you want it elsewhere. Nobody hosts it for you.

```
mkdir ~/videos
node server.mjs ~/videos --reviewer YourName
claude mcp add --transport http scene-loop http://localhost:4300/mcp
open http://localhost:4300
```

`~/videos` is a projects root: one folder per project, created with `create_project` from the
chat or the New project button, and inside it one folder per video (`create_video`, or + New
video on the overview). Each video keeps its own versions, comments and renders. `/` shows the
overview when there is more than one video; `?project=x&video=y` opens one.

Older layouts still work without moving anything. Point the server at a folder that has a
`storyboard.json` and it serves that one video. A root whose folders each have a `storyboard.json`
serves each as a project with one video of the same name; a `project.md` next to the
`storyboard.json` gives it instructions.

On a server: `docker compose up -d` with the `Dockerfile` and `docker-compose.yml` here, or
`node server.mjs ~/videos --host 0.0.0.0` with `SCENE_LOOP_PASSWORD` set. Anything beyond
localhost needs that password: the web UI gets a login page, and `/mcp` takes a bearer token or
runs the OAuth flow a claude.ai custom connector expects. Put it behind TLS.
[docs/self-host.md](docs/self-host.md) has the image, the settings, and nginx, Caddy and
Cloudflare Tunnel.

## Project format

```
<project>/
  project.md           instructions for the chat (pronunciation, voice, tone, brand); the
                       frontmatter has title and tags. Edited from Instructions in the page.
  videos/<video>/      one video, laid out as below
```

A video:

```
storyboard.json        title, size, colours, soundtrack, and the scenes with start, duration,
                       transition and narration (the script; the key stays `narration`)
scenes/<id>/scene.html one scene: <template>, a <style>, a root div with
                       data-composition-id="<id>"; motion is CSS animations (or Web
                       Animations), timed in seconds from the scene start
assets/                images, fonts, audio, referenced as assets/...
frame.md               optional design spec the agents read
AGENTS.md              rules the chat reads through get_rules
theme.css              optional, applied after every scene's styles
```

The app keeps its own state next to that: versions in a private git dir (`.history`), comments,
chats and a metrics log in `.state`, builds and render clips in `.build`, renders in `renders`.
A project folder has a `.history` of its own for `project.md`.

## Narration

Narration stays as one audio file per scene in `assets/narration/<scene-id>.mp3`, `.wav` or
`.m4a`. Agree the script first, then use `set_narration_audio` for each scene,
`fit_scenes_to_narration` to put every duration on the frame grid, and `build_soundtrack` to make
`assets/narration.m4a` and select it as the video's soundtrack. `remove_narration_audio` removes a
scene's audio when it needs a new take.

Word anchors keep scene motion attached to the narration when a take changes. Use
`set_narration_words` with timed words, raw ElevenLabs Scribe JSON or raw whisper-cli JSON; it
writes `assets/narration/<scene-id>.words.json` and aligns transcript times to the scene's script.
Then `data-at="word:brush"`, `word:brush#2`, `sentence:2`, offsets such as `word:brush+0.3`, and
alternatives such as `word:noon|sentence:6+0.4` replace authored CSS animation delays when the
word is available. Space-separated anchors apply to successive animations. Code using
`el.animate()` can call `window.__at["<scene-id>"](spec, fallback)`. The authored delay remains the
fallback, so scenes still play without word timings. Run `fit_scenes_to_narration` again when a new
take changes audio length, then rebuild the soundtrack.

How a scene moves: every `@keyframes` animation, `el.animate()` and `<video>` in the page is paused
and set to the frame's time by the page clock (`lib/clock.js`), the same in the preview, the stills
and the render. So a scene must not run on wall time (`setTimeout`, `requestAnimationFrame` loops,
`Date.now()`, CSS transitions). Something drawn in script registers `window.__seek["<id>"] = (t) => ...`.
Prefix ids and `@keyframes` names with the scene id; all scenes share one page.

Scenes from before (a paused GSAP timeline in `window.__timelines["<id>"]`) keep playing: the page
loads GSAP from jsDelivr for them and the clock seeks the timeline. Rewriting one is mechanical,
each `tl.fromTo(el, from, to, at)` becomes an animation with `animation-delay: <at>s` and
`fill-mode: both`:

```css
/* tl.fromTo("#s03-chip", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.55, ease: "power3.out" }, 0.37) */
#s03-chip { animation: s03-pop 0.55s cubic-bezier(0.165, 0.84, 0.44, 1) 0.37s both; }
@keyframes s03-pop { from { opacity: 0; transform: translateY(24px); } }
```

The template's `AGENTS.md` has the ease table; ask the chat to "rewrite this scene's GSAP timeline
as CSS animations" and compare the stills.

Rendering: each scene renders to its own clip, `.build/clips/<id>-v<version>-<key>.mp4`, frames
split over parallel Chrome pages (`SCENE_LOOP_PARALLEL`, default up to 8). A clip is reused until
the scene, the theme, the size, a file in `assets/` or its place on the frame grid changes, so after
one edit only that scene renders again (an asset change renders every scene again, except narration
audio, which is mixed when clips are joined). The whole video is the clips joined with ffmpeg crossfades (`transitionIn:
{ "duration": 0.6 }` by default, `{ "type": "cut" }` for a hard cut) and the soundtrack.

## Clips from a screen recording

Screen-recording clips live in `assets/clips/`. Use `probe_media` to inspect a take, `cut_clip` to
cut a source range for one scene, and `list_clips` to see durations and scene references. `cut_clip`
can `hold` the final frame to fill the scene, `speed` a longer range uniformly (never slowing it
down), or `trim` at the scene duration without padding a shorter range. The recorder that creates
the take and any timestamp marks lives outside scene-loop; these tools start from its media file.

The server is `server.mjs`; the tools are defined once in `lib/tools.mjs` and served on `/mcp`
(Streamable HTTP, stateless, no SDK) and to the page. `docs/server-and-mcp.md` has the plan and
the client notes.

Scene ids must start with a letter: they become CSS ids and animation names.

## License

Free for personal use and other noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). That also covers charities, schools and
public institutions. Using it in or for a company needs a commercial license. Write to
kristian@primux.dk.

Third-party code and the required notice are in [NOTICE.md](NOTICE.md).

I'm not taking pull requests yet. Issues are welcome.
