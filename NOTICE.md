Required Notice: Copyright 2026 Kristian Primdal (https://github.com/kprimdal/scene-loop)

## Third-party code

None is bundled in this repo.

- At runtime the app runs Chrome (or chrome-headless-shell) and ffmpeg as separate programs.
  Pages of scenes written for the old GSAP contract load GSAP from jsDelivr. They keep their
  own licenses and terms.
- The Docker image installs Debian's Chromium, ffmpeg, git and fonts from Debian's package
  archive when it is built. They run as separate programs and keep their own licenses; none of
  them is in this repository.
