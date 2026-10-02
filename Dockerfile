# scene-loop for your own server. Node 22, Chromium, ffmpeg and git on Debian slim.
#
#   docker build -t scene-loop .
#   docker run -p 127.0.0.1:4300:4300 -v ~/videos:/projects \
#     -e SCENE_LOOP_PASSWORD=... -e SCENE_LOOP_SECRET=... scene-loop
#
# The container listens on 0.0.0.0, so it always wants a login (lib/auth.mjs). Put it behind
# a reverse proxy with TLS; docs/self-host.md has the setups.
FROM node:22-bookworm-slim

# Debian's chromium rather than Google Chrome: Google ships no Linux arm64 build, and this
# image has to work on arm64 servers and Apple silicon too. CHROME_PATH points at it and
# lib/chrome.mjs drives it over CDP.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ffmpeg git ca-certificates \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# Without this, sans-serif and system-ui fall back to Liberation Mono in scenes. Scenes that
# care about their type should ship their own fonts in assets/.
RUN printf '%s\n' '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>' \
      '<alias><family>system-ui</family><prefer><family>Liberation Sans</family></prefer></alias>' \
      '<alias><family>sans-serif</family><prefer><family>Liberation Sans</family></prefer></alias>' \
      '<alias><family>serif</family><prefer><family>Liberation Serif</family></prefer></alias>' \
      '</fontconfig>' > /etc/fonts/local.conf

# No Chromium sandbox in the container: it needs user namespaces, which Docker's default
# seccomp profile blocks, so Chromium would refuse to start. The browser only ever loads the
# projects' own scenes, and the server runs as the unprivileged node user.
ENV CHROME_PATH=/usr/bin/chromium \
    CHROME_FLAGS=--no-sandbox \
    NODE_ENV=production \
    SCENE_LOOP_HOST=0.0.0.0

WORKDIR /app
COPY --chown=node:node . .

USER node

VOLUME /projects
EXPOSE 4300
CMD ["node", "server.mjs", "/projects", "--host", "0.0.0.0", "--port", "4300"]
