Required Notice: Copyright 2026 Kristian Primdal (https://github.com/kprimdal/scene-loop)

## Third-party code

- `public/vendor/hyperframes-player.global.js` is the HyperFrames player from
  [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) 0.8.103, Apache License 2.0.
  Its license text is in `public/vendor/LICENSE-hyperframes-player.txt`. It is not covered by the
  PolyForm license in `LICENSE.md`.
- At runtime the app loads GSAP and the HyperFrames runtime and shader transitions from jsDelivr,
  and runs `npx hyperframes` and ffmpeg as separate programs. They keep their own
  licenses and terms.
- The Docker image installs Debian's Chromium, ffmpeg, git and fonts from Debian's package
  archive and HyperFrames from npm when it is built. They run as separate programs and keep their
  own licenses; none of them is in this repository.
