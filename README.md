# scene-loop

Make videos scene by scene with an AI agent. Each scene gets its own chat with Claude or Codex,
its own versions, and comments you pin straight onto the frame. Then you play the whole video and
render it.

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

- Filmstrip of scenes, a preview with This scene / Whole video, and a chat panel per scene.
- Pause, drag a box on the frame, write a comment. Comments collect per scene and go to the agent
  in one batch, with a still of each frame and the box drawn on it.
- The agent edits only that scene's folder and checks its own work with stills before it replies.
  Every turn that changes the scene becomes a new version with 5 stills. You can compare versions,
  flip between them at the same timestamp, approve one, or bring an old one back.
- A project chat for changes that span scenes, and a Render button for the MP4.

## Your own subscription, no API key

The agents are the `claude` and `codex` CLIs you already have, run headless with session resume
(`claude -p --resume`, `codex exec resume`). They use your Claude or ChatGPT subscription login.
The app strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` before it
starts Claude, because those would otherwise win over the subscription login.

Writes are kept inside the scene folder three ways: Claude runs in `dontAsk` mode with edit rules for
that folder and your user settings skipped, Codex runs in its `workspace-write` sandbox, and the
server undoes any change outside the folder after each turn.

## Run it

Needs Node 22, ffmpeg, `claude` and/or `codex` logged in, and network for jsDelivr and
`npx hyperframes@0.8.103`. No npm install.

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
AGENTS.md, CLAUDE.md   rules for the scene agents
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
