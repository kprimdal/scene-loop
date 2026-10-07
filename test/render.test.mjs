import { test } from "node:test";
import assert from "node:assert/strict";
import { frameSpan, frameCount } from "../lib/render.mjs";
import { stretches, compositeArgs } from "../lib/composite.mjs";

test("frameSpan puts scenes on one frame grid with no drift", () => {
  const fps = 30;
  const scenes = [[0, 4.37], [4.37, 3.01], [7.38, 5.555]];
  const total = scenes.reduce((a, [, d]) => a + frameCount(d, fps, a / fps * 0 + 0), 0);
  assert.equal(scenes.reduce((a, [s, d]) => a + frameSpan(s, d, fps).frames, 0), Math.round((7.38 + 5.555) * fps));
  assert.ok(total > 0);
});

test("stretches: live around animation windows with a frame of margin, static between, short statics folded into live", () => {
  const fps = 30, n = 300;
  const t = (i) => i / fps;
  const runs = stretches(n, t, [[1, 1.8], [5, 5.6]], fps);
  assert.deepEqual(runs.map((r) => r.live), [false, true, false, true, false]);
  assert.equal(runs[0].to, 29); // 1 s minus one frame of margin
  assert.equal(runs[1].from, 29);
  assert.equal(runs[1].to, 56); // 1.8 s plus margin, exclusive
  assert.equal(runs.at(-1).to, n);
  assert.equal(runs.reduce((a, r) => a + r.to - r.from, 0), n);
  // a static gap of a few frames is not worth its captures
  assert.deepEqual(stretches(100, t, [[1, 1.1], [1.2, 1.3]], fps).map((r) => r.live), [false, true, false]);
  // no windows: one static run; everything live when the window covers all
  assert.deepEqual(stretches(100, t, [], fps), [{ from: 0, to: 100, live: false }]);
  assert.deepEqual(stretches(100, t, [[0, 10]], fps), [{ from: 0, to: 100, live: true }]);
});

test("compositeArgs: one input pair per on-screen video, loop and end-of-video handled, colour signalling fixed", () => {
  const videos = [
    { src: "file:///tmp/a.mp4", mediaStart: 40, loop: false, fit: "cover", duration: 120 },
    { src: "file:///tmp/b.mp4", mediaStart: 0, loop: true, fit: "contain", duration: 10 },
    { src: "file:///tmp/c.mp4", mediaStart: 0, loop: false, fit: "fill", duration: 120 },
  ];
  const c = compositeArgs({ bg: "bg.png", whites: ["w0.png", "w1.png", "w2.png"], rects: [{ x: 1552, y: 852, w: 320, h: 180 }, { x: 640, y: 200, w: 640, h: 360 }, { x: 5000, y: 0, w: 10, h: 10 }] }, videos, { t0: 12, frames: 300, fps: 30, width: 1920, height: 1080 });
  const inputs = c.inputs.filter((a, i) => c.inputs[i - 1] === "-i");
  assert.deepEqual(inputs, ["bg.png", "w0.png", "/tmp/a.mp4", "w1.png", "/tmp/b.mp4"]); // the off-screen video is left out
  assert.ok(c.inputs.includes("-stream_loop"), "a looping video loops");
  const ss = c.inputs.filter((a, i) => c.inputs[i - 1] === "-ss").map(Number);
  assert.ok(Math.abs(ss[0] - (52 - 0.25 / 30)) < 1e-3, `webcam starts at mediaStart + t0: ${ss[0]}`);
  assert.ok(Math.abs(ss[1] - (2 - 0.25 / 30)) < 1e-3, `loop wraps: ${ss[1]}`);
  assert.match(c.filter, /scale=320:180:force_original_aspect_ratio=increase,crop=320:180/);
  assert.match(c.filter, /force_original_aspect_ratio=decrease,pad=640:360/);
  assert.match(c.filter, /overlay=1552:852:format=gbrp/);
  assert.match(c.filter, /out_range=pc:out_color_matrix=bt601,format=yuv420p\[out\]$/);
  assert.equal(c.map, "[out]");
  // a video that has ended holds its last frame
  const ended = compositeArgs({ bg: "bg.png", whites: ["w.png"], rects: [{ x: 0, y: 0, w: 100, h: 100 }] }, [{ src: "file:///tmp/a.mp4", mediaStart: 0, loop: false, fit: "fill", duration: 5 }], { t0: 20, frames: 30, fps: 30, width: 1920, height: 1080 });
  assert.ok(Number(ended.inputs[ended.inputs.indexOf("-ss") + 1]) < 5);
});
