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
without a login. Outside Docker it's the same: `--host 0.0.0.0` needs people on the list or
`SCENE_LOOP_PASSWORD`. `--no-login` overrides that, for a container you only publish on 127.0.0.1
and use alone, as long as nobody with an email is on the people list.

### People

Everyone who may use the server is on its people list, `<projects root>/.people.json` (mode
0600, next to the projects; back it up with them). Nobody edits it by hand: the first owner comes
from the command line, everyone else from the People page.

```
node server.mjs ~/videos --invite-owner you@example.com You --url https://video.example.com
docker compose exec scene-loop node server.mjs /projects --invite-owner you@example.com You
```

That prints a one-time link, valid for seven days. Open it, choose a password (12 characters or
more), add the key it shows to an authenticator app (1Password, Google Authenticator, Apple
Passwords) and type the app's code. From then on you log in with email, password and a fresh
code. Run it as the user the server runs as, so the file stays theirs; a running server picks the
change up within seconds.

On **People** (`/people`, owners only) you add someone with a name, an email, a role and the
projects they may see. The page shows their invite link; send it yourself, scene-loop sends no
email. They open it, choose a password, and land on their project. From the same page: a new
link (a forgotten password, or a new authenticator for an owner), other projects, owner or
commenter, log out everywhere, unlock after too many wrong passwords, agent tokens, remove.
Removing someone, or taking a project away, ends their sessions and live updates at once.
**Account** (`/account`) is everyone's own page: change the password, log out everywhere, and
for owners their agent tokens.

| Role | What they reach |
| --- | --- |
| owner | Every project, People, the page's agent tools, renders, restores, deletes, instructions, `/mcp` with their own tokens or the OAuth flow. Logs in with an authenticator code. |
| commenter | Only the projects they were given: the overview, the player, the script read-only, the versions, and their own comments (add, and remove their own). No `/mcp`, no agent tools, renders, restores, deletes or instructions. |

Comments carry `by` (the name) and `byId` (the person), so the chat sees who wrote each one in
`get_pending_comments`. An agent that comes in with a person's token or OAuth login has its writes
labelled with the name (`claude (Anna)` on the version, in the activity log and the history).

Sessions last 30 days, 7 for owners. A wrong password counts against the address (30 an hour),
against the email from that address (5 in 15 minutes) and against the account (20 lock it for an
hour, then two, four and so on, until an owner unlocks it). Behind a proxy on the same machine
every request comes from 127.0.0.1, so tell scene-loop which header carries the real address
(`SCENE_LOOP_TRUST_PROXY`). Writes from another site are refused, with or without a login.

| Setting | What it does |
| --- | --- |
| `SCENE_LOOP_SECRET` | Signs sessions, client ids, codes and tokens. Without it, the people file holds one of its own, so a restart keeps everyone logged in. |
| `SCENE_LOOP_URL` or `--url` | The public URL, used in invite links and the OAuth metadata. Without it, scene-loop works it out from `X-Forwarded-Proto`, `X-Forwarded-Host` and `Host`. |
| `SCENE_LOOP_TRUST_PROXY` | `cloudflare` (the address in `CF-Connecting-IP`, for cloudflared) or `x-forwarded-for` (its last entry, for nginx or Caddy). Only read for requests that come from loopback. |
| `SCENE_LOOP_TOKEN` | A fixed bearer token for `/mcp` with an owner's reach and no name, for a machine (`--header "Authorization: Bearer …"`). Optional. With `--no-login` and nobody on the list it is the only check: the page stays open, `/mcp` wants the token. That is the setting for a private network such as a tailnet. |
| `SCENE_LOOP_PASSWORD` or `--password` | The older shared login, an owner without a name. It works until the first owner has finished their invite, and then no more. Leave the email empty on the login page. |

Older settings move into the people file once, on the first start without one:
`SCENE_LOOP_TOKENS` (`Name=token`) become owners holding those tokens, `SCENE_LOOP_SHARE_PEOPLE`
(`email=Name`) commenters on `SCENE_LOOP_SHARE_PROJECTS`; the same name in both is one owner with
the email. Nobody gets a password that way: send each a link from People. After that the old
settings are ignored, with a warning, and `SCENE_LOOP_SHARE_PORT` opens nothing.

Without people, a proxy on the same machine makes scene-loop listen on 127.0.0.1 but be reachable
from outside. It then refuses any request that carries `X-Forwarded-For`, `Forwarded`,
`X-Real-IP` or `CF-Connecting-IP`, unless `--no-login` or a token is set.

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
your email, password and code, press Allow, and you're back in the chat. Only owners can.
The connection lasts until you log out everywhere or are removed (access tokens last an hour and refresh for 30 days).
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

Set `SCENE_LOOP_URL=https://video.example.com` in all three cases, so invite links and the OAuth
metadata name the right address whatever the proxy sends, and `SCENE_LOOP_TRUST_PROXY`
(`cloudflare` for the tunnel, `x-forwarded-for` for nginx and Caddy) so the failed-login counters
see real addresses.

scene-loop's own login is meant to be the only lock on the hostname. Cloudflare Access in front
also works for the web UI, but it stops claude.ai, which can't pass Access's login, and every
person then has to be on two lists.
