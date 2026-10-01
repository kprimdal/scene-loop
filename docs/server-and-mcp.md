# scene-loop on a server, used through an MCP connector

Decided 2026-10-01 (Kristian): scene-loop runs on a small server and is used through an MCP
connector. Claude does the creative work on the user's own plan. Everything that happens on the
server is a tool call: storing, versioning, rendering. Ronni will use it for a Zinkshoppen project,
so it is multi-user and multi-project from the start.

## Shape

```
Claude (claude.ai, desktop, mobile, Claude Code)          ChatGPT, M365 Copilot later
        │  MCP over HTTPS (Streamable HTTP + OAuth)
        ▼
scene-loop server (Hetzner)
  /mcp          tools: projects, scenes, comments, stills, render, approve
  /             web review UI: filmstrip, player, pinned comments, versions
  ui://…        MCP App: the same review UI inside the Claude chat (phase 3)
  renderer      headless Chrome + ffmpeg on the box
  /srv/scene-loop/projects/<project>/   one folder and one version history per project
```

- **The server never calls a model and holds no AI keys.** Same rule as today.
- **Stills come back as images in tool results,** so Claude sees its own work in the chat without a
  browser.
- **The web UI stays** for the human side: pinning comments on a frame, comparing, approving,
  watching the whole video. Comments made there show up for Claude through `get_pending_comments`.
- **Which Claude clients:** a remote connector added once on claude.ai follows the user to the
  desktop and mobile apps. Claude Code adds it with `claude mcp add --transport http`. Connectors
  are called from Anthropic's cloud, so `/mcp` must be reachable on the public internet with our
  own login in front, not only on the tailnet.

## Accounts and access

- Login for both the connector (OAuth, which Claude's custom connectors expect) and the web UI.
- An allowlist to start: Kristian and Ronni.
- Projects belong to an owner and can be shared. Ronni's Zinkshoppen project is his; ours are ours.
- Client material lives only on the server, never in this public repo.

## Build order

1. **One tool layer.** Move the tool definitions and handlers out of `public/app.js` and
   `server.mjs` into one module, used by the MCP endpoint and by the page (WebMCP and
   `window.sceneLoop`). Add multi-project: `list_projects`, `create_project`, a `project` argument
   on the rest.
2. **MCP endpoint** `/mcp` on the same Node server. Stills as image content. Render as a job:
   `render` returns a job id, `get_render` returns status and the mp4 link.
3. **Login:** OAuth for the connector, a session for the web UI, the allowlist.
4. **Server:** a Docker image with Node, Chrome and ffmpeg. HTTPS through a Cloudflare tunnel. Daily
   backup of `/srv/scene-loop`.
5. **MCP App** (`ui://`) so the review UI can also open inside the chat.
6. **Our own renderer** instead of HyperFrames, and CSS/WAAPI instead of GSAP (see README direction).
   It sits behind `lib/stills.mjs` and the render call, so it can land before or after the server
   work without changing the tools.

Steps 1 to 3 can be built and tested on a Mac against Claude Code (`claude mcp add` to
`localhost`). Steps 4 onwards need the server.

## Open questions

- New small Hetzner box, or a lane on an existing box? A public endpoint with client projects argues
  for its own box.
- Domain, e.g. `scenes.primux.app`.
- Login method: GitHub, Google or email link.
