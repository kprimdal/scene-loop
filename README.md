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
  are pronounced and where they may sit in a sentence, voice, tone) and tags; the overview
  shows every project and its videos.
- A brand kit per project (`brand/`): the rules the chat follows (`brand.md`), the fonts, colours
  and shared classes (`brand.css`, loaded in every scene before the video's own theme) and the
  font and logo files. Every video in the project uses it, so a new video starts on brand. The
  project's page shows the logos, colours and fonts and edits the two files.
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
| Projects | `list_projects`, `create_project`, `create_video`, `get_project_instructions`, `set_project_instructions`, `get_brand`, `set_brand`, `add_brand_file` |
| Start here | `get_rules`: the project instructions, the brand kit, the video's agent rules, design spec, theme and the scene contract, with the script status first |
| Scenes | `list_scenes`, `create_scene`, `update_scene`, `reorder_scenes`, `remove_scene`, `get_scene_html`, `write_scene_html`, `set_scene_text`, `get_stills`, `show_scene`, `restore_version` |
| Review | `get_pending_comments`, `add_comment` |
| Narration | `set_narration_audio`, `remove_narration_audio`, `set_narration_words`, `remove_narration_words`, `fit_scenes_to_narration`, `build_soundtrack` |
| Takes | `list_takes`, `choose_take`, `keep_take`, `add_take` |
| Clips | `probe_media`, `cut_clip`, `list_clips` |
| Video | `get_video_files`, `set_video`, `set_theme_css`, `set_design_spec`, `render`, `get_render`, `delete_renders` |
| Library | `list_cards`, `get_card`, `list_formats`, `list_sources`, `get_video_cards`, `attach_card`, `detach_card`, `undo_cards`, `use_card_once`, `apply_style`, `remove_style`, `get_scene_motion`, `apply_motion`, `remove_motion`, `apply_transition`, `undo_transition`, `reset_transition`, `instantiate_pattern` |
| Music | `list_library`, `add_to_library`, `update_library_item`, `remove_from_library`, `use_library_music` |

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

`--library ~/my-library` points the Library at your own folder of cards, formats and sources (see
[The Library](#the-library)); without it the starter library in `library/` is used.

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
  project.md           instructions for the chat (pronunciation, voice, tone); the
                       frontmatter has title and tags. Edited from Instructions in the page.
  brand/               optional brand kit for every video: brand.md (rules), brand.css (fonts,
                       --brand-* colours, shared classes) and their files (fonts/, logos).
                       Each video sees it as assets/brand/, a link the app keeps.
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
frame.md               optional design spec the agents read, for what is particular to this
                       video (the project's brand.md holds what every video shares)
AGENTS.md              the scene contract the chat reads through get_rules
theme.css              optional, applied after every scene's styles and the brand's brand.css
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

## The Library

The Library is what scene-loop knows about making a video good, as cards. A **technique** card says
what a technique is, when to use it, what to tell the chat (a prompt, marked *as shown* when it is
copied word for word from its source), where it was learned, and whether scene-loop does it today
(in scene-loop, in part, not yet). The other cards are things scene-loop can apply: a **style**
(colours and type for a scene), **motion** (an entrance or exit), a **transition** (the boundary
into a scene), a **pattern** (a starting layout for a new scene) and a **workflow** (steps, an
example and a checklist for a whole task). Cards sit in stages, in the order a video is made:
before the script, hook, script, main cut, camera and motion, cuts, on screen, look, sound, ending,
thumbnail and title, way of working.

A **format** is one kind of video: YouTube long-form, a vertical short, a LinkedIn clip, a launch
video, a course lesson. It holds the canvas, length, hook window, captions, rules and the cards
that matter most for it. `set_video format: <id>` saves a copy on a video, and `get_rules` gives
the chat its rules. A **source** is where cards came from: a video, an article, a book, a study,
our own notes, with the cards that cite it.

Open **Library** in the header. Choose a video and scene at the top; filter the cards by format,
kind, status or words; open a card for all of it and what you can do with it in that video:

- a technique or workflow: **Attach to video** (the chat gets a saved copy with `get_rules`, after
  the project instructions; up to 12, undo up to 10 changes) or **Copy prompt for once**;
- a style: apply to this scene or the entire video, or remove it;
- motion: on an element of the scene, at a narration word or a second;
- a transition: into the chosen scene, with undo and reset to the default dissolve;
- a pattern: fill in its fields and make a new scene in the chosen video.

The **Formats** tab sets a video's format, **Sources** lists where the cards came from. The chat
has the same through `list_cards` (filter by kind, stage, format, status, words), `get_card`,
`list_formats`, `list_sources`, `attach_card`, `detach_card`, `undo_cards`, `get_video_cards`
and `use_card_once`. A card's `implementation` is the exact versioned object the apply tools
take; `use` says which tool.

### Your own library

The Library is a folder of JSON files, read by the server and never written by it:

```
library.json            title, and the stages in order
cards/<id>.json         one card per file
formats/<id>.json       one format per file
sources/<id>.json       one source per file
demos/<id>/scene.html   a card's moving example, with its assets beside it
```

Start the server with `--library <dir>` (or `SCENE_LOOP_LIBRARY=<dir>`) to use yours. Without it,
the starter library in `library/` is used: scene-loop's own styles, motion, transitions,
patterns and workflows, and one technique, format and source as examples. A library can live in
a repository of its own (a private one, if the content should not be public), and grow by
commits: a coding agent adds a source and the cards learned from it, runs the check, and opens a
pull request. A `git pull` in the folder shows on the next read; there is no restart.

`node bin/check-library.mjs <dir>` checks every file before a commit: the fields each kind needs,
ids that match their file names, sources, formats and related cards that exist, demo files that
exist, and no em dashes. A file that fails the check is left out of the Library and named in
`list_cards` (`errors`) and in the server log; the rest still load.

A demo is a scene like any other (`<template>` with a root that has `data-width`, `data-height`
and `data-duration`), played with the same clock as a video. Its files load from its own folder.
Style, motion, transition and pattern cards without a demo show the example their implementation
makes.

## Style cards

The starter library has three original treatments: Signal, Paper and Grove. Applying one never
inserts the example's content: it keeps authored HTML, motion, narration, scene timing and music.
Choose **Entire video** in the card to apply to all its current scenes.

`apply_style` and `remove_style` use the same controls as the page. `get_rules`, `list_scenes`
and `get_scene_html` include selected styles. Project instructions remain first in `get_rules`
and take priority over style guidance.

Each scene stores a full copy of its style (version, SHA-256 content hash, CSS and guidance) in a
marked block in `scene.html`. Later library edits cannot change that scene. Normal HTML tool edits
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

## Pattern cards

The starter library has three original patterns: Process, Comparison, and Presenter + visuals.
Choose a video at the top of the Library, open a pattern card, replace the example text, name the
scene and set its duration (3–60 seconds, default 8). Create adds a **new** scene; Open new scene
takes you back to the usual preview, comments and versions.

The chat uses `list_cards` (kind `pattern`), `get_card`, then `instantiate_pattern`. The card's
`implementation` holds the exact version, content hash, guidance, defaults and field limits. Pass
the version/hash back to creation to reject a library change since then. Supply plain strings and arrays of lines
in `inputs`, following the inspected field keys; omitted inputs use the complete example.
Process accepts 2–4 steps; Comparison accepts 1–3 points per side; Presenter accepts 1–3 points.
Headings are at most 72 characters; each field's exact limit is in inspection and on the form.
Creation uses the target video's width and height (240–7680 px each), with stacked portrait
layouts and compact layouts for square/4:3 canvases. Motion uses scene-local CSS animations: staged reveals during the first half, then a
reading hold. It runs through the normal frozen clock and renderer.

Every generated scene is ordinary editable HTML, with no library request during playback or
export. Its provenance block snapshots the pattern descriptor, original inputs, canvas, duration,
media kind and content hash (including the generator source). `get_rules`, `list_scenes` and
`get_scene_html` expose that snapshot. It records the starting point, not a claim about later
edits. `write_scene_html` preserves it automatically alongside pinned styles and timed text.
Adapt content to narration, and add `data-at` word anchors once words are timed. Restore through
normal scene versions. A pattern never replaces an existing scene, even when an explicit id is
supplied; duplicates are rejected. Existing scenes and their narration, timing, styles, text and
music are retained. Adding a scene can require rebuilding an existing soundtrack.

Presenter media is optional. Supply an existing path under **this video's** `assets/`, including
`assets/cam/<source-scene>.mp4` returned by `list_takes`. Images: PNG, JPEG, WebP. Video containers:
MP4, WebM, MOV, with H.264, VP8/9 or AV1 visual streams. Paths must be local (no URLs, traversal or
symlink escapes); missing, corrupt, unsupported or audio-only media is rejected before creation.
The file stays project media, not a library asset. Video is muted, starts at scene time zero and
holds its last frame; frame it for the narration length. The portrait region uses `object-fit:
cover`, so inspect its crop. No media creates a labelled graphic placeholder with **no missing
media request**. When a camera take exists later, the agent can replace that region through
`write_scene_html` with the valid clip. Catalog demos use the original labelled stand-in, never
pretend footage. The layouts use local font fallbacks; package project fonts for identical type
across machines. Apply a Library style after creation if desired, and check contrast and long
text in the actual scene before export.

## Motion and transition cards

The starter library has four original scene effects (Fade in, Fade out, Rise, Pop) and two
incoming boundaries (Cut, Dissolve). Choose a video and scene at the top of the Library, open an
effect, then select Whole scene, its semantic heading, one of its text items, or a named element
supplied by the scene author. Enter a scene-local start and duration, or choose a narration word
and an authored fallback start. Missing words and cues outside the scene use that fallback with a
visible warning. The fallback must fit the scene. Effects hold before and after their interval;
authored visibility and timed-text start/end still apply. Open the video to see the result. The
first scene has no incoming boundary.

The chat uses `list_cards`, `get_card`, `get_scene_motion`, then `apply_motion` or
`apply_transition`. `get_scene_motion` supplies exact pinned choices and guidance, target labels,
scene version, narration/word timings, resolved seconds, warnings and `contextHash`. Pass the
context hash back to reject a changed target, narration timing, storyboard or scene. Pass the
implementation's `version` and `contentHash` back to reject library changes. `apply_motion` accepts
`motion`, `target`, `start`, optional `anchor` (the existing word/sentence syntax), and `duration`.
At most four choices fit one scene. `remove_motion` accepts the choice `id`, or `all`.
These tools use the same handlers over MCP, WebMCP and `window.sceneLoop`.

Motion pins include the exact descriptor, guidance, keyframes and implementation in scene HTML.
Playback makes no library request. Ordinary `write_scene_html`, style and text edits retain the
pins, or return an actionable conflict if a target disappears or becomes incompatible. Use
`data-motion-target="card" data-motion-label="Idea card"` on an existing block/flex/grid element
to offer a named target; names use a lowercase letter followed by letters, digits or hyphens
(up to 40 characters). A unique `data-sl-heading` is discovered automatically. Managed text
animates its inner box so its visibility interval stays authoritative. Duplicate or missing
markers, inline/display:contents boxes, fixed-position descendants, unpositioned targets with absolute
descendants, and important CSS that blocks
the effect are rejected. No wrappers or arbitrary CSS selectors are introduced.

The effects add a WAAPI opacity filter, plus individual translate for Rise or scale for Pop.
They compose with authored CSS/WAAPI transforms and filters; authored motion can still hide the
target. A scene with video under these effects can require frame-by-frame rendering. Whole-scene
effects reveal `storyboard.background` inside their slot; that slot then participates in the
existing cut/dissolve. Named-only scenes keep the existing slot behavior. Seek, replay, stills
and export use the same frozen clock. Outgoing managed motion uses the existing exact-end
snapshot path during dissolves, including cached renders, so a fade ending at the boundary
holds its exact end rather than its last sampled frame.

Motion removal saves a scene version. Restore scene version in the controls (or normal video
versions) restores that version's content, motion, style and text together. **Transitions belong
to storyboard/project history, not scene HTML history.** `apply_transition` sets `transitionIn`
(`cut`, or `dissolve` with 0.05–5 seconds within scene duration). `undo_transition` restores only
that scene's previous boundary, up to ten changes, and survives server restart.
`reset_transition` restores the default 0.6-second dissolve (clamped to scene duration); reset is
itself undoable. Direct `update_scene` boundary edits join the same undo stack. Restoring scene
HTML does not restore a transition. Cut/dissolve keep the scene starts, total duration,
narration and soundtrack fixed. Boundary-only changes reuse existing scene clips.

## Workflow cards and attached cards

The starter library has four workflow cards: Explain a concept, Show a workflow, Improve pacing,
and Review a video. Each has a short workflow, a worked example, an expected result, a review
checklist and a reusable prompt. Technique cards are attached the same way.

**Copy prompt for once** gives a full copy of the card for the chat beside the page, for one task:
it attaches nothing and runs nothing. The prompt names the exact project/video and asks the chat
to read `get_rules` first. Paid final narration still requires word-for-word script approval.

**Attach to video** saves a copy of the card (id, version, content hash, what, when, prompt,
guidance, sources; for a workflow also its steps, example and checklist) in that video's
`cards.json`. One copy per card, at most 12. Library edits never change saved copies: to take a
newer version, detach the old one and attach again. Attached cards are in `get_rules` right after
the project instructions, which take priority over them. Attaching and detaching never edit
`project.md`, `AGENTS.md`, scenes, narration, storyboard or scene pins.

Card changes use the video's private Git **project-file** history (`.history`, `project/vN`),
committing only `cards.json`. **Undo last card change** (`undo_cards`) restores the previous set,
including removals and exact older copies, up to ten changes across restarts. Scene restore does
not restore cards, and card undo does not restore scene content. A video from before the card
library keeps its `guides.json` (attached task guides): those copies read as attached workflow
cards until the first change writes `cards.json`.

The tools are `get_video_cards`, `attach_card`, `detach_card`, `undo_cards` and `use_card_once`.
Pass the card's `version`/`contentHash` to reject changed contents, and `contextHash` from
`get_video_cards` to reject stale attachment choices. Attaching, detaching, undo and one-time use
need both `project` and `video`, even on a single-video instance. Cards are instructions for the
chat beside the page; the server never calls a model or runs a card by itself.

## Project reference videos

Open **Library → References**, choose a project, then save a local MP4/MOV/WebM or an http(s)
source link. Select start/end seconds, describe the intent, and add tags and source/credit.
Optional notes separate observations, desired qualities and reproduction gaps. Notes carry
user/agent provenance; the server performs no analysis or model calls. Source links are never
fetched or embedded. A link-only range and its media contents are explicitly unverified.

Uploaded media stays intact (100 MiB maximum, video stream and finite duration checked with
ffprobe). Its range uses **local file time**: if an excerpt contains original seconds 3–10,
select local seconds 0–7 and put the original offsets in Credit. Inspect offers range play,
stop/seek and loop. Native video controls can also inspect the full original file. Playback
depends on the browser’s codec support; Open original media preserves an external inspection path.

References are **project scoped and owner only**, including their metadata and guarded media
URLs. They never enter the shared music library. Search title/intent/creator/tags, filter a tag,
and inspect the notes before attaching. A project can attach the same reference to several of
its videos. Attachment does not insert media or change scenes, narration, soundtrack, other
Library pins, project instructions or the rendered output. It gives the chat descriptive
guidance; project instructions and explicit user rules take priority. It does not promise
recreation of the reference.

The library lives at `<project>/.references/catalog.json`; immutable originals live beside it
under `media/`. A tool may import a file only from that named project's `.references/inbox/`
(relative path there or an absolute path beneath it). The browser's file picker uses a bounded
stream upload and needs no server filesystem access. All three project layouts use the same
project-private storage. Registry-resolved project/video aliases are trusted, including roots
through symlinked ancestors. Reference storage and attachment files beneath those canonical
roots still reject symlinks and escaping paths. `media/` and `inbox/` are excluded from the app's git history.

Each record has an id, version and SHA-256 content hash (the stored record without the hash
itself or the derived media URL). Undo can restore an earlier version;
the hash distinguishes its exact contents. Each video's `references.json` saves the full
selected snapshot with its range, intent, supplied notes, credit and usable media/source URL.
Library edits never change it. Choose **Update attachment explicitly** to replace it with the
inspected version. Duplicate attachment of the same exact version is a no-op; a different
version requires update. Separate saved records may use the same source with different intent.

**Remove from library** is soft removal. **Include removed → Inspect / restore** recovers it.
Original media and existing attachments remain usable after removal or undo. **Undo library
change** restores only library metadata (10 changes); **Undo attachment change** restores only
that video's snapshots (10 changes). Metadata saves also enter the project's `.history`
(project/vN); attachment saves enter the video's project-file history. In legacy/single-video
layouts these histories share the video's `.history`. Scene restore does not restore either.
Media is retained even after undoing creation; there is no media garbage collection in this
slice. Back up the complete project, including `.references/`, for recovery. Limits are 100
saved records per project (including removed), 20 attachments per video and 20 tags per record.

Agent equivalents are `list_references`, `inspect_reference`, `save_reference`, `edit_reference`,
`remove_reference`, `restore_reference`, `undo_reference_library`, `get_video_references`,
`attach_reference`, `update_reference_attachment`, `detach_reference` and
`undo_reference_attachments`. All require an explicit project; video attachment operations also
require an explicit video. Writes require the appropriate current `contextHash`; attach/update
also require the inspected reference's `contentHash`. `get_rules` returns the exact attached
snapshots after project instructions. If optional attachment metadata cannot be read, it keeps
the project/video rules and returns `references: null` with
`referenceStatus: {available: false, diagnostic: "..."}`. This is distinct from an available
empty selection; explicit reference tools continue to report the underlying error. Media URLs use the owner's browser login, like the other
private page routes; an MCP bearer token alone does not grant file-route access.

For a browser upload, POST `application/x-scene-loop-reference` to
`/api/references/upload?project=NAME`: a UTF-8 JSON line
`{"metadata":{...referenceFields,"contextHash":"..."},"mime":"video/mp4"}` followed by the
original file bytes. The header is bounded to 96,000 bytes. MP4, MOV and WebM are supported;
there are no remote downloads, Keep integration, automatic analysis or reconstruction tools.

## Review recording cleanup

Open **Recording cleanup** in the selected scene's activity panel, or **Cleanup** beside the
used take in Record. Choose **Gentle cleanup** or **Cleanup off**, then **Prepare preview**.
Listen to Before (the current selected audio) and After (the pending candidate). Playback is
manual; starting another review player pauses the first. The original full recording and the
same edit without cleanup are available separately. The original includes unused material,
so its player time is not the scene's time.

Gentle is the existing 80 Hz high-pass plus adaptive `afftdn` at 10 dB reduction. Off uses the
same saved ranges, 40 ms crossfades and end fades without those filters. Both come from the
preserved original, never from the already processed narration. Cleanup can affect the voice;
compare by ear. It does not promise to remove clicks, clipping, other voices or every noise.
Old takes keep their existing gentle treatment until explicitly changed.

**Keep** selects the candidate and rebuilds the soundtrack, including other narration, music
and sound effects. **Revert** restores the exact previous scene waveform and treatment, then
rebuilds the current mix. Revert is one level, survives reload/restart, and applies only while
the same take, source and cuts remain selected. It does not undo script, cuts, camera, scene,
Library or pin changes. The selected mode stays with that take when it is reselected or cut
again. Neither operation fits durations, transcribes, changes words/leads or recuts cameras.
Scene render clips remain cached when their pictures did not change.

The last `build_soundtrack` loudness setting is reused. Earlier builds did not save this
setting; their cleanup rebuild uses -16 LUFS. Each scene keeps its own narration lead. A custom
soundtrack must first be replaced explicitly with `build_soundtrack`. These controls support
chosen recorded camera and audio-only takes with saved ranges; external narration, no take,
and missing original media produce an explanation.

Agent equivalents on MCP, WebMCP and `window.sceneLoop` are `inspect_noise_cleanup`,
`preview_noise_cleanup`, `keep_noise_cleanup` and `revert_noise_cleanup`. Inspect supplies
`contextHash`; preview requires it and a `mode` (`gentle` or `off`). Keep also requires the
preview `token`. Tokens are scoped to a video's actual take, edit, source, narration, words,
scene/cue and mix inputs. Changed inputs invalidate a candidate. A newer candidate supersedes
the older token. All tools use the existing owner gate; commenters cannot process or select audio.

Original media stays at `assets/takes/`. Immutable comparison waveforms, prior audio and
prepared mixes live in `assets/noise/<scene>/<uuid>/`. The selected mode is in `takes.json`;
`.state/noise/<scene>.json` owns pending and revert metadata, and `soundtrack.json` in that
folder saves mix settings. Selection stages files before swapping narration, mix and metadata.
A recovery journal rolls an interrupted swap back when that video next opens. Preparation or
mix failure keeps the last good selection. Back up the complete video, including `.state/`
and `assets/noise/`, for recovery. Superseded previews/mixes are retained; there is no automatic
media garbage collection in this slice. This journal handles process interruption and ordinary
write failures; it does not guarantee durability against storage-device or filesystem failure.

## Selected-scene captions

Open **Captions** in the selected scene's activity panel, in **This scene** at its latest
version. **Generate draft from words** uses the existing `.words.json` timings, with that
scene's `narrationLead` (default 0.35 s) added exactly once. There is no transcription or model
call. Missing timings explain the prerequisite. Draft grouping breaks at sentence endings,
pauses over 0.6 s, 10 words, 72 characters or 5 seconds. Valid zero-duration words from
Scribe/Whisper stay in the caption text. Their display uses phrase context, including a nearby
phrase across a sentence/group boundary when it fits the hard cue limits. An isolated point
cue uses available time between neighboring cues and scene bounds, up to 0.8 s per cue. A run
of point cues reserves equal slots near its source points. If touching neighboring phrases
leave no gap and merging would exceed a cue limit, the point cues share the preceding phrase's
display interval (or the following phrase at the start), in text-length proportions. Every
word stays in source order and every displayed cue has a positive, non-overlapping interval.
A point may coincide with or lie inside a neighboring spoken interval; it does not force
overlapping displayed cues.
This infers display timing only; it does not invent or change transcript/audio timing.

The panel's **Inferred timing** notice and saved `provenance.derivationNotes` identify the
point-timed source word indexes, generated cue bounds and the context used. Notes describe the
generated draft; later user corrections can override its display times. Derivation version 2
owns this rule. Existing version 1 pins stay intact until explicit regeneration; ordinary edits
retain their provenance. Overlapping spoken-word intervals, reversed or invalid source timing still needs review.
Words outside scene bounds after lead produce an actionable length/lead error without clipping.

Select a cue to correct its display text and start/end seconds. Choose **Dark card**, **Light
card** or **White · shadow**. **Preview cue** seeks to that cue; **Preview draft** shows all
current edits. **Save captions** persists the draft. **Cancel**, closing the panel, or changing
scene, version, comparison or video discards the draft and restores the saved picture. Draft
previews do not write a version. History and whole-video modes allow inspection, with editing
available only on the latest selected scene. Text/motion/music/library/record controls remain
independent.

Captions are ordered, non-overlapping, scene-local **[start,end)** intervals: visible at start,
hidden at end, including end equal to scene duration. Limits are 200 cues per scene, 84 plain
text characters and 2 explicit lines per cue, and at most 8 seconds per cue. Text wraps inside
the frame in landscape and portrait. Long words wrap too. Bottom-centre placement can overlap
lower thirds, a camera inset or other authored content; the panel states this, and both must be
reviewed together. There is no automatic collision solver or caption motion target.

The separate `scene-loop:subtitles` block in scene HTML pins the exact cues, style descriptor
and implementation. It does not use the four-item title limit. Ordinary `write_scene_html`,
styles, text and motion edits preserve its exact bytes. Caption text is escaped and never
becomes HTML, CSS or script. The styles pin local `Arial, Helvetica, sans-serif` fallbacks;
font rasterisation can differ between machines. Playback needs no catalogue or external font.
Existing frozen CSS animation timing drives preview, stills, single clips and whole exports.
Caption scenes use the existing render-job exact-end outgoing hold for dissolves, including
cached clips. No clock or clip-joining changes are involved.

Saved timings are **snapshots**. Script, word-file, narration audio, chosen-take metadata and
lead fingerprints are stored in provenance, together with the derivation version and its timing
contract. If these inputs change, the panel and `get_scene_subtitles` show `stale` and the
changed components. Corrections and displayed times stay fixed. They do **not** follow the
new words automatically. **Regenerate draft from words** explicitly replaces the draft from
the current source; only saving it rebases provenance. Cancel keeps the old corrections.
Ordinary corrections to a stale snapshot keep its original provenance and stale status.
Shortening a scene or fitting narration past a saved cue end is rejected before the storyboard
or lead changes. Edit/remove caption timing first, then fit. There is no silent retiming.

**Remove cue** and **Remove all captions** change only the draft until saved. **Open scene
history** leads to normal scene versions; restoring a version restores captions with that
version's authored content, styles, text and motion. Restore rejects captions outside the
current scene duration. It does not restore binary audio, transcripts or the storyboard lead;
restored captions can therefore show stale source diagnostics.

Agent equivalents over MCP, WebMCP and `window.sceneLoop`:

- `get_scene_subtitles({project, video, scene, version?})`: exact cue/style/provenance snapshot,
  current source fingerprints, stale reasons, prerequisite, version/latest and `contextHash`.
- `generate_scene_subtitles({project, video, scene, contextHash})`: an **unsaved** `draft` with
  cues, style and provenance. The disk stays unchanged.
- `set_scene_subtitles({project, video, scene, contextHash, cues, style, model, sourceHash?,
  regenerate?})`: saves overrides with ordinary scene HTML history. Use the generated draft's
  `provenance.sourceHash` and `regenerate:true` for initial generation or explicit regeneration.
  Ordinary corrections omit regeneration and retain provenance. `cues:[]` removes captions.

All three require an explicit project/video and the existing owner gate. Writes reject changed
HTML, source or duration using the inspected context hash, including a second check after motion
preflight. The page also guards asynchronous loads and detached forms against changed targets,
versions and source-only changes. Tests use synthetic word timings and free sine/silence audio;
no real projects, transcription service or paid narration are needed.

### Edit a range of the chosen recording

Open **Edit recording range** in the selected scene's panel, in its latest view. These controls
use **current edited recording seconds**, from 0 to the selected 48 kHz narration's duration.
Scene time is recording time plus the displayed `narrationLead`. The original full take and
its retained original-time ranges are shown separately. Seek the current recording, mark start
and end (or enter numbers), and **Preview selected range** before choosing **Remove range**,
**Mute range · voice only**, or **Keep only range**. Each action prepares a result and impact
report; **Apply reviewed range** selects it. Preparing or dismissing a preview selects nothing.
The candidate camera uses scene seconds, including the lead. Music and SFX are not muted.

Bounds round to the nearest 1 ms. Remove/keep compose with previous cuts; every retained
original fragment must be at least 50 ms. Smaller fragments are rejected with their exact
bounds, never silently dropped. Audio keeps the existing 40 ms join clock, with silent outgoing
handles and fades so removed speech cannot leak back into a join. Camera source timestamps use
the same accumulated mapping, then sample once on the video frame grid (within one frame).
Mutes are sample-accurate half-open windows and persist in original-take coordinates.

Mute preserves scene/audio duration. Remove/keep preserve the existing lead and tail
(`max(0, scene duration - lead - current audio duration)`), then round the new scene duration
up to the frame grid. The impact report shows the exact rounding. A scene that already cuts
off narration by more than one frame must be fitted/reviewed first. Shortening rejects saved
captions, text items or motion fallbacks that would exceed the new duration, naming each item.
Correct their timings first; the controls never silently delete, clip or retime these items.

Surviving transcript words follow the cuts. Partially cut words retain their text and their
surviving timing span and are explicitly reported; point words survive inside half-open kept
windows. The script stays unchanged and can therefore differ from retained speech. The report
lists removed/partial words, resolved and fallback `data-at`/`data-sfx`/managed motion anchors.
Authored absolute CSS/WAAPI/script motion and numeric SFX keep their authored clock and require
review. Corrected captions remain independent scene-local snapshots, with source staleness
visible in Captions. They do not automatically follow the new words.

Original take bytes stay intact. **Undo previous recording edit** keeps one previous selected
waveform, words, camera, take metadata and scene timing across reload/restart. Undo rebuilds the
current mix, preserving other scenes, music/SFX and unrelated edits; conflicting changes to the
affected recording, words, camera, HTML or timing reject undo with an explanation. Scene HTML
history alone does not restore audio. Gentle/off cleanup and original-coordinate mutes survive
range edits, take reselection, cleanup keep/revert and later recuts; cleanup always starts from
the original, so it is never applied twice.

Preparation validates candidates without replacing selected files. Apply/undo recheck source,
scene and mix context after processing, then use a recoverable file-selection journal. An
interrupted file selection rolls back on reopen. Once selected, a durable completion marker
finishes ordinary scene/project history; a history failure is reported as **selected, history
pending**, and gates later edits/latest reads/builds until retry/reopen finishes. Completion
also repairs a missing version tag after interruption between commit and tag. Filesystem
selection and git history are not one atomic transaction. External changes to pending history
files stop completion with a conflict rather than absorb them. Originals and recovery snapshots
remain available. Unrelated visual clips are reused; mute does not change camera/visual files.

Agent tools require explicit `project`, `video`, and `scene`, through MCP, WebMCP or
`window.sceneLoop`: `inspect_recording_ranges`, `preview_recording_range` (`action: remove|mute|keep`,
`from`, `to`, inspected `contextHash`; remove also takes `ranges: [{from, to}, ...]` to cut several
parts in one edit), `apply_recording_range` (reviewed `token` and `contextHash`),
and `undo_recording_range` (current `contextHash`). No take, external/custom narration or a
custom soundtrack returns a clear prerequisite. This edits one selected recorded take,
including audio-only takes; it does not remap arbitrary authored scenes.

### Split & cut a take in the Record view

The used take has **Split & cut** (or press X in the Record view). It opens the take's camera
and a waveform of the current recording, with the timed words under it when the scene has them.
Click or drag on the waveform to move the playhead, ←/→ step one video frame (Shift 1 s). The
playhead and every split sit on the scene's frame grid, so a cut never falls inside a frame.
**S** splits at the playhead, **X** (or Delete) marks the part under the playhead as cut or keeps it again, and
a double-click on a split removes it. Space plays; with **Skip cut parts** on it jumps over the
red parts, so you hear the result before anything is saved.

**Cut N parts** sends every cut part as one remove with `ranges`, so it is the same reviewed
range edit as above: a prepared result to listen to, the words it cuts or cuts through, and any
caption, text or motion that would no longer fit. **Apply the cut** selects it; it is one edit
and **Undo last cut** brings the previous recording back. Splits closer than 50 ms are refused,
the same minimum the range tools keep.
