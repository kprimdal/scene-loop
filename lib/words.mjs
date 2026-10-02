// Convert supported transcript JSON to scene-local word timings, then optionally replace
// transcript spelling and punctuation with the approved script while retaining its times.
const r3 = (value) => Math.round(value * 1000) / 1000;
const norm = (word) => String(word).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function clean(words) {
  if (!Array.isArray(words)) throw new Error("words must be an array");
  return words.map((item, index) => {
    const word = String(item?.word ?? "").trim();
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!word || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) throw new Error(`word ${index + 1} must have text and non-negative start/end times`);
    return { word, start: r3(start), end: r3(end) };
  });
}

function fromScribe(src) {
  if (!src || !Array.isArray(src.words)) throw new Error("scribe must contain a words array");
  return clean(src.words.filter((word) => word.type === "word").map((word) => ({ word: word.text, start: word.start, end: word.end })));
}

function fromWhisper(src) {
  if (!src || !Array.isArray(src.transcription)) throw new Error("whisper must contain a transcription array");
  const words = [];
  for (const segment of src.transcription) {
    if (!Array.isArray(segment.tokens)) continue;
    for (const token of segment.tokens) {
      if (/^\[_/.test(token.text) || !(Number(token.t_dtw) >= 0)) continue;
      const at = Number(token.t_dtw) / 100;
      if (/^\s/.test(token.text)) words.push({ word: token.text.trim(), start: at, end: at });
      else if (words.length) words.at(-1).word += token.text;
    }
  }
  words.forEach((word, index) => (word.end = words[index + 1] ? Math.max(word.start, words[index + 1].start - 0.02) : word.start + 0.3));
  return clean(words);
}

function align(words, text) {
  const script = String(text).split(/\s+/).filter(Boolean);
  if (!script.length) return { words, unmatched: [] };
  const a = script.map(norm), b = words.map((word) => norm(word.word));
  const lcs = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  pairs.push([a.length, b.length]);
  const out = [], unmatched = [];
  let pi = 0, pj = 0;
  for (const [i, j] of pairs) {
    const gapA = i - pi, gapB = j - pj;
    if (gapA && gapA === gapB) {
      for (let k = 0; k < gapA; k++) out.push({ ...words[pj + k], word: script[pi + k] });
    } else if (gapA) {
      const t0 = pj > 0 ? words[pj - 1].end : 0;
      const t1 = j < words.length ? words[j].start : (words.at(-1)?.end ?? t0);
      for (let k = 0; k < gapA; k++) {
        out.push({ word: script[pi + k], start: r3(t0 + ((t1 - t0) * k) / gapA), end: r3(t0 + ((t1 - t0) * (k + 1)) / gapA) });
        unmatched.push(script[pi + k]);
      }
    }
    if (i < a.length) out.push({ ...words[j], word: script[i] });
    pi = i + 1;
    pj = j + 1;
  }
  return { words: clean(out), unmatched };
}

export function narrationWords({ words, scribe, whisper, script }) {
  if ([words, scribe, whisper].filter((value) => value !== undefined).length !== 1) throw new Error("Pass exactly one of words, scribe or whisper");
  const transcript = words !== undefined ? clean(words) : scribe !== undefined ? fromScribe(scribe) : fromWhisper(whisper);
  return align(transcript, script);
}
