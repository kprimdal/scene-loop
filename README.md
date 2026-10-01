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

Then Claude has the tools: list and create projects, project settings, create, reorder and remove
scenes, a theme and design spec for all scenes, read and write a scene, stills, pending comments,
approve, render. Stills come back as images in the tool result, so Claude sees its own frames in
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

Needs Node 22, ffmpeg, and network for jsDelivr and `npx hyperframes@0.8.103`. No npm install.
It listens on 127.0.0.1 only; there is no login. Run it on your own machine, or your own server or
Docker if you want it elsewhere. Nobody hosts it for you.

```
mkdir ~/videos
node server.mjs ~/videos --reviewer YourName
claude mcp add --transport http scene-loop http://localhost:4300/mcp
open http://localhost:4300
```

`~/videos` is a projects root: one folder per project, created with `create_project` from the
chat or the New project button. Each project keeps its own versions, comments and renders. Point
the server at a folder that has a `storyboard.json` instead and it serves that one project, as
before (`cp -R templates/project ~/videos/my-video` makes one).

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

The server is `server.mjs`; the tools are defined once in `lib/tools.mjs` and served on `/mcp`
(Streamable HTTP, stateless, no SDK) and to the page. `docs/server-and-mcp.md` has the plan and
the client notes.

Scene ids must not start with a digit. HyperFrames' own audits crash on them.

## License

Free for personal use and other noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). That also covers charities, schools and
public institutions. Using it in or for a company needs a commercial license. Write to
kristian@primux.dk.

Third-party code and the required notice are in [NOTICE.md](NOTICE.md).

I'm not taking pull requests yet. Issues are welcome.
