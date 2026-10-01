# scene-loop

Make videos scene by scene with the AI chat you already use. Claude or ChatGPT sits on the left and
builds the video; scene-loop sits on the right in the chat app's built-in browser, where you pin
comments on the frame, compare versions, play the whole video and render it.

I built this for my own explainer and course videos. It's early and it changes a lot.

## Why

The shape is borrowed from Caleb Porzio's
[Storyboard teaser](https://x.com/calebporzio/status/2104945478055989489): script, then scenes,
then one scoped chat per scene with versions and whole-video playback. Rendering is
[HyperFrames](https://github.com/heygen-com/hyperframes) by HeyGen: scenes are HTML with a
seekable GSAP timeline, rendered to MP4.

I tried HyperFrames' own Studio first. It's a timeline editor where you nudge positions and text
sizes, and I don't want to edit video like that. I want to point at a frame, say what's wrong, and
get a new version back.

## What it does

- Filmstrip of scenes, a preview with This scene / Whole video, and an activity panel per scene.
- Pause, drag a box on the frame, write a comment. The chat picks open comments up with a still of
  each frame and the box drawn on it.
- Every change the chat saves becomes a new version with 5 stills. You can compare versions, flip
  between them at the same timestamp, approve one, or bring an old one back.
- A Render button for the MP4.

## Chat on the left, video on the right

Open the app in the built-in browser of Claude Code desktop or the ChatGPT/Codex desktop app, and
the chat next to it can build and edit the video. The page offers its tools through WebMCP
(ChatGPT's "Site tools" discover them on their own) and as `window.sceneLoop` in the page's
JavaScript for agents that don't discover WebMCP yet. `window.sceneLoop.help()` lists them:
project settings, create, reorder and remove scenes, a theme and design spec for all scenes, read
and write a scene, stills, pending comments, approve.

Your comments wait in the page until you tell the chat to apply them (Copy prompt gives you the
words). Every write becomes a version that records the model and whether it came through WebMCP or
page JavaScript.

## Your own plan, no API key

The agent is the chat you already use, in the app you already pay for. scene-loop never calls a
model itself and holds no keys.

## Run it

Needs Node 22, ffmpeg, and network for jsDelivr and `npx hyperframes@0.8.103`. No npm install.
Then open the URL in the built-in browser of Claude Code desktop or the ChatGPT desktop app.

```
cp -R templates/project ~/videos/my-video
node server.mjs ~/videos/my-video --reviewer YourName
open http://localhost:4300
```

## Project format

```
storyboard.json        title, size, colours, soundtrack, and the scenes with start, duration,
                       transition and narration
scenes/<id>/scene.html one HyperFrames sub-composition per scene: <template>, a root div with
                       data-composition-id="<id>", one paused GSAP timeline registered as
                       window.__timelines["<id>"]
assets/                images, fonts, audio, referenced as assets/...
frame.md               optional design spec the agents read
AGENTS.md              rules the chat reads through get_rules
theme.css              optional, applied after every scene's styles
```

The app keeps its own state next to that: versions in a private git dir (`.history`), comments,
chats and a metrics log in `.state`, builds in `.build`, renders in `renders`.

Scene ids must not start with a digit. HyperFrames' own audits crash on them.

## License

Free for personal use and other noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). That also covers charities, schools and
public institutions. Using it in or for a company needs a commercial license. Write to
kristian@primux.dk.

Third-party code and the required notice are in [NOTICE.md](NOTICE.md).

I'm not taking pull requests yet. Issues are welcome.
