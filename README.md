# scene-loop

Make videos scene by scene with the AI chat you already use. Claude or ChatGPT sits on the left and
builds the video; scene-loop sits on the right in the chat app's built-in browser, where you read
and edit the script, pin comments on the frame, compare versions, play the whole video and render
it.

I built this for my own explainer and course videos. It's early and it changes a lot.

## How a video gets made

The order matters, because the narration sets every scene's length and paid voices cost money per
take.

1. **Script.** The chat writes one block of narration per scene (`create_scene`, `update_scene`).
   You read it in the Script view and edit lines in place until it is right. Narration comes
   after that, because a changed line means a new take and new timing for every scene after it.
2. **Narration.** Either you read it to camera in the Record view (below), or the chat renders
   one audio file per scene with whatever voice service it has (scene-loop holds no keys) and
   stores it with `set_narration_audio`. `set_narration_words` adds
   word timings from the same take (raw ElevenLabs Scribe or whisper-cli output, aligned to the
   script). When you read it yourself, the script does not have to be final: record, then the
   script follows what you said, and you fix lines and record only those again. `fit_scenes_to_narration` sets each scene's duration to lead + audio + tail on the
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
  length and whether its words are timed.
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
| Scenes | `list_scenes`, `create_scene`, `update_scene`, `reorder_scenes`, `remove_scene`, `get_scene_html`, `write_scene_html`, `set_scene_text`, `get_stills`, `show_scene`, `restore_version` |
| Review | `get_pending_comments`, `add_comment` |
| Narration | `set_narration_audio`, `remove_narration_audio`, `set_narration_words`, `remove_narration_words`, `fit_scenes_to_narration`, `build_soundtrack` |
| Takes | `list_takes`, `choose_take`, `keep_take`, `add_take` |
| Clips | `probe_media`, `cut_clip`, `list_clips` |
| Video | `get_video_files`, `set_video`, `set_theme_css`, `set_design_spec`, `render`, `get_render`, `delete_renders` |
| Library | `list_styles`, `inspect_style`, `apply_style`, `remove_style`, `list_library`, `add_to_library`, `update_library_item`, `remove_from_library`, `use_library_music` |

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
video on the project's page). Each video keeps its own versions, comments and renders. `/` shows a
card per project, `?project=x` lists that project's videos, and `?project=x&video=y` opens one.
With only one project, `/` goes straight to its page, or to its video if it has just one.

Older layouts still work without moving anything. Point the server at a folder that has a
`storyboard.json` and it serves that one video. A root whose folders each have a `storyboard.json`
serves each as a project with one video of the same name. In both, a `project.md` next to the
`storyboard.json` gives it instructions; without one the chat has no pronunciation rules.

On a server: `docker compose up -d` with the `Dockerfile` and `docker-compose.yml` here, or
`node server.mjs ~/videos --host 0.0.0.0`, then `node server.mjs ~/videos --invite-owner
you@example.com You` for the first owner's invite link. Anything beyond localhost needs a login:
people log in with their own email and password, owners with an authenticator code too, and
`/mcp` takes an owner's token or runs the OAuth flow a claude.ai custom connector expects. On the
People page an owner adds someone to one or more projects as a commenter (watch, read the
script, comment under their own name) and sends them the invite link, or removes them again. On
a private network (a tailnet) you can run `--no-login` and set `SCENE_LOOP_TOKEN`: the page
stays open and `/mcp` wants the token. Put it behind TLS. [docs/self-host.md](docs/self-host.md)
has the image, the settings, and nginx, Caddy and Cloudflare Tunnel.

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
                       transition, narration (the script) and narrationLead
scenes/<id>/scene.html one scene: <template>, a <style>, a root div with
                       data-composition-id="<id>"; motion is CSS animations (or Web
                       Animations), anchored to words or timed in seconds from the scene start
assets/narration/      <id>.mp3|wav|m4a, one take per scene, and <id>.words.json with its
                       word timings
assets/narration.m4a   the soundtrack build_soundtrack makes from them
assets/clips/          <id>.mp4, screen-recording clips cut to scene length
assets/takes/<id>/     <n>.mp4|webm, every take read to camera, and takes.json
assets/cam/            <id>.mp4, the chosen take's camera clip, t=0 = the scene's t=0
assets/sfx/            <name>.wav, sound effects that add to or replace the kit
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
base64) and measures it.

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

## Reading the narration to camera

Record (next to Script) turns the page into a teleprompter. Under the lens (the default) shows
one sentence at a time in a narrow column right under the camera, the next one dim below it, so
your eyes stay near the lens instead of travelling along full-width lines. The column's width and
whether the camera sits left, centre or right are remembered. It moves to the next sentence when
you pause after speaking (the mic under the room's pause threshold for 350 ms, once half the
sentence's spoken length has passed); ↓ or PageDown (a presenter clicker) moves on by hand, ↑ or
PageUp back. Full text shows the whole block at the top of the screen with an optional slow
scroll. A−/A+ set the size for each. Below it the scene, "3 / 12", the takes, a small mirrored
camera preview and a mic meter, and pickers for camera and microphone (remembered). It asks for
1920x1080 at 30 fps, and turns the browser's echo cancellation, noise suppression and gain
control off, because scene-loop cleans the audio itself.

Space counts 3-2-1 and records; Space again stops and saves the take. R records again, Enter
uses the latest take and moves to the next scene, ← → change scene, P plays the take, Esc
closes. Every take is kept under `assets/takes/<scene>/`; the one in use is "used", with the
camera and microphone it was recorded with. A take whose loudest sample is under -24 dBFS gets a
warning under the meter: move the mic closer or raise its input level.

Using a take (Enter, the Use button, or `choose_take`) finds the speech in it, cuts it out with
a little air on both sides (highpass 80 Hz, a gentle denoise, no loudness change: the soundtrack
does that) and stores it as the scene's narration audio, exactly as `set_narration_audio` would,
so a script change after the take shows as stale. It also cuts `assets/cam/<scene>.mp4`: muted,
at the video's size, constant frame rate, starting `narrationLead` before the first word, so its
t=0 is the scene's t=0 and a plain `<video src="assets/cam/<scene>.mp4">` lines up with the
soundtrack. When `fit_scenes_to_narration` or `build_soundtrack` changes a scene's length or
lead, its cam clip is cut again from the take.

Speech is found on the same 20 ms RMS levels the threshold comes from (a third of the way from
the room's floor to the voice); ffmpeg's silencedetect compares sample peaks, and in a real room
the noise peaks over an RMS threshold, so a whole take came back as speech.

### Record first, fix the script after

You do not have to read word for word, and the script does not have to be final. After a
session, ask the chat to time the words: it calls `list_takes`, sends each chosen take's
narration audio to ElevenLabs Scribe itself and passes the result to `set_narration_words`. For
a recorded take that adopts what you said: the scene's narration becomes the take's words, with
the script's spelling and punctuation wherever the words match and numbers as the script wrote
them ("40" said as "fyrre"). The line as written is kept (`narrationWritten`), and the Script
view shows the spoken line with the changed words marked, so you can proofread names; Checked
hides the difference. Every word in `words.json` then has the time it was heard.

The same step cuts what the take should not say: a restart ("Men er... Men har den læst", or a
sentence said twice: the later one stays) and filler sounds ("øh" in the transcript, or a voiced
hum no word covers; whisper drops them). A take's narration becomes several ranges of it,
joined with a 40 ms crossfade, and the camera clip makes the same cuts as jump cuts; the words
are re-timed to the cut audio. Cuts at the start or end of the speech always happen. A cut in
the middle only happens where the scene does not show the camera clip at that moment (checked
in the scene page, picture-in-picture counts as showing); otherwise the scene gets a comment by
scene-loop at that time and a reason to record it again. `choose_take` with `keep` sets the
ranges by hand; `list_takes` shows them, what was cut and what was flagged.

Then edit lines freely. A changed line never blocks anything: the old take stays in the video
until you record that scene again. The Script view marks it "Record again" and counts the scenes
at the top; the Record view lists them with their reasons (N goes to the next one) and edits
the current line in place (E, then Enter or Esc saves). A small fix you do not want to record
again, like a misheard name, is "Keep the take" (K, or `keep_take`): the take counts as current
and its words take the new spelling. It also accepts a filler that was flagged on camera.

After a change the chat checks `anchorWarnings` and `sfxWarnings` (in the `set_narration_words`
result and `list_scenes`), re-anchors what a rephrased line lost, runs `fit_scenes_to_narration`
for the scenes whose audio changed and `build_soundtrack`, then looks at the stills. Scenes whose
audio did not change keep their duration, camera clip and render clip, even when they move in
time.

Each take and choice lands in `.state/metrics.jsonl` (`take`, `take-chosen`), so a session's
takes per scene and the time it took can be read back.

The scene places the camera and moves it with CSS on words: full frame, a corner box, a split,
or hidden. A scene can be written before the recording; the box stays empty until the clip
exists.

## Sound effects

Any element can carry cues: `data-sfx="pop@word:fyrre whoosh@sentence:2-0.2 tick@1.25"`. Each
is `name@spec[:gainDb]`, the spec a word anchor as in `data-at` or plain seconds, resolved
against the scene's words and lead with the same fallbacks (down to the element's CSS animation
delay). `build_soundtrack` mixes them in at their video time, 11 dB under the voice (the level
from video-lab 001) plus the cue's gain, and `list_scenes` lists every cue with its time and any
warning. A video without narration but with cues still gets a soundtrack. `storyboard.music`
(`set_video`) adds a bed under the voice with a 1 s fade in and a 2 s fade out; `musicDb` on `set_video` says how far under (default 15.5 dB, 20 to 25 for a quiet bed).

Music beds live in a library shared by every project (`<root>/library/music/`, one
`<id>.json` with the metadata next to each file: title, source, the generating model, the prompt,
date, rights, loop, bpm, tags, a note). Library in the header lists them with a player and the
videos that use each, and + Add file uploads one. `use_library_music`, or Use in a video's Music
menu, copies the file into the video's `assets/music/` and sets it as `storyboard.music` with the
library id next to it, so the video keeps its own copy and a later library change never changes a
render. Look in the library before generating a new bed.

The kit in `sfx/` is our own, synthesized by `sfx/make_kit.py` (numpy) and calibrated so each
sound's loudest 400 ms sits at -27 LUFS: whoosh, whoosh-long, swoosh, pop, pop-low, pop-high,
tick, click, typing, ding, error, riser, thud, paper, glitch. `assets/sfx/<name>.wav` in a video
adds a sound or replaces one, measured and brought to the kit's level.

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
parallel Chrome pages (`SCENE_LOOP_PARALLEL`, default half the cores, 2 to 8). A clip is reused
until the scene, the theme, the size, its words or lead, an asset file the scene or the theme
refers to, or its place on the frame grid changes, so after one edit only that scene renders
again, and a replaced webcam clip re-renders the scenes that use it. The whole video is the clips
joined with ffmpeg crossfades (`transitionIn: { "duration": 0.6 }` by default, `{ "type": "cut" }`
for a hard cut) and the soundtrack. A 55 s video renders in about 25 s on a Mac, and in about
13 s when one scene changed.

Stretches of a scene in which nothing but `<video>` elements move (a slide with a webcam box
between two fades) are not screenshotted frame by frame: the stretch is captured once with the
videos blacked out, plus one mask per video, and ffmpeg lays the video frames in
(`lib/composite.mjs`). A 2-minute, 3-scene slides-and-webcam video went from 85 s to 20 s on a
Mac. Scenes with a GSAP timeline, a `window.__seek` drawing function, an animation without an
end, or a video under a CSS filter, blend mode, transform or `object-position` render frame by
frame as before; `SCENE_LOOP_COMPOSITE=0` turns the shortcut off. A page load that times out is
retried once with twice the time (`SCENE_LOOP_LOAD_TIMEOUT`, default 60 s, doubled for pages
with video), and a failed chunk fails the render job (`get_render` carries the error) instead of
the server.

`npm test` runs the checks in `test/` (plain `node --test`, which finds them; the Chrome and ffmpeg ones skip or
fail loudly when those are missing).

A faster computer can take the work. Run `worker.mjs` on it and list it in `SCENE_LOOP_WORKERS` on
the server; a render that finds it awake sends it every scene whose fonts come from files, and
renders everything itself when it does not answer. `docs/render-worker.md`
has the setup.

The server is `server.mjs`; the tools are served on `/mcp` (Streamable HTTP, stateless, no SDK)
and to the page. `docs/server-and-mcp.md` has the plan and the client notes.

## License

Free for personal use and other noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). That also covers charities, schools and
public institutions. Using it in or for a company needs a commercial license. Write to
kristian@primux.dk.

Third-party code and the required notice are in [NOTICE.md](NOTICE.md).

I'm not taking pull requests yet. Issues are welcome.

## Visual styles in the Library

Library contains moving examples of three original treatments: Signal, Paper and Grove, alongside
its Music tab. Open Library from a video to keep its selected scene as the default target. Choose
another video or **Entire video** to apply to all its current scenes. Application never inserts the
example's content: it keeps authored HTML, motion, narration, scene timing and music.

`list_styles` and `inspect_style` expose the catalog to the chat; `apply_style` and `remove_style`
use the same controls as the page. `get_rules`, `list_scenes` and `get_scene_html` include selected
styles. Project instructions remain first in `get_rules` and take priority over style guidance.

Each scene stores a full copy of its style (version, SHA-256 content hash, CSS and guidance) in a
marked block in `scene.html`. Later catalog edits cannot change that scene. Normal HTML tool edits
retain its pin; use the style tools to change or remove it. Applying and removing save normal scene
versions, so Compare and Restore work as before. Restore also restores that version's authored
content; remove the style instead to keep subsequent content edits. Entire video means the scenes
present when applied; scenes created later are independent.

Treatments set the root background, ink and type family. Existing explicit child colours stay
as authored. To use the palette on authored elements, add `data-sl-heading`, `data-sl-muted`,
`data-sl-accent`, `data-sl-surface` or `data-sl-fill`. Inspect the actual scene for contrast after
applying. Project `theme.css` remains loaded after scene styles, but pinned styles can override
its palette and type. The examples use the same assembly,
CSS and frozen clock as exports; their content and motion are examples, not a new scene pattern.
The starter styles use local font fallbacks, reported by the existing system-font checks. For
portable typography, package fonts in the project and adjust its theme.

## Text on screen

Open **Text on screen** in a scene's activity panel. Add up to four text items, choose Centre
title, Top heading or Lower third, and White · shadow, Dark card or Light card. Each item accepts
240 characters on up to four lines, including Danish text. The player previews drafts as you type;
**Preview start** seeks to the item's first instant. **Save text** keeps the list as an ordinary
scene version. **Cancel** discards the draft. Remove an item and save to remove it from the video.

Times are seconds within the scene: visible at start, hidden at end (`0 ≤ start < end ≤ duration`).
Shortening a scene past an item's end is rejected: adjust or remove the text first, then shorten.
Text uses the scene's type family with responsive sizes and fixed neutral treatments. Overlapping
items keep their list order; the later item appears above earlier ones. Use different times or
placements when they overlap. Inspect the preview for contrast with your footage.

Agents read `texts` in `list_scenes` or `get_scene_html`, then call `set_scene_text` with `scene`,
`items` and `model`. Each item has a unique `text-…` id, `text`, `position` (`title`, `heading`,
`lower`), `style` (`plain`, `dark`, `light`), `start` and `end`. The call replaces the list; `[]`
removes all items. Optional `baseVersion` rejects a stale edit. The tool returns the saved list,
scene duration and version. It is available through MCP, WebMCP and `window.sceneLoop`.

Text is plain content, stored with its generated CSS inside the scene HTML. Ordinary
`write_scene_html` edits retain it, as do style changes. Scene versions restore text together with
that version's authored content and pinned style. An old version whose text exceeds the current
scene duration cannot be restored until you extend the scene. Historical versions and Whole video
are view only in the text controls; switch to the latest version in This scene to edit. Preview,
stills and export use the same HTML and frozen clock, without another renderer.

For a dissolve, text that ends at the outgoing scene's duration disappears at that boundary.
The export uses a fresh picture of that selected version at its exact end for the held part of
the dissolve. This also works when its scene clip comes from cache. Cuts and scenes without
text use the existing join path; the clock and the cached clip pixels are unchanged.

## Reference experiment

An [original meadow approximation](examples/reference-study/README.md) tests layered environment motion against one openly licensed film excerpt. The [experiment note](docs/experiments/reference-to-scene.md) records the source, actual render checks and limits in layout, motion, timing and sound.
