# A render worker on a faster computer

A server on a small VPS renders slowly; the laptop next to it is often several times faster but
not always awake. `worker.mjs` runs on that laptop and renders scene clips for the server. A render
checks the worker's `/health` (1.5 s timeout) when it starts. If it answers, the worker renders
every clip it may (longest first), and the server only the scenes that must stay on it (see Fonts)
and whatever the worker leaves if it drops out. If it does not answer, the server renders
everything itself, as it always has.

What crosses the network is files and finished clips, never frames:

1. The server sends the list of files the scenes use (everything under `assets/` and `scenes/`,
   narration excepted, and files over 25 MB only when a page names them). The worker keeps a
   mirror per video and asks only for what changed since the last render.
2. Per clip, the server sends the assembled scene page. The worker renders it with the same code
   (`lib/render.mjs`, its own Chrome and ffmpeg) and sends back the mp4, which lands in the
   server's clip cache like any other.

A clip that fails on the worker is rendered on the server, and the worker gets no more clips in
that render. The worker writes a line every second while it renders, so a laptop that goes to
sleep mid-clip is noticed after 20 s. The render's `get_render` shows `worker` (where it went,
what was synced, the error if it dropped out) and `clips.remote`.

## The worker

```
SCENE_LOOP_TOKEN=<token> node worker.mjs --port 4310 --host 0.0.0.0
```

| | |
| --- | --- |
| `SCENE_LOOP_TOKEN` (or `SCENE_LOOP_WORKER_TOKEN`) | Bearer token for everything but `/health`. Required unless `--host` is loopback. |
| `--port` | 4310 by default. |
| `--host` (`SCENE_LOOP_WORKER_HOST`) | `0.0.0.0` by default. Keep it on a private network (Tailscale); the token is the only lock. |
| `--dir` (`SCENE_LOOP_WORKER_DIR`) | The mirrors, `~/.cache/scene-loop/worker` by default. Safe to delete. |
| `SCENE_LOOP_PARALLEL` | Chrome pages, as on the server. |

It needs Node 22, ffmpeg and Chrome on the machine, found the same way as on the server
(`chrome-headless-shell` first). On a Mac it holds `caffeinate -i` while a clip renders, so the
Mac does not idle-sleep under it and sleeps as usual the rest of the time. Run it from launchd so
it starts at login, through `bin/scene-loop-worker`: it finds node itself (nvm's default version,
or PATH), so switching node versions does not break the plist, and it pulls main first when the
checkout is a clean main, so a restart picks up a new worker.

```xml
<!-- ~/Library/LaunchAgents/app.scene-loop.worker.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>app.scene-loop.worker</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>/path/to/scene-loop/bin/scene-loop-worker</string>
    <string>--port</string><string>4310</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>SCENE_LOOP_TOKEN</key><string>...</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/scene-loop-worker.log</string>
  <key>StandardErrorPath</key><string>/tmp/scene-loop-worker.log</string>
</dict></plist>
```

Closing the lid still sleeps the Mac mid-clip; the server notices within 20 s and takes over.

## The server

```
SCENE_LOOP_WORKERS=http://my-laptop:4310   # several, comma separated: the first that answers
SCENE_LOOP_TOKEN=<token>                   # or SCENE_LOOP_WORKER_TOKEN, sent as the bearer
```

Stills for versions and comments always render on the server: they are small and someone is
waiting for them.

## Fonts

Chrome on macOS and on Linux draw installed fonts differently, and `system-ui` is a different
font altogether (DejaVu Sans on a Linux server, SF Pro on a Mac). Fonts loaded from a file with
`@font-face` come out the same on both: same layout and letterforms, only the antialiasing
differs. So fonts belong in `assets/fonts`, declared in `theme.css`.

The stills check every version: Chrome reports which fonts drew each element's text, and text in
an installed font is listed as `systemFonts` in `get_stills` and `list_scenes`. A render keeps
those scenes on the server and only sends the worker scenes whose text all comes from files, so a
video never mixes the two machines' fonts. (A version made before the check gets it at its first
render with a worker awake.)
