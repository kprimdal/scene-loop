// Takes: the reviewer reads a scene's narration to camera in the Record view, and each
// recording is kept under assets/takes/<scene>/<n>.<ext>. The media side lives here (ffmpeg as
// a separate program): find where the speech is, cut the narration audio from it, and cut the
// camera clip whose t=0 is the scene's t=0. lib/video.mjs keeps takes.json and the choice.
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

// Padding around the detected speech in the narration cut: a soft first consonant starts under
// the threshold, a last word fades out under it.
export const SPEECH_PAD = { before: 0.08, after: 0.2 };

function run(program, args, { stdout = "string" } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0) return fail(new Error(`${program}: ${err.trim().slice(-600) || `exit ${code}`}`));
      const buf = Buffer.concat(out);
      done({ stdout: stdout === "buffer" ? buf : buf.toString(), stderr: err });
    });
  });
}

const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

// Levels of the take's audio in 20 ms windows: the room's floor (5th percentile) and the
// speech level (95th). Digital silence (the first frames of a recording) is left out.
export function levels(samples, rate) {
  const win = Math.round(rate * 0.02), dbs = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += samples[j] * samples[j];
    const db = 10 * Math.log10(sum / win + 1e-12);
    if (db > -100) dbs.push(db);
  }
  dbs.sort((a, b) => a - b);
  if (!dbs.length) return { floorDb: null, peakDb: null };
  return { floorDb: r3(pct(dbs, 0.05)), peakDb: r3(pct(dbs, 0.95)) };
}

// The silence threshold between the two: a third of the way up from the floor, at least 8 dB
// over it (a noisy room) and at most 20 (a quiet one, where breaths and mouth noise sit
// between the floor and the voice).
export function threshold({ floorDb, peakDb }) {
  if (floorDb == null) return -50;
  return r3(floorDb + Math.max(8, Math.min(20, (peakDb - floorDb) * 0.35)));
}

// silencedetect's output -> silences [{ start, end }].
export function parseSilences(stderr, seconds) {
  const out = [];
  let open = null;
  for (const line of stderr.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (s) open = Math.max(0, Number(s[1]));
    if (e && open != null) (out.push({ start: open, end: Number(e[1]) }), (open = null));
  }
  if (open != null) out.push({ start: open, end: seconds });
  return out;
}

// From silences to the speech range: the stretches between silences are sound; those shorter
// than minSound (the space bar that stopped the take, a click) are not speech. null when
// nothing is left.
export function speechRange(silences, seconds, { minSound = 0.15 } = {}) {
  const sounds = [];
  let t = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start > t) sounds.push({ start: t, end: s.start });
    t = Math.max(t, s.end);
  }
  if (t < seconds) sounds.push({ start: t, end: seconds });
  const speech = sounds.filter((s) => s.end - s.start >= minSound);
  if (!speech.length) return null;
  return { start: r3(speech[0].start), end: r3(speech.at(-1).end) };
}

export async function probe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,r_frame_rate", "-of", "json", file]);
  const streams = JSON.parse(stdout).streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const rate = (s) => { const [a, b = 1] = String(s ?? "0/0").split("/").map(Number); return b ? a / b : 0; };
  return { hasVideo: !!v, hasAudio: streams.some((s) => s.codec_type === "audio"), width: v?.width ?? null, height: v?.height ?? null, fps: v ? r3(rate(v.avg_frame_rate) || rate(v.r_frame_rate)) : null };
}

// Everything list_takes shows about a fresh take. Two passes over the audio only: the levels,
// then silencedetect at the threshold they give.
export async function analyzeTake(file) {
  const info = await probe(file);
  if (!info.hasAudio) throw new Error("the take has no audio");
  const rate = 16000;
  const { stdout } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-af", "highpass=f=80", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { stdout: "buffer" });
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
  const seconds = r3(samples.length / rate);
  const level = levels(samples, rate);
  const thresholdDb = threshold(level);
  const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-i", file, "-vn", "-af", `highpass=f=80,silencedetect=n=${thresholdDb}dB:d=0.3`, "-f", "null", "-"]);
  const speech = speechRange(parseSilences(stderr, seconds), seconds);
  return { seconds, ...info, speech: speech && { ...speech, auto: true }, level: { ...level, thresholdDb } };
}

// The audio range a take's narration is cut from: the speech plus its padding.
export const cutRange = (speech, seconds) => ({ from: r3(Math.max(0, speech.start - SPEECH_PAD.before)), to: r3(Math.min(seconds, speech.end + SPEECH_PAD.after)) });

// afftdn works on FFT blocks and its output lags its input (25 ms in ffmpeg 8, at 48 kHz). The
// lag is measured once, with a click through the same filter, and cut off again, so the
// narration's words sit where they were spoken and line up with the camera clip.
const DENOISE = (nf) => `highpass=f=80,afftdn=nr=10:nf=${nf}:tn=1`;
let denoiseLag = null;
function denoiseLatency() {
  denoiseLag ??= run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "aevalsrc='if(between(t,0.5,0.5004),0.8,0)':s=48000:d=1", "-af", DENOISE(-60), "-f", "f32le", "-"], { stdout: "buffer" }).then(({ stdout }) => {
    const x = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
    let at = 0;
    for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[at])) at = i;
    return Math.max(0, Math.round(at - 0.5 * 48000)) / 48000;
  });
  denoiseLag.catch(() => (denoiseLag = null));
  return denoiseLag;
}

// The narration: that range of the take, mono 48 kHz, with the rumble cut (highpass 80 Hz) and
// a gentle denoise against the room's own floor. No loudness change: build_soundtrack
// normalises the whole voice.
export async function cutNarration(file, { from, to, floorDb }, out) {
  const nf = Math.max(-80, Math.min(-20, Math.round(floorDb ?? -60)));
  const lag = await denoiseLatency();
  const d = to - from;
  mkdirSync(dirname(out), { recursive: true });
  await run("ffmpeg", ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", file, "-vn",
    "-af", `atrim=start=${from}:end=${r3(to + lag)},asetpts=PTS-STARTPTS,aresample=48000,apad=pad_dur=${lag},${DENOISE(nf)},atrim=start=${lag},asetpts=PTS-STARTPTS,atrim=duration=${r3(d)},afade=t=in:d=0.015,afade=t=out:st=${r3(Math.max(0, d - 0.04))}:d=0.04`,
    "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out]);
  return out;
}

// The camera clip: take seconds t0 .. t0 + duration as a muted, constant-rate H.264 clip at the
// video's size (scaled to cover it, centre crop), so its t=0 is the scene's t=0. Where the
// take has no footage (t0 before its start, or past its end) the first or last frame holds.
export async function cutCam(file, { t0, duration, fps, width, height }, out) {
  const frames = Math.max(1, Math.round(duration * fps));
  const filter = [
    `setpts=PTS-(${r3(t0)})/TB`,
    `fps=fps=${fps}:start_time=0`,
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    `tpad=stop_mode=clone:stop_duration=${r3(duration + 1)}`,
    `trim=end_frame=${frames}`,
    "format=yuv420p",
  ].join(",");
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.part-${process.pid}-${Date.now()}.mp4`;
  try {
    await run("ffmpeg", ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", file, "-an", "-vf", filter, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps), "-fps_mode", "cfr", "-frames:v", String(frames), "-movflags", "+faststart", tmp]);
    renameSync(tmp, out);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { file: out, frames, seconds: r3(frames / fps) };
}
