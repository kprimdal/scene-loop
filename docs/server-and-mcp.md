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
  /mcp          tools: projects, scenes, comments, stills, render, approve
  /             web review UI: filmstrip, player, pinned comments, versions
  ui://…        MCP App: a cut-down review view inside the Claude chat
  renderer      headless Chrome + ffmpeg on the box
  projects/<project>/   one folder and one version history per project
```

- **The server never calls a model and holds no AI keys.** Same rule as today.
- **Stills come back as images in tool results,** so Claude sees its own work in the chat without a
  browser.
- **The web UI stays** for the human side: pinning comments on a frame, comparing, approving,
  watching the whole video. Comments made there show up for Claude through `get_pending_comments`.
- **Which Claude clients:** locally, Claude Code adds it with
  `claude mcp add --transport http scene-loop http://localhost:4300/mcp`, and Claude Desktop can
  reach a local server too (to be tested: its own local-server config, or a small stdio bridge).
  claude.ai on the web and mobile call connectors from Anthropic's cloud, so they only work when
  someone runs scene-loop on a public server with a login in front.

## Projects and access

- Several projects per instance: `list_projects`, `create_project`, and a `project` argument on the
  other tools. One folder and one version history per project under a projects directory.
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
3. **Claude Desktop locally:** find the cleanest way to connect it to the local server.
4. **MCP App** (`ui://`) so the review UI can also open inside the chat. Done 2026-10-01,
   hand-rolled against the ext-apps spec 2026-01-26 without the SDK. See "MCP App" below.
5. **Our own renderer** instead of HyperFrames, and CSS/WAAPI instead of GSAP (see README direction).
   It sits behind `lib/stills.mjs` and the render call, so it can land before or after the MCP work
   without changing the tools.
6. **Docker image** with Node, Chrome and ffmpeg, plus login, for people who want it on a server.

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
for a pin, `approve_version`. After a pin it sends `ui/update-model-context`, so the model knows
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
pending list, the scene list, a scene switch, a version switch, approve, and a pin dragged on a
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

Not tested yet. Two routes to try, in this order: a custom connector pointing at
`http://localhost:4300/mcp` (Settings, Connectors, Add custom connector), and if it insists on
HTTPS or OAuth, a stdio bridge in `claude_desktop_config.json` such as
`npx mcp-remote http://localhost:4300/mcp`. The bridge is a client-side tool, not a dependency of
scene-loop.

### Testing without a chat

`npx @modelcontextprotocol/inspector` can connect to `/mcp` as a Streamable HTTP server. curl
works too: POST a JSON-RPC body, every call is independent.

```
curl -s localhost:4300/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}'
```

## Open

- Render progress stayed at 0% until done in the test: `hyperframes render --quiet` printed no percentages
  that the parser recognises. The job still finishes and reports the file.
- Render jobs live in the server process; after a restart `get_render` without a job id still
  lists finished renders from `.state/project.json`, but old job ids are gone.
- The page reloads when you switch project. One page is one project.
