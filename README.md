# scene-loop

Make videos scene by scene with the AI chat you already use. Claude or ChatGPT sits on the left and
builds the video; scene-loop sits on the right in the chat app's built-in browser, where you read
and agree the script, pin comments on the frame, compare versions, play the whole video and render
it.

I built this for my own explainer and course videos. It's early and it changes a lot.

## How a video gets made

The order matters, because the narration sets every scene's length and paid voices cost money per
take.

1. **Script.** The chat writes one block of narration per scene (`create_scene`, `update_scene`).
   You read it in the Script view, edit lines in place, and press **Script agreed**. Until then
   `get_rules` and `list_scenes` tell the chat "Script not agreed: do not send narration to a paid
   voice service yet", and any later change to a line turns that into "changed since". The chat
   cannot agree the script; only you can.
2. **Narration.** The chat renders one audio file per scene with whatever voice service it has
   (scene-loop holds no keys) and stores it with `set_narration_audio`. `set_narration_words` adds
   word timings from the same take (raw ElevenLabs Scribe or whisper-cli output, aligned to the
   script). `fit_scenes_to_narration` sets each scene's duration to lead + audio + tail on the
   frame grid. `build_soundtrack` lays the blocks into one `assets/narration.m4a` and selects it.
3. **Scenes.** HTML, with motion anchored to words (`data-at="word:brush"`) rather than seconds,
   so a new take re-times a scene without touching it. Screen recordings are cut to scene length
   with `cut_clip`.
4. **Review.** Pause, drag a box on the frame, write a comment. The chat picks the comments up with
   a still of each frame, writes a new version, and you compare.
5. **Render.** One click; only the scenes that changed render again.

## What it does

- Projects that hold videos. A project has instructions for the chat in `project.md` (how names
  are pronounced and where they may sit in a sentence, voice, tone, brand) and tags; the overview
  shows every project and its videos.
- A Script view: every scene's narration in one column, editable in place, with word and
  character counts, the estimated spoken length against the scene durations, each scene's audio
  length and whether its words are timed, and the Script agreed button.
- Filmstrip of scenes, a preview with This scene / Whole video, a timecode readout, frame stepping
  with the arrow keys, and an activity panel per scene with a player for the scene's narration.
- Pause, drag a box on the frame, write a comment. The chat gets the comment with a still and the
  box drawn on it (`get_pending_comments`) and marks it resolved when it writes the fix.
- Every change the chat saves becomes a new version with 5 stills. You can compare versions, flip
  between them at the same timestamp, or bring an old one back. The video is always every scene's
  latest version.
- A Render button for the MP4, and the list of renders.

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

The tools, all defined once in `lib/tools.mjs`:

| | |
| --- | --- |
| Projects | `list_projects`, `create_project`, `create_video`, `get_project_instructions`, `set_project_instructions` |
| Start here | `get_rules`: the project instructions, the video's agent rules, design spec, theme and the scene contract, with the script status first |
| Scenes | `list_scenes`, `create_scene`, `update_scene`, `reorder_scenes`, `remove_scene`, `get_scene_html`, `write_scene_html`, `get_stills`, `show_scene`, `restore_version` |
| Review | `get_pending_comments`, `add_comment` |
| Narration | `set_narration_audio`, `remove_narration_audio`, `set_narration_words`, `remove_narration_words`, `fit_scenes_to_narration`, `build_soundtrack` |
| Clips | `probe_media`, `cut_clip`, `list_clips` |
| Video | `get_video_files`, `set_video`, `set_theme_css`, `set_design_spec`, `render`, `get_render` |

Stills come back as images in the tool result, so Claude sees its own frames in the chat. Every
write becomes a version that records the model and the channel it came through (`mcp`, `webmcp`
or `page-js`).

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
model or a voice service itself and holds no keys.

## Run it

Needs Node 22, ffmpeg and Chrome. No npm install. Best is chrome-headless-shell
(`npx @puppeteer/browsers install chrome-headless-shell@stable`), which scene-loop finds in
`~/.cache`; a normal Google Chrome or Chromium works too. `CHROME_PATH` picks a specific one,
`CHROME_FLAGS` adds flags (`--no-sandbox` when it runs as root). It listens on 127.0.0.1 only,
with no login. Run it on your own machine, or your own server or Docker if you want it elsewhere.
Nobody hosts it for you.

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
serves each as a project with one video of the same name. In both, a `project.md` next to the
`storyboard.json` gives it instructions; without one the chat has no pronunciation rules.

On a server: `docker compose up -d` with the `Dockerfile` and `docker-compose.yml` here, or
`node server.mjs ~/videos --host 0.0.0.0` with `SCENE_LOOP_PASSWORD` set. Anything beyond
localhost needs that password: the web UI gets a login page, and `/mcp` takes a bearer token or
runs the OAuth flow a claude.ai custom connector expects. On a private network (a tailnet) you
can run `--no-login` and still set `SCENE_LOOP_TOKEN`: the page stays open and `/mcp` wants the
token. Put it behind TLS. [docs/self-host.md](docs/self-host.md) has the image, the settings, and
nginx, Caddy and Cloudflare Tunnel.

## Project format

```
<project>/
  project.md           instructions for the chat (pronunciation, voice, tone, brand); the
                       frontmatter has title and tags. Edited from Instructions in the page.
  videos/<video>/      one video, laid out as below
```

A video:

```
storyboard.json        title, size, colours, soundtrack, the script agreement (who, when, a hash
                       of every narration line), and the scenes with start, duration, transition,
                       narration (the script) and narrationLead
scenes/<id>/scene.html one scene: <template>, a <style>, a root div with
                       data-composition-id="<id>"; motion is CSS animations (or Web
                       Animations), anchored to words or timed in seconds from the scene start
assets/narration/      <id>.mp3|wav|m4a, one take per scene, and <id>.words.json with its
                       word timings
assets/narration.m4a   the soundtrack build_soundtrack makes from them
assets/clips/          <id>.mp4, screen-recording clips cut to scene length
assets/                anything else a scene references as assets/...
frame.md               optional design spec the agents read
AGENTS.md              the scene contract the chat reads through get_rules
theme.css              optional, applied after every scene's styles
```

The app keeps its own state next to that: versions in a private git dir (`.history`), comments,
chats and a metrics log in `.state`, builds and render clips in `.build`, renders in `renders`.
A project folder has a `.history` of its own for `project.md`. Audio and clips are not versioned;
the chat log records when they changed.

## Narration

One audio file per scene, named after the scene id, so a changed line re-renders one block. The
chat makes the audio; scene-loop stores it (`set_narration_audio` takes an absolute path or
base64), measures it, and warns when the script is not agreed yet.

`fit_scenes_to_narration` sets each scene with audio to lead (0.35 s of picture before the first
word) + audio + tail (0.6 s), rounded up to the frame grid; scenes without audio keep their
duration. `build_soundtrack` puts every block `lead` seconds into its scene, pads with silence,
joins, normalises to -16 LUFS and writes `assets/narration.m4a`. A block longer than its scene is
reported as an overrun; fit again. The lead is stored per scene as `narrationLead`, because the
word anchors need it.

Word timings: `set_narration_words` takes the raw ElevenLabs Scribe JSON or whisper-cli JSON
(`-dtw <model> -nfa -ojf`; Scribe is the better source, its word starts sit 20 to 60 ms after the
onset while whisper runs 3 to 9 frames late) or a plain `[{word, start, end}]` list, aligns the
words and punctuation to the scene's script, and writes `assets/narration/<id>.words.json`.

## Scenes

**Word anchors.** `data-at="word:brush"` starts the element's CSS animation on the first "brush"
of the narration; `word:brush#2` the second one; `sentence:2` the start of sentence 2;
`word:brush+0.3` and `sentence:2-0.2` add an offset; `word:noon|sentence:6+0.4` tries alternatives
left to right. Several animations on one element take one anchor each, space-separated, and
animations past the last anchor keep their spacing to it. Code using `el.animate()` asks
`window.__at["<scene id>"]("word:brush", fallback)` for the time. A word that was not heard falls
back to a one-letter fuzzy match, then the alternatives, then the authored `animation-delay`, each
with a `console.warn`; without a `words.json` the scene plays exactly as written. The resolver
(`lib/anchors.js`, 55 lines) is inlined into every build, so the preview, the stills and the render
agree. In video-lab a voice swap re-timed a scene with the HTML byte-identical, 12 of 12 anchors
within a frame.

**The clock.** Every `@keyframes` animation, `el.animate()` and `<video>` in the page is paused
and set to the frame's time by the page clock (`lib/clock.js`), the same in the preview, the stills
and the render. So a scene must not run on wall time (`setTimeout`, `requestAnimationFrame` loops,
`Date.now()`, CSS transitions). Something drawn in script registers
`window.__seek["<id>"] = (t) => ...`. Prefix ids and `@keyframes` names with the scene id; all
scenes share one page. Scene ids must start with a letter: they become CSS ids and animation names.

**Old GSAP scenes** (a paused GSAP timeline in `window.__timelines["<id>"]`) keep playing: the page
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

## Clips from a screen recording

The recorder that makes the take (and its timestamp marks per step) lives outside scene-loop.
From its file: `probe_media` reads length, size, fps and whether there is audio; `cut_clip`
cuts a source range for one scene into `assets/clips/<id>.mp4`, muted, scaled and padded to the
video size, and fitted to the scene's duration: `hold` keeps 1x and holds the last frame,
`speed` retimes a longer range uniformly (never slower than 1x), `trim` cuts at the duration
without padding. The result tells the chat which `<video>` tag the scene needs. `list_clips`
shows every clip, its length and the scenes that reference it, and `list_scenes` reports clips a
scene references that are missing on disk.

## Rendering

Each scene renders to its own clip, `.build/clips/<id>-v<version>-<key>.mp4`, frames split over
parallel Chrome pages (`SCENE_LOOP_PARALLEL`, default up to 8). A clip is reused until the scene,
the theme, the size, its words or lead, a file in `assets/` (narration audio excepted: it is mixed
when the clips are joined) or its place on the frame grid changes, so after one edit only that
scene renders again. The whole video is the clips joined with ffmpeg crossfades (`transitionIn:
{ "duration": 0.6 }` by default, `{ "type": "cut" }` for a hard cut) and the soundtrack. A 55 s
video renders in about 25 s on a Mac, and in about 13 s when one scene changed.

The server is `server.mjs`; the tools are served on `/mcp` (Streamable HTTP, stateless, no SDK)
and to the page. `docs/server-and-mcp.md` has the plan and the client notes.

## License

Free for personal use and other noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). That also covers charities, schools and
public institutions. Using it in or for a company needs a commercial license. Write to
kristian@primux.dk.

Third-party code and the required notice are in [NOTICE.md](NOTICE.md).

I'm not taking pull requests yet. Issues are welcome.
