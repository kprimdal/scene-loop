# scene-loop as an MCP server

Decided 2026-10-01 (Kristian): scene-loop is used through an MCP connector. Claude does the creative
work on the user's own plan. Everything scene-loop does is a tool call: storing, versioning,
rendering. **We run it locally.** Anyone else, Ronni for a Zinkshoppen project included, runs their
own copy on their machine, their own server or in Docker. We will not host it for anyone else.

## Shape

```
Claude (claude.ai, desktop, mobile, Claude Code)          ChatGPT, M365 Copilot later
        │  MCP over HTTPS (Streamable HTTP + OAuth)
        ▼
scene-loop (your Mac, or your own server / Docker)
  /mcp          tools: projects, scenes, comments, stills, render
  /             web review UI: filmstrip, player, pinned comments, versions
  ui://…        MCP App: a cut-down review view inside the Claude chat
  renderer      headless Chrome + ffmpeg on the box
  projects/<project>/   project.md, and videos/<video>/ with one version history per video
```

- **The server never calls a model and holds no AI keys.** Same rule as today.
- **Stills come back as images in tool results,** so Claude sees its own work in the chat without a
  browser.
- **The web UI stays** for the human side: pinning comments on a frame, comparing,
  watching the whole video. Comments made there show up for Claude through `get_pending_comments`.
- **Which Claude clients:** locally, Claude Code adds it with
  `claude mcp add --transport http scene-loop http://localhost:4300/mcp`, and Claude Desktop reaches
  it through a stdio bridge (`npx -y mcp-remote http://localhost:4300/mcp`) in its config file.
  claude.ai on the web and mobile call connectors from Anthropic's cloud, so they only work when
  someone runs scene-loop on a public server with a login in front.

## Projects and access

- Several projects per instance, each holding videos (step 7): `list_projects`, `create_project`,
  `create_video`, and `project` and `video` arguments on the other tools. One folder per project
  under a projects directory, one folder and one version history per video inside it.
- Locally there is no login: the server listens on localhost only.
- Login (OAuth for connectors, a session for the web UI) is only needed when someone puts it on a
  public server. It comes with the Docker image, not before.
- Client material lives in the projects directory, never in this public repo.

## Build order

1. **One tool layer.** Done 2026-10-01. `lib/tools.mjs` defines every tool once (name,
   description, JSON schema, handler) over a project object from `lib/project.mjs`.
   `lib/projects.mjs` is the registry: a dir with `storyboard.json` is one project, any other
   dir is a projects root with one folder per project, opened lazily. `list_projects`,
   `create_project` (from `templates/project`) and a `project` argument on the rest, optional
   when there is one project. The page fetches the same list from `/api/tools` and calls
   `POST /api/tools/<name>`; only `show_scene` stays in `public/app.js`. The page has a project
   switcher (`?project=`).
2. **MCP endpoint** `/mcp`. Done 2026-10-01, hand-rolled in `lib/mcp.mjs`: JSON-RPC over POST,
   one JSON response per request, no session id, `initialize`, `notifications/initialized`,
   `tools/list`, `tools/call`, `ping`. GET and DELETE answer 405. An `Origin` header that is not
   localhost is refused. `get_stills` and `get_pending_comments` return each still as image
   content, a 960 px JPEG made by ffmpeg and cached next to the PNG (about 10 KB each). `render`
   returns a job id; `get_render` returns state, progress, the mp4 URL and its path.
3. **Claude Desktop locally.** Done 2026-10-01: an `mcp-remote` stdio bridge in
   `claude_desktop_config.json`, no server change. See Connecting clients.
4. **MCP App** (`ui://`) so the review UI can also open inside the chat. Done 2026-10-01,
   hand-rolled against the ext-apps spec 2026-01-26 without the SDK. See "MCP App" below.
5. **Our own renderer** instead of HyperFrames, and CSS/WAAPI instead of GSAP. Done 2026-10-02.
   `lib/chrome.mjs` finds Chrome (CHROME_PATH, then chrome-headless-shell, then Chrome or
   Chromium) and talks CDP over `--remote-debugging-pipe`: NUL-separated JSON on fds 3 and 4, no
   port, no WebSocket, no puppeteer. One shared browser, closed a minute after its last page.
   `lib/clock.js` is inlined into every assembled page: `__sl.seek(t)` pauses every CSS
   animation and Web Animation and sets its time, seeks legacy GSAP timelines, `<video>` and
   `window.__seek[id]`, and crossfades scenes in the whole-video page. `lib/render.mjs` makes
   stills (seek, `Page.captureScreenshot`) and clips (JPEG frames piped into ffmpeg, a scene
   split into chunks of at most 30 frames over parallel pages, segments joined without
   re-encoding), and joins clips with `xfade` and the soundtrack. Clips are cached in
   `.build/clips/<id>-v<version>-<key>.mp4`; the key hashes the theme, size, fps, frame span,
   the clock and the files in `assets/` (names, sizes, mtimes). `public/player.js` is the preview: an iframe over the build, the same clock, the
   soundtrack in the parent page. The HyperFrames player, runtime and shader transitions are gone.
   Render progress is frames done (90%) plus the ffmpeg join (10%). Numbers, AI for begyndere
   (9 scenes, 55 s, M4 Pro): whole render 24 to 28 s against 425 s with HyperFrames, 6 s when
   every clip is cached, stills about 1 s per scene against 3.7 s. Measurements in video-lab
   `experiments/004-own-renderer/findings.md`.
6. **Docker image and login.** Done 2026-10-01. `Dockerfile` (Debian slim, Node 22, Debian's
   Chromium, ffmpeg, git, fonts) and `docker-compose.yml`; about 60 s
   to build, 540 MB compressed. `--host` (default 127.0.0.1); any other host refuses to start
   without `SCENE_LOOP_PASSWORD` unless `--no-login`. `lib/auth.mjs`, hand-rolled: a login page
   and signed session cookie for the web UI, `SCENE_LOOP_TOKEN` as a fixed bearer for Claude
   Code, and the MCP OAuth flow for claude.ai connectors (Protected Resource Metadata,
   Authorization Server Metadata, client ID metadata documents and dynamic registration,
   `/authorize` with PKCE S256 behind the same password, `/token` with refresh). Everything is
   a signed value, so nothing is stored. One `auth.gate(req, res)` call in `server.mjs`; `mcp.mjs`
   skips its localhost Origin check when the request carried a token. `CHROME_PATH` picks the
   browser. Setup and proxies: `docs/self-host.md`.

7. **Projects hold videos.** Done 2026-10-02. What step 1 called a project is now a video. A
   project is a folder with `project.md` (instructions for the chat, frontmatter `title` and
   `tags`) and `videos/<video>/`, one folder per video, unchanged inside. `lib/projects.mjs` reads
   three layouts with nothing moved: a single video folder (`node server.mjs <dir>` with a
   `storyboard.json`: one project, one video, both named after the folder), a root of video
   folders (each a project with one video of the same name, `project.md` next to its
   `storyboard.json`), and the new layout. `lib/project.mjs` became `lib/video.mjs`; on disk
   nothing was renamed (`project/vN` tags, `.state/project.json`).
   Tools: every video tool takes `project` and `video`, each optional when there is one; a video
   name alone finds its project when only one project has it. New: `create_video`,
   `get_project_instructions`, `set_project_instructions` (markdown, note, model).
   `list_projects` returns each project's title, tags and videos (title, scenes, duration, poster,
   latest render), read from disk without opening the videos. `get_rules` returns the project
   instructions first, then AGENTS.md, frame.md, theme.css and the scene contract, so the chat
   sees the pronunciation rules before it writes a script or sends a voiceover. `set_project`
   and `get_project_files` are now `set_video` and `get_video_files`. Saving `project.md` is a
   version (`project/vN`) in the project's own `.history`, which leaves `videos/` out; in the two
   older layouts it goes into the video's history.
   Page: `/` is an overview when there is more than one video (project cards with tags, tag
   filter chips, a row per video with poster, duration, scene count and render date, + New video);
   `?project=x&video=y` is the viewer, whose header is a breadcrumb (All projects / project /
   video). Instructions (key `i`) opens `project.md` in a drawer with a plain monospace textarea.
   Script (key `s`) replaces the stage with every scene's narration in one column, with timecode
   and duration; clicking a scene goes back to the stage on it. "Narration" is called Script in
   the page and the tool descriptions; the stored key is still `narration`.
   Tested against a scratch root holding all three layouts (ports 4304 to 4306): the tools over
   curl, the page with agent-browser (overview, tag filter, live update when a video is created,
   breadcrumb, drawer save, script view, a comment and a render in the new layout, old
   `?project=` links, page tools with the current project and video as defaults), and `claude -p`
   over `/mcp`, which read the rules and wrote a script line that put the company name at the end
   of the sentence as `project.md` asked.

## MCP App

The review view can open inside a chat that supports MCP Apps (Claude Desktop, claude.ai). It is
a cut-down sibling of the web UI: one scene at a time with its five stills, the versions, the
comments, and a way to pin a new comment by dragging a box on a still. It also has a list of
scenes and a list of pending comments. No SDK, no build step. Spec: `specification/2026-01-26/apps.mdx`
in [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps).

What the server does (`lib/mcp.mjs`, `lib/tools.mjs`):

- `initialize` declares `resources: {}` and `extensions["io.modelcontextprotocol/ui"]` with the
  mime type. The server is stateless and doesn't remember what the client sent, so it always
  sends the UI metadata. Hosts without MCP Apps ignore it and get the normal text and images.
- `resources/list` has one resource, `ui://scene-loop/review.html`, mime type
  `text/html;profile=mcp-app`. `resources/read` returns `public/app-mcp.html` as text, read from
  disk on every call. Both carry `_meta.ui.prefersBorder: true`.
- A tool definition can name the view with `ui`. On `/mcp` that becomes
  `_meta.ui.resourceUri`, plus the older flat key `_meta["ui/resourceUri"]` that the SDK still
  writes, because hosts may read either. It is set on `show_scene`, `list_scenes` and
  `get_pending_comments`.
- `show_scene` on MCP is new: a scene (default: the first with pending comments) at a version
  (default: latest), with its versions, comments and stills as images. It is marked
  `channels: ["mcp"]`, so the page channel (`/api/tools`, WebMCP, `window.sceneLoop`) doesn't
  list it and keeps its own `show_scene` that drives the player.
- `/mcp` answers CORS for localhost origins (preflight `OPTIONS` included), because
  browser-based hosts like the ext-apps basic host call it from another port. Other origins are
  still refused.

The view (`public/app-mcp.html`) speaks JSON-RPC to `window.parent` over postMessage:
`ui/initialize` (appInfo, appCapabilities with inline and fullscreen, protocol `2026-01-26`),
then `ui/notifications/initialized`. It reads `ui/notifications/tool-input` for the `project`
argument and `ui/notifications/tool-result` for the data, and answers `ping` and
`ui/resource-teardown`. It sends `ui/notifications/size-changed` from a ResizeObserver and uses
the host's theme variables when it gets them. Everything else is a `tools/call` through the host:
`show_scene` to change scene or version, `list_scenes`, `get_pending_comments`, `add_comment`
for a pin. After a pin it sends `ui/update-model-context`, so the model knows
about the comment without a new turn starting. "Ask the chat to apply them" sends a `ui/message`.
"Open in scene-loop" is a `ui/open-link` to the full page.

**Stills and CSP.** A host runs the view in a sandboxed iframe on its own origin. The CSP comes
from `_meta.ui.csp`, and with nothing declared the default is `img-src 'self' data:` and
`connect-src 'none'`. So the view can't load `http://localhost:4300/p/...` or fetch from the
server. We declare no domains. The view never talks to the server directly: stills come as
image content in the tool result (960 px JPEGs, about 10 KB each), and it shows them as `data:`
URLs. This works the same for any host and any address, including a server behind a login. The
cost is about 50 KB per scene view, and that only reaches the model when the model made the
call itself. The view does not play the scene. Playback needs the player and the build in a
nested frame (`frameDomains`), which is exactly what hosts are strict about. "Open in
scene-loop" covers it.

**Tested 2026-10-01** with the ext-apps basic host (`examples/basic-host` cloned to /tmp,
`SERVERS='["http://localhost:4304/mcp"]' npm run start`, so a test tool and not a dependency)
against a projects root with two scratch projects. It covered: handshake, `show_scene`, the
pending list, the scene list, a scene switch, a version switch, approve (since removed), and a pin dragged on a
still. The pin showed up in `get_pending_comments` with the right region and also in the
host's model context. `ui/open-link` reached the host. With curl:
`resources/list`, `resources/read`, an unknown URI (`-32002`), and `tools/list` with the metadata
on the three tools. Through `npx mcp-remote` (the bridge Claude Desktop uses, see step 3), the
capabilities, the tool `_meta` and `resources/read` all pass through unchanged.

Not tested in Claude Desktop. Step 3 got Desktop to connect through `mcp-remote` and saw it
announce `io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`, but nothing here can
send a chat message in Desktop. By hand: add the bridge entry, restart Desktop, ask it to
"show scene s01 in scene-loop". The view should open under the tool call.

## Connecting clients

### Claude Code

```
claude mcp add --transport http scene-loop http://localhost:4300/mcp
```

Or in a `--mcp-config` file for `claude -p`:

```json
{ "mcpServers": { "scene-loop": { "type": "http", "url": "http://127.0.0.1:4300/mcp" } } }
```

Tested 2026-10-01 with `claude -p --strict-mcp-config --mcp-config ... --allowedTools "mcp__scene-loop__*"`
against a projects root with two projects: it listed projects, read the rules, created a scene,
read a pending comment with its still, rewrote the scene with `write_scene_html` and `resolves`,
and described the five frames from `get_stills`. The version on disk carries `via: mcp` and the
model name. Images arrive in the chat as JPEGs.

Gotcha when a `claude` child is started from inside bb or another Claude session: it inherits
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_*`. Unset them so it runs on the
normal login.

### Claude Desktop

Use a stdio bridge in `~/Library/Application Support/Claude/claude_desktop_config.json`.
[mcp-remote](https://www.npmjs.com/package/mcp-remote) (MIT) runs on the client side and turns
the local `/mcp` into the stdio server Desktop expects. It is not a dependency of scene-loop.

```json
{ "mcpServers": { "scene-loop": { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:4300/mcp"] } } }
```

Merge that into the existing `mcpServers` (the file holds Desktop's own preferences too), then
quit and reopen Claude Desktop. No server change was needed.

Tested 2026-10-01 with Claude Desktop 2.16120.0 on macOS, against a scratch projects root on port
4303:

- **Config file:** the `mcpServers` entries take `command`, `args` and `env` only, no `url` or
  `type: http`, so a local HTTP server needs the bridge. Plain `npx` was enough: Desktop resolved
  the login shell PATH and found npx under Herd's nvm, which is not on the default macOS PATH.
- **What Desktop sends** (`~/Library/Logs/Claude/mcp-server-<name>.log`, through the bridge):
  `initialize` with `protocolVersion: 2025-11-25`, client `claude-ai`, and the MCP Apps extension
  in capabilities (`io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`, relevant for
  step 4), then `notifications/initialized` and `tools/list`. `main.log` then says
  `Connected to scene-loop-test (21 tools)`. mcp-remote first tries OAuth discovery, finds none,
  and connects with Streamable HTTP. Our 405 on GET and the missing session id cause no trouble.
- **Stills:** `get_stills` through the same bridge returns the JSON, then a label and a JPEG per
  still (five of about 10 KB each), unchanged.
- **Not verified:** a real chat turn. Claude Desktop refuses to start with
  `--remote-debugging-port` ("a debugging or network-override switch is present"), so
  agent-browser cannot drive it, and the bb session had no screen or accessibility access for
  clicks and keystrokes. `claude://claude.ai/new?q=...` prefills a new chat but does not send it.
  Still to do by hand: ask Desktop to call `list_projects` and `get_stills` and check the frames
  show as images.

**Custom connector (Settings, Connectors, Add custom connector):** not clicked through, for the
same reason. These connectors belong to the claude.ai account and Anthropic's cloud makes the
calls, which is why claude.ai on the web and mobile can use them, so a server on `localhost` is
out of reach for them. Use the config entry above for a local server, and a custom connector only
for a public HTTPS instance with a login (step 6).

### Testing without a chat

`npx @modelcontextprotocol/inspector` can connect to `/mcp` as a Streamable HTTP server. curl
works too: POST a JSON-RPC body, every call is independent.

```
curl -s localhost:4300/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}'
```

### Your own server

See `docs/self-host.md`. Tested 2026-10-01 on the image with a scratch projects root mounted
at `/projects`: the web UI through the password (agent-browser: login, page tools over WebMCP,
a comment, logout), `claude -p` with `"headers": { "Authorization": "Bearer ..." }` in the
`--mcp-config` (rewrote a scene, read the stills from the container's Chromium), the OAuth flow
with curl (metadata, register, authorize, token, `tools/call`, refresh; wrong password, wrong
PKCE verifier, a reused code and a tampered token are refused), and a render in the container
(6 s for the 4 s template). Open localhost mode answers as before.

## Open

- Frame latency in headless Chrome on macOS varies by Chrome build (25 ms or 150 to 200 ms per
  screenshot); the renderer hides it with parallel pages. On Linux, `HeadlessExperimental.beginFrame`
  (not supported on macOS) is worth trying in the Docker image.
- Shader transitions from HyperFrames are now plain crossfades. `transitionIn.shader` is ignored.
- Render jobs live in the server process; after a restart `get_render` without a job id still
  lists finished renders from `.state/project.json`, but old job ids are gone.
- The page reloads when you switch project or video. One page is one video.
- A video folder from the older layouts can't get siblings until it is moved into
  `<project>/videos/` by hand; `create_video` says so.
- `update_scene`, `set_video` and the other storyboard writes return the storyboard version
  (`project/vN` in the video's history), which a chat can mistake for the scene's version.
- claude.ai as a custom connector against a real public hostname, and Claude Code's own OAuth
  flow (no `--header`), are not tried yet; the flow they use was walked with curl.
- Login is one password for one person. No users, no per-project access, no scopes.
- The fonts in the image are Liberation and DejaVu; `system-ui` maps to Liberation Sans. Stills
  made on a Mac and in the container won't match pixel for pixel unless scenes ship their fonts.
