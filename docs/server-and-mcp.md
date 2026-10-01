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
4. **MCP App** (`ui://`) so the review UI can also open inside the chat.
5. **Our own renderer** instead of HyperFrames, and CSS/WAAPI instead of GSAP (see README direction).
   It sits behind `lib/stills.mjs` and the render call, so it can land before or after the MCP work
   without changing the tools.
6. **Docker image and login.** Done 2026-10-01. `Dockerfile` (Debian slim, Node 22, Debian's
   Chromium, ffmpeg, git, fonts, HyperFrames pre-fetched) and `docker-compose.yml`; about 60 s
   to build, 540 MB compressed. `--host` (default 127.0.0.1); any other host refuses to start
   without `SCENE_LOOP_PASSWORD` unless `--no-login`. `lib/auth.mjs`, hand-rolled: a login page
   and signed session cookie for the web UI, `SCENE_LOOP_TOKEN` as a fixed bearer for Claude
   Code, and the MCP OAuth flow for claude.ai connectors (Protected Resource Metadata,
   Authorization Server Metadata, client ID metadata documents and dynamic registration,
   `/authorize` with PKCE S256 behind the same password, `/token` with refresh). Everything is
   a signed value, so nothing is stored. One `auth.gate(req, res)` call in `server.mjs`; `mcp.mjs`
   skips its localhost Origin check when the request carried a token. `CHROME_PATH` is passed
   to HyperFrames as `HYPERFRAMES_BROWSER_PATH`. Setup and proxies: `docs/self-host.md`.

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

### Your own server

See `docs/self-host.md`. Tested 2026-10-01 on the image with a scratch projects root mounted
at `/projects`: the web UI through the password (agent-browser: login, page tools over WebMCP,
a comment, logout), `claude -p` with `"headers": { "Authorization": "Bearer ..." }` in the
`--mcp-config` (rewrote a scene, read the stills from the container's Chromium), the OAuth flow
with curl (metadata, register, authorize, token, `tools/call`, refresh; wrong password, wrong
PKCE verifier, a reused code and a tampered token are refused), and a render in the container
(6 s for the 4 s template). Open localhost mode answers as before.

## Open

- Render progress stayed at 0% until done in the test: `hyperframes render --quiet` printed no percentages
  that the parser recognises. The job still finishes and reports the file.
- Render jobs live in the server process; after a restart `get_render` without a job id still
  lists finished renders from `.state/project.json`, but old job ids are gone.
- The page reloads when you switch project. One page is one project.
- claude.ai as a custom connector against a real public hostname, and Claude Code's own OAuth
  flow (no `--header`), are not tried yet; the flow they use was walked with curl.
- Login is one password for one person. No users, no per-project access, no scopes.
- The fonts in the image are Liberation and DejaVu; `system-ui` maps to Liberation Sans. Stills
  made on a Mac and in the container won't match pixel for pixel unless scenes ship their fonts.
