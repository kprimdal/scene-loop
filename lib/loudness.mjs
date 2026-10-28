// What a finished soundtrack measures, so the chat hears about clipping and gaps without
// listening: integrated loudness, loudness range and true peak from ffmpeg's ebur128, and
// from the decoded samples the clipped ones and the stretches without sound.
import { spawn } from "node:child_process";

// Silence is 50 ms windows whose RMS is under -50 dBFS, for at least 2 s. RMS, not sample
// peaks (silencedetect): a room's noise floor peaks over a threshold its RMS stays under. 2 s,
// because every block has 0.35 s of lead and 0.6 s of tail, so short gaps are the design.
export const SILENCE_DB = -50;
export const SILENCE_MIN = 2;
const WINDOW = 0.05;
const RATE = 48000;

function run(args, onStdout) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-nostdin", "-hide_banner", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-8000)));
    p.stdout.on("data", onStdout ?? (() => {}));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg: ${err.trim().split("\n").at(-1) || `exit ${code}`}`))));
  });
}

async function ebur128(file) {
  const log = await run(["-i", file, "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const num = (re) => Number(summary.match(re)?.[1]);
  const i = num(/I:\s+(-?[\d.]+) LUFS/), lra = num(/LRA:\s+(-?[\d.]+) LU/), peak = num(/Peak:\s+(-?[\d.inf]+) dBFS/);
  return {
    integratedLufs: Number.isFinite(i) && i > -69.9 ? i : null, // -70 is ebur128's floor: silence
    lra: Number.isFinite(lra) ? lra : null,
    truePeakDb: Number.isFinite(peak) ? peak : null,
  };
}

// One pass over the samples as mono 32-bit float.
async function samples(file) {
  const per = Math.round(RATE * WINDOW);
  let clipped = 0, sum = 0, n = 0, rest = Buffer.alloc(0);
  const quiet = [];
  const floor = 10 ** (SILENCE_DB / 20);
  await run(["-i", file, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], (d) => {
    const buf = rest.length ? Buffer.concat([rest, d]) : d;
    const whole = buf.length - (buf.length % 4);
    for (let o = 0; o < whole; o += 4) {
      const x = buf.readFloatLE(o);
      if (x >= 0.999 || x <= -0.999) clipped++;
      sum += x * x;
      if (++n === per) {
        quiet.push(Math.sqrt(sum / n) < floor);
        sum = 0; n = 0;
      }
    }
    rest = buf.subarray(whole);
  });
  if (n) quiet.push(Math.sqrt(sum / n) < floor);
  const silences = [];
  for (let i = 0; i < quiet.length; ) {
    if (!quiet[i]) { i++; continue; }
    let j = i;
    while (j < quiet.length && quiet[j]) j++;
    const from = i * WINDOW, to = Math.min(j * WINDOW, quiet.length * WINDOW);
    if (to - from >= SILENCE_MIN) silences.push({ from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 });
    i = j;
  }
  return { clippedSamples: clipped, silences, seconds: quiet.length * WINDOW };
}

// { integratedLufs, lra, truePeakDb, clippedSamples, silences: [{ from, to }] } for a file.
export async function measure(file) {
  const [a, b] = await Promise.all([ebur128(file), samples(file)]);
  return { integratedLufs: a.integratedLufs, lra: a.lra, truePeakDb: a.truePeakDb, clippedSamples: b.clippedSamples, silences: b.silences, seconds: Math.round(b.seconds * 100) / 100 };
}

// Plain-word warnings for a measured soundtrack. target: the LUFS the voice was normalised to
// (null when the level was kept). scenes: [{ id, start, duration }] to name where a gap is.
export function loudnessWarnings(m, { target = null, scenes = [], duration = m.seconds } = {}) {
  const out = [];
  if (m.integratedLufs == null) return ["The soundtrack is silent."];
  if (m.truePeakDb != null && m.truePeakDb > -1) out.push(`True peak ${m.truePeakDb} dBTP is above -1: lower a loud sound effect (data-sfx gain, e.g. :-4) or the music (set_video musicDb), then build_soundtrack again.`);
  if (m.clippedSamples > 0) out.push(`${m.clippedSamples} clipped samples: a source is too loud. Find it with the true peak warning's advice, or listen around the loudest cues.`);
  if (target != null && Math.abs(m.integratedLufs - target) > 1.5) out.push(`Integrated loudness ${m.integratedLufs} LUFS is ${Math.abs(m.integratedLufs - target).toFixed(1)} LU off the ${target} LUFS target: the effects or music are carrying the mix, or there is little voice.`);
  for (const s of m.silences) {
    if (s.to >= duration - 0.05 && s.from > 0) continue; // the tail after the last word
    const ids = scenesIn(scenes, s);
    out.push(`No sound from ${s.from} to ${s.to} s${ids.length ? ` (${ids.join(", ")})` : ""}: if that is not meant, add narration, a cue or a music bed there, or shorten the scene.`);
  }
  return out;
}

export const scenesIn = (scenes, { from, to }) => scenes.filter((s) => s.start < to && s.start + s.duration > from).map((s) => s.id);
