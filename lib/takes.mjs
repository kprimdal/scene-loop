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

// The take's audio as RMS levels in 20 ms windows (dB).
export const WINDOW = 0.02;
export function windowsDb(samples, rate) {
  const win = Math.round(rate * WINDOW), dbs = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += samples[j] * samples[j];
    dbs.push(10 * Math.log10(sum / win + 1e-12));
  }
  return dbs;
}

// The room's floor (5th percentile of the windows) and the speech level (95th). The first
// 0.3 s (a recorder settling) and digital silence are left out.
export function levels(samples, rate) {
  const dbs = windowsDb(samples, rate).slice(Math.round(0.3 / WINDOW)).filter((db) => db > -100).sort((a, b) => a - b);
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

// Silences: runs of windows under the threshold that last at least min seconds. Measured on
// the same RMS windows as the threshold. ffmpeg's silencedetect compares sample peaks, which
// in a real room (Kristian's, 2026-10-21: floor -66 dB RMS, noise peaks over -56) never stay
// under an RMS threshold, so a whole take came back as speech.
export function silences(dbs, thresholdDb, { min = 0.3 } = {}) {
  const out = [], n = Math.round(min / WINDOW);
  let from = null;
  for (let i = 0; i <= dbs.length; i++) {
    if (i < dbs.length && dbs[i] < thresholdDb) from ??= i;
    else if (from != null) {
      if (i - from >= n) out.push({ start: r3(from * WINDOW), end: r3(i * WINDOW) });
      from = null;
    }
  }
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

// Everything list_takes shows about a fresh take, from one pass over the audio: the levels, the
// threshold between them, and the silences under it.
// A file's audio as mono float samples, rumble cut (highpass 80 Hz).
export async function samplesOf(file, rate = 16000) {
  const { stdout } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-af", "highpass=f=80", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { stdout: "buffer" });
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + Math.floor(stdout.length / 4) * 4));
}

// The loudest sample, in dBFS: under about -24 the microphone is too far or its input too low.
export function maxDb(samples) {
  let m = 0;
  for (const x of samples) if (Math.abs(x) > m) m = Math.abs(x);
  return m > 0 ? r3(20 * Math.log10(m)) : null;
}

export async function analyzeTake(file) {
  const info = await probe(file);
  if (!info.hasAudio) throw new Error("the take has no audio");
  const rate = 16000;
  const samples = await samplesOf(file, rate);
  const seconds = r3(samples.length / rate);
  const level = levels(samples, rate);
  const thresholdDb = threshold(level);
  const speech = speechRange(silences(windowsDb(samples, rate), thresholdDb), seconds);
  return { seconds, ...info, speech: speech && { ...speech, auto: true }, level: { ...level, thresholdDb, maxDb: maxDb(samples) } };
}

// ---------- cutting inside a take ----------
// A take's narration can be several ranges of it (segments, take seconds), joined with a short
// crossfade; the camera clip makes the same cuts as jump cuts. Each inner join takes XFADE
// more audio past its end, so the narration is exactly as long as the ranges add up to and
// the picture stays in sync. Narration time and take time map onto each other through them.
export const XFADE = 0.04;

// Narration seconds -> take seconds, and back (null: cut out).
export function toTake(t, segments) {
  let at = 0;
  for (const s of segments) {
    const d = s.to - s.from;
    if (t <= at + d + 1e-6) return r3(s.from + Math.max(0, t - at));
    at += d;
  }
  return r3(segments.at(-1).to);
}
export function fromTake(T, segments) {
  let at = 0;
  for (const s of segments) {
    if (T >= s.from - 1e-6 && T <= s.to + 1e-6) return r3(at + Math.min(T, s.to) - s.from);
    at += s.to - s.from;
  }
  return null;
}

// Narration ranges to cut out -> the take ranges to keep.
export function keepRanges(segments, cuts) {
  let keep = segments.map((s) => ({ ...s }));
  for (const c of cuts) {
    const a = toTake(c.from, segments), b = toTake(c.to, segments);
    keep = keep.flatMap((s) => (b <= s.from || a >= s.to ? [s] : [...(a > s.from ? [{ from: s.from, to: a }] : []), ...(b < s.to ? [{ from: b, to: s.to }] : [])]));
  }
  return keep.filter((s) => s.to - s.from > 0.05).map((s) => ({ from: r3(s.from), to: r3(s.to) }));
}

// Where to cut between two sounds: in the longest stretch under the threshold between lo and
// hi (seconds), so a cut never clips a word whose transcript time is a little off. side
// "start" keeps a little of the pause after the sound before it; "end" a little before the
// sound after it.
export function cutPoint(dbs, thresholdDb, lo, hi, side) {
  const a = Math.max(0, Math.floor(lo / WINDOW)), b = Math.min(dbs.length, Math.ceil(hi / WINDOW));
  let best = null;
  for (let i = a, from = null; i <= b; i++) {
    if (i < b && dbs[i] < thresholdDb) from ??= i;
    else if (from != null) {
      if (!best || i - from > best[1] - best[0]) best = [from, i];
      from = null;
    }
  }
  if (!best) return r3((lo + hi) / 2);
  const [s, e] = [best[0] * WINDOW, best[1] * WINDOW];
  return r3(side === "start" ? Math.min(s + 0.15, (s + e) / 2) : Math.max(e - SPEECH_PAD.before, (s + e) / 2));
}

// Voiced: a periodic sound with a pitch between 70 and 400 Hz (a hum, an "øh"), not a breath or
// a rustle. The share of 30 ms frames whose autocorrelation peaks over 0.5 at such a lag.
export function voiced(samples, rate, from, to) {
  const n = Math.round(rate * 0.03), lo = Math.floor(rate / 400), hi = Math.ceil(rate / 70);
  let frames = 0, yes = 0;
  for (let i = Math.round(from * rate); i + n + hi <= Math.min(samples.length, Math.round(to * rate)); i += n) {
    let e = 0;
    for (let k = 0; k < n; k++) e += samples[i + k] * samples[i + k];
    if (e <= 0) continue;
    let best = 0;
    for (let lag = lo; lag <= hi; lag++) {
      let c = 0, e2 = 0;
      for (let k = 0; k < n; k++) (c += samples[i + k] * samples[i + k + lag]), (e2 += samples[i + k + lag] * samples[i + k + lag]);
      if (e2 > 0) best = Math.max(best, c / Math.sqrt(e * e2));
    }
    frames++;
    if (best > 0.5) yes++;
  }
  return frames ? yes / frames : 0;
}

// Islands of sound: stretches over the threshold, the ones less than 0.25 s apart joined (a
// word dips under it between syllables), at least 0.1 s long. [{ start, end }] in seconds.
export function islands(dbs, thresholdDb) {
  const out = [];
  for (let i = 0, from = null; i <= dbs.length; i++) {
    if (i < dbs.length && dbs[i] >= thresholdDb) from ??= i;
    else if (from != null) {
      const a = r3(from * WINDOW), b = r3(i * WINDOW);
      if (out.length && a - out.at(-1).end < 0.25) out.at(-1).end = b;
      else out.push({ start: a, end: b });
      from = null;
    }
  }
  return out.filter((x) => x.end - x.start >= 0.1);
}

// Filler sounds no transcript word covers (whisper drops "øh"): islands of voiced sound, 0.15 to
// 1.2 s long, with a pause on both sides, in which no word starts. Word ends are no guide
// (whisper's run on to the next word) and starts run late (whisper's DTW by up to 0.3 s,
// Scribe's by 20 to 60 ms), so a word starting from 0.15 s before the sound to 0.3 s after its
// end is in it.
export function hums(samples, rate, thresholdDb, words) {
  const covered = (a, b) => words.some((w) => w.start >= a - 0.15 && w.start <= b + 0.3);
  return islands(windowsDb(samples, rate), thresholdDb).filter((x) => x.end - x.start >= 0.15 && x.end - x.start <= 1.2 && !covered(x.start, x.end) && voiced(samples, rate, x.start, x.end) >= 0.5);
}

// A false start the transcript merged away. Whisper hears "Men er... Men har den læst" as "Men
// har den læst" and puts "Men" on the broken-off start. The signs: the first island of sound
// holds at most three words, ends mid-phrase (no punctuation), and a pause of 0.5 s or more
// follows; the next island starts with sound no word claims, at least 0.15 s before its first
// word. Then the first island goes, and its words move into that sound. null when not so.
export function mergedFalseStart(dbs, thresholdDb, words) {
  const [i0, i1] = islands(dbs, thresholdDb);
  if (!i1 || i1.start - i0.end < 0.5) return null;
  const first = words.filter((w) => w.start < i1.start - 0.15);
  const next = words[first.length];
  if (!first.length || first.length > 3 || !next || /[.!?,;:…]$/.test(first.at(-1).word) || next.start - i1.start < 0.15) return null;
  const span = next.start - 0.02 - i1.start;
  return {
    start: 0, end: r3(Math.max(i0.end, i1.start - SPEECH_PAD.before)), text: first.map((w) => w.word).join(" "),
    moved: first.map((w, k) => ({ ...w, start: r3(i1.start + (span * k) / first.length), end: r3(i1.start + (span * (k + 1)) / first.length) })),
  };
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
export async function cutNarration(file, { from, to, segments, floorDb }, out) {
  if (!segments || segments.length < 2) return cutOne(file, { ...(segments?.[0] ?? { from, to }), floorDb }, out);
  const parts = segments.map((_, k) => `${out}.part${k}-${process.pid}.wav`);
  try {
    const last = segments.length - 1;
    for (const [k, s] of segments.entries()) await cutOne(file, { from: s.from, to: k < last ? s.to + XFADE : s.to, floorDb, fadeIn: k === 0, fadeOut: k === last }, parts[k]);
    const chain = parts.slice(1).map((_, k) => `${k ? `[x${k}]` : "[0:a]"}[${k + 1}:a]acrossfade=d=${XFADE}:c1=tri:c2=tri[x${k + 1}]`).join(";");
    await run("ffmpeg", ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", ...parts.flatMap((p) => ["-i", p]), "-filter_complex", chain, "-map", `[x${last}]`, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out]);
  } finally {
    for (const p of parts) rmSync(p, { force: true });
  }
  return out;
}

async function cutOne(file, { from, to, floorDb, fadeIn = true, fadeOut = true }, out) {
  const nf = Math.max(-80, Math.min(-20, Math.round(floorDb ?? -60)));
  const lag = await denoiseLatency();
  const d = to - from;
  mkdirSync(dirname(out), { recursive: true });
  await run("ffmpeg", ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", file, "-vn",
    "-af", `atrim=start=${from}:end=${r3(to + lag)},asetpts=PTS-STARTPTS,aresample=48000,apad=pad_dur=${lag},${DENOISE(nf)},atrim=start=${lag},asetpts=PTS-STARTPTS,atrim=duration=${r3(d)}${fadeIn ? ",afade=t=in:d=0.015" : ""}${fadeOut ? `,afade=t=out:st=${r3(Math.max(0, d - 0.04))}:d=0.04` : ""}`,
    "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out]);
  return out;
}

// The camera clip: take seconds t0 .. t0 + duration as a muted, constant-rate H.264 clip at the
// video's size (scaled to cover it, centre crop), so its t=0 is the scene's t=0. Where the
// take has no footage (t0 before its start, or past its end) the first or last frame holds.
// With segments (more than one), the picture jumps where the narration was cut: the first
// range starts t0 - its start earlier (the lead), the last runs on to the end of the take.
export async function cutCam(file, { t0, segments, duration, fps, width, height }, out) {
  const frames = Math.max(1, Math.round(duration * fps));
  const multi = segments?.length > 1;
  const pre = multi ? Math.max(0, -t0) : 0;
  const parts = multi
    ? segments.map((s, k) => `[0:v]trim=start=${r3(k ? s.from : Math.max(0, t0))}${k < segments.length - 1 ? `:end=${r3(s.to)}` : ""},setpts=PTS-STARTPTS[v${k}]`).join(";") + `;${segments.map((_, k) => `[v${k}]`).join("")}concat=n=${segments.length}:v=1:a=0[c];[c]`
    : "";
  const filter = parts + [
    ...(multi ? [`fps=fps=${fps}:start_time=0`, ...(pre ? [`tpad=start_mode=clone:start_duration=${r3(pre)}`] : [])] : [`setpts=PTS-(${r3(t0)})/TB`, `fps=fps=${fps}:start_time=0`]),
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
    await run("ffmpeg", ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-i", file, "-an", multi ? "-filter_complex" : "-vf", filter, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps), "-fps_mode", "cfr", "-frames:v", String(frames), "-movflags", "+faststart", tmp]);
    renameSync(tmp, out);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { file: out, frames, seconds: r3(frames / fps) };
}
