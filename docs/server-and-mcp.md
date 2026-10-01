# scene-loop as an MCP server

Decided 2026-10-01 (Kristian): scene-loop is used through an MCP connector. Claude does the creative
work on the user's own plan. Everything scene-loop does is a tool call: storing, versioning,
rendering. **We run it locally.** Anyone else, Ronni for a Zinkshoppen project included, runs their
own copy on their machine, a server or in Docker. Hosting it for other people is not the plan.

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

1. **One tool layer.** Move the tool definitions and handlers out of `public/app.js` and
   `server.mjs` into one module, used by the MCP endpoint and by the page (WebMCP and
   `window.sceneLoop`). Add multi-project: `list_projects`, `create_project`, a `project` argument
   on the rest.
2. **MCP endpoint** `/mcp` on the same Node server. Stills as image content. Render as a job:
   `render` returns a job id, `get_render` returns status and the mp4 link.
3. **Claude Desktop locally:** find the cleanest way to connect it to the local server.
4. **MCP App** (`ui://`) so the review UI can also open inside the chat.
5. **Our own renderer** instead of HyperFrames, and CSS/WAAPI instead of GSAP (see README direction).
   It sits behind `lib/stills.mjs` and the render call, so it can land before or after the MCP work
   without changing the tools.
6. **Docker image** with Node, Chrome and ffmpeg, plus login, for people who want it on a server.
