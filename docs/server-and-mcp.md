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
  ui://…        MCP App: the same review UI inside the Claude chat (phase 3)
  renderer      headless Chrome + ffmpeg on the box
  projects/<project>/   one folder and one version history per project
```

- **The server never calls a model and holds no AI keys.** Same rule as today.
- **Stills come back as images in tool results,** so Claude sees its own work in the chat without a
  browser.
- **The web UI stays** for the human side: pinning comments on a frame, comparing, approving,
  watching the whole video. Comments made there show up for Claude through `get_pending_comments`.
- **Which Claude clients:** locally, Claude Code adds it with
  `claude mcp add --transport http scene-loop http://localhost:4300/mcp`, and Claude Desktop reaches
  it through a stdio bridge (`npx -y mcp-remote http://localhost:4300/mcp`) in its config file.
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
3. **Claude Desktop locally.** Done 2026-10-01: an `mcp-remote` stdio bridge in
   `claude_desktop_config.json`, no server change. See Connecting clients.
4. **MCP App** (`ui://`) so the review UI can also open inside the chat.
5. **Our own renderer** instead of HyperFrames, and CSS/WAAPI instead of GSAP (see README direction).
   It sits behind `lib/stills.mjs` and the render call, so it can land before or after the MCP work
   without changing the tools.
6. **Docker image** with Node, Chrome and ffmpeg, plus login, for people who want it on a server.

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

## Open

- Render progress stayed at 0% until done in the test: `hyperframes render --quiet` printed no percentages
  that the parser recognises. The job still finishes and reports the file.
- Render jobs live in the server process; after a restart `get_render` without a job id still
  lists finished renders from `.state/project.json`, but old job ids are gone.
- The page reloads when you switch project. One page is one project.
