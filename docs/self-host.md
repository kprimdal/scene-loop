# Run scene-loop on your own server

For people who want scene-loop somewhere other than their own machine: a VPS, a box at home, a
server at work. Nobody hosts it for you, and we don't either. On your own Mac or PC you don't
need any of this: `node server.mjs ~/videos` listens on localhost with no login.

## The image

```
docker build -t scene-loop .
```

Debian slim with Node 22, Debian's Chromium, ffmpeg, git and fonts, and the app in `/app`.
Debian's Chromium rather than Google Chrome because Google ships no Linux build for arm64.
`CHROME_PATH` points at it; set it to use another browser. The image runs Chromium with
`--no-sandbox` (through `CHROME_FLAGS`): its sandbox needs user namespaces, which Docker's default
seccomp profile blocks. The browser only loads the projects' own scenes, as the unprivileged node
user. If you run the container with a seccomp profile that allows user namespaces, set
`CHROME_FLAGS=` to get the sandbox back.

Measured 2026-10-01 on an M-series Mac (arm64, Docker Desktop 28) with the base image already
pulled, when the image still fetched HyperFrames (215 MB, since removed): about 60 seconds from
scratch, 540 MB compressed, about 1.45 GB unpacked. Chromium, ffmpeg and fonts are most of it.

Scenes written for the old GSAP contract load GSAP from jsDelivr at render time; CSS scenes need
no network.

## Run it

`docker-compose.yml` is the example. Next to it, a `.env`:

```
SCENE_LOOP_PASSWORD=a long password
SCENE_LOOP_SECRET=<openssl rand -hex 32>
SCENE_LOOP_TOKEN=<openssl rand -hex 32>
SCENE_LOOP_URL=https://video.example.com
```

```
mkdir projects && docker compose up -d --build
```

The container runs as the `node` user (uid 1000). On Linux, `chown 1000:1000 projects` first.
Without compose:

```
docker run -d --name scene-loop --shm-size 1g -p 127.0.0.1:4300:4300 -v $PWD/projects:/projects \
  --env-file .env scene-loop
```

## Login

The container listens on `0.0.0.0`, and scene-loop refuses to start on anything but loopback
without a login. Outside Docker it's the same: `--host 0.0.0.0` needs `SCENE_LOOP_PASSWORD`.
`--no-login` overrides that, for a container you only publish on 127.0.0.1 and use alone.

| Setting | What it does |
| --- | --- |
| `SCENE_LOOP_PASSWORD` or `--password` | Turns the login on. The web UI asks for it; the OAuth flow asks for it before a connector gets a token. |
| `SCENE_LOOP_SECRET` | Signs sessions, client ids, codes and tokens. Without it a random one is made at start and everyone is logged out on restart. |
| `SCENE_LOOP_TOKEN` | A fixed bearer token for `/mcp`, for Claude Code. Optional. |
| `SCENE_LOOP_URL` or `--url` | The public URL. Without it, scene-loop works it out from `X-Forwarded-Proto`, `X-Forwarded-Host` and `Host`. |

Changing the password or the secret logs everyone out and invalidates every token, except
`SCENE_LOOP_TOKEN`. Nothing is stored: there's no user table and no token database.

Also behind a proxy on the same machine: scene-loop then listens on 127.0.0.1 but is reachable
from outside, so set the password there too. Without one it refuses any request that carries
`X-Forwarded-For`, `Forwarded`, `X-Real-IP` or `CF-Connecting-IP`.

## Connect a chat

**Claude Code**, with the fixed token:

```
claude mcp add --transport http scene-loop https://video.example.com/mcp \
  --header "Authorization: Bearer $SCENE_LOOP_TOKEN"
```

Or leave the header out and let Claude Code run the OAuth flow, which opens the scene-loop login
in your browser. Not tried yet.

**claude.ai** (web, desktop, mobile): Settings, Connectors, Add custom connector, URL
`https://video.example.com/mcp`, no client id. claude.ai finds the login on its own, you enter
the password, press Allow, and you're back in the chat. The connection lasts as long as the
secret and password don't change (access tokens last an hour and refresh for 30 days).
Walked with curl against the Docker image on 2026-10-01, the way claude.ai does it (its redirect
URI, dynamic registration, PKCE, `resource`); not yet with claude.ai itself, which needs a public
HTTPS hostname.

What scene-loop implements of the MCP authorization spec:

- `401` on `/mcp` with `WWW-Authenticate: Bearer resource_metadata=...`
- `/.well-known/oauth-protected-resource` (and `/mcp` after it): Protected Resource Metadata
- `/.well-known/oauth-authorization-server`: Authorization Server Metadata, scene-loop is its
  own authorization server
- client ID metadata documents (an https URL as `client_id`) and dynamic client registration at
  `/register`
- `/authorize` with PKCE S256 only, the `resource` parameter, `iss` in the redirect
- `/token` with `authorization_code` and `refresh_token`

There are no scopes: a token can use every tool on every project in this instance.

## A reverse proxy with TLS

scene-loop speaks plain HTTP. Put something with TLS in front; claude.ai only connects over
HTTPS.

**Caddy** (gets the certificate itself):

```
video.example.com {
    reverse_proxy 127.0.0.1:4300
}
```

**nginx**:

```
server {
    listen 443 ssl;
    server_name video.example.com;
    # ssl_certificate ... (certbot)
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_buffering off;          # the page's live events (/api/events)
        proxy_read_timeout 1h;
    }
}
```

**Cloudflare Tunnel**, when the box has no public IP:

```
cloudflared tunnel create scene-loop
cloudflared tunnel route dns scene-loop video.example.com
# ~/.cloudflared/config.yml
#   tunnel: scene-loop
#   ingress:
#     - hostname: video.example.com
#       service: http://localhost:4300
#     - service: http_status:404
cloudflared tunnel run scene-loop
```

Set `SCENE_LOOP_URL=https://video.example.com` in all three cases, so the OAuth metadata names
the right address whatever the proxy sends.

Cloudflare Access in front of the tunnel works for the web UI but stops claude.ai, which can't
pass Access's login. Use scene-loop's own login, or exempt `/mcp`, `/.well-known/*`,
`/register`, `/authorize` and `/token`.
