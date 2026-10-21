// Convert supported transcript JSON to scene-local word timings, then either replace
// transcript spelling and punctuation with the approved script while retaining its times, or
// (adopt) rewrite the script to what the take says.
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

// The longest common subsequence of script and transcript words (normalised), as index
// pairs, ending in the sentinel [a.length, b.length]. The gaps between pairs are where the
// two differ.
function pairsOf(a, b) {
  const lcs = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  pairs.push([a.length, b.length]);
  return pairs;
}

function align(words, text) {
  const script = String(text).split(/\s+/).filter(Boolean);
  if (!script.length) return { words, unmatched: [] };
  const a = script.map(norm), b = words.map((word) => norm(word.word));
  const pairs = pairsOf(a, b);
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

// Numbers, so the script's "40" and the take's "fyrre" (or "forty") count as the same word.
// Danish and English number words, digits with thousands separators, and compounds such as
// "toogfyrre", "forty-two", "et hundrede og fyrre". null when the tokens are not one number.
const NUM = { nul: 0, zero: 0, en: 1, et: 1, one: 1, to: 2, two: 2, tre: 3, three: 3, fire: 4, four: 4, fem: 5, five: 5, seks: 6, six: 6, syv: 7, seven: 7, otte: 8, eight: 8, ni: 9, nine: 9, ti: 10, ten: 10, elleve: 11, eleven: 11, tolv: 12, twelve: 12, tretten: 13, thirteen: 13, fjorten: 14, fourteen: 14, femten: 15, fifteen: 15, seksten: 16, sixteen: 16, sytten: 17, seventeen: 17, atten: 18, eighteen: 18, nitten: 19, nineteen: 19, tyve: 20, twenty: 20, tredive: 30, tredve: 30, thirty: 30, fyrre: 40, forty: 40, halvtreds: 50, fifty: 50, tres: 60, sixty: 60, halvfjerds: 70, seventy: 70, firs: 80, eighty: 80, halvfems: 90, ninety: 90 };
const SCALE = { hundrede: 100, hundred: 100, tusind: 1000, tusinde: 1000, thousand: 1000, million: 1e6, millioner: 1e6, millions: 1e6 };
const hasDigit = (list) => list.some((t) => /\d/.test(t));
export function numberOf(list) {
  let total = 0, cur = 0, any = false;
  const parts = list.flatMap((raw) => raw.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").split(/(?<=\p{L})-(?=\p{L})/u));
  for (const [k, t] of parts.entries()) {
    let m;
    if (/^\d{1,3}([.,]\d{3})+$/.test(t)) cur += Number(t.replace(/[.,]/g, ""));
    else if (/^\d+([.,]\d+)?$/.test(t)) cur += Number(t.replace(",", "."));
    else if (t === "og" || t === "and") { if (!any || k === parts.length - 1) return null; continue; }
    else if (NUM[t] !== undefined) cur += NUM[t];
    else if ((m = /^(\p{L}+?)og(\p{L}+)$/u.exec(t)) && NUM[m[1]] < 10 && NUM[m[2]] >= 20) cur += NUM[m[1]] + NUM[m[2]];
    else if (SCALE[t] === 100) cur = (cur || 1) * 100;
    else if (SCALE[t]) (total += (cur || 1) * SCALE[t]), (cur = 0);
    else return null;
    any = true;
  }
  return any ? total + cur : null;
}

// Inside a gap: the script's numbers that the take said as words (or the other way round),
// left to right. One side must be written in digits, so "en" and "et" stay different words.
function numberMatches(A, B) {
  const out = [];
  let jb = 0;
  for (let ia = 0; ia < A.length; ia++) {
    let hit = null;
    for (let la = Math.min(4, A.length - ia); la >= 1 && !hit; la--) {
      const sa = A.slice(ia, ia + la), va = numberOf(sa);
      if (va == null) continue;
      for (let j = jb; j < B.length && !hit; j++) {
        for (let lb = Math.min(6, B.length - j); lb >= 1; lb--) {
          const sb = B.slice(j, j + lb);
          if (numberOf(sb) === va && (hasDigit(sa) || hasDigit(sb))) { hit = { a0: ia, a1: ia + la, b0: j, b1: j + lb }; break; }
        }
      }
    }
    if (!hit) continue;
    if (/%$/.test(A[hit.a1 - 1]) && /^(procent|percent|pct)$/.test(norm(B[hit.b1] ?? ""))) hit.b1++;
    out.push(hit);
    ia = hit.a1 - 1;
    jb = hit.b1;
  }
  return out;
}

// adopt: the narration becomes what the take says. Where script and take agree, the script's
// spelling and punctuation; where they differ, the take's words; a number the take said as
// words keeps the script's digits. The script's line breaks stay. Every word in the result was
// heard, so its time is the take's. changes lists each place the text changed.
function adoptText(words, text) {
  const script = [...String(text).matchAll(/(\s*)(\S+)/g)].map((m) => ({ sep: m[1], text: m[2] }));
  const a = script.map((t) => norm(t.text)), b = words.map((word) => norm(word.word));
  const pairs = pairsOf(a, b);
  const parts = [], timed = [], changes = [];
  let carry = null;
  const emit = (token, sep, time) => {
    const own = carry ?? sep;
    carry = null;
    parts.push(parts.length ? (own || " ") : "", token);
    if (!norm(token)) {
      if (timed.length) timed.at(-1).word += token;
    } else if (time) timed.push({ word: token, start: time.start, end: time.end });
  };
  let pi = 0, pj = 0;
  for (const [k, [i, j]] of pairs.entries()) {
    const A = script.slice(pi, i), B = words.slice(pj, j);
    if (A.length || B.length) {
      const before = parts.length;
      const lead = A[0]?.sep ?? " ";
      let first = true;
      const sep = (own) => (first ? ((first = false), lead) : own ?? " ");
      // Punctuation the script set on its own ("–") between two heard words stays; inside a
      // rephrased passage it goes with the script's words.
      const scriptWords = A.filter((t) => norm(t.text));
      if (!scriptWords.length) for (const t of A) emit(t.text, sep(t.sep));
      const matches = numberMatches(scriptWords.map((t) => t.text), B.map((w) => w.word));
      let jb = 0;
      for (const m of matches) {
        for (; jb < m.b0; jb++) emit(B[jb].word, sep(), B[jb]);
        const span = { start: B[m.b0].start, end: B[m.b1 - 1].end }, n = m.a1 - m.a0;
        for (let x = 0; x < n; x++) emit(scriptWords[m.a0 + x].text, sep(scriptWords[m.a0 + x].sep), { start: r3(span.start + ((span.end - span.start) * x) / n), end: r3(span.start + ((span.end - span.start) * (x + 1)) / n) });
        jb = m.b1;
      }
      for (; jb < B.length; jb++) emit(B[jb].word, sep(), B[jb]);
      if (parts.length === before && /\n/.test(lead)) carry = lead;
      const spoken = parts.slice(before).filter((_, x) => x % 2).join(" ");
      const written = A.map((t) => t.text).join(" ");
      if (spoken !== written) changes.push({ written, spoken });
    }
    if (i < a.length) {
      // Before a changed passage the take may end the sentence where the script did not.
      const [ni, nj] = pairs[k + 1];
      const end = ni !== i + 1 || nj !== j + 1 ? /[.!?…]+$/.exec(words[j].word)?.[0] : null;
      emit(end && !/[.!?…,;:]$/.test(script[i].text) ? script[i].text + end : script[i].text, script[i].sep, words[j]);
    }
    pi = i + 1;
    pj = j + 1;
  }
  return { text: parts.join(""), words: clean(timed), changes };
}

// ---------- what a take says that the video should not ----------
// Filler sounds as a transcript writes them (Scribe does; whisper mostly drops them).
const FILLER = /^(?:æ+h+m*|ø+h+m*|æ+m+|ø+m+|e+h*m+|e+h+|hm+|m{2,}|u+h+m*|u+m+|a+h+m*|ö+h+m*)$/u;

function lcsLen(a, b) {
  let prev = new Int32Array(b.length + 1), row = new Int32Array(b.length + 1);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) row[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], row[j + 1]);
    [prev, row] = [row, prev];
  }
  return prev[0];
}

// Restarts: a phrase said, broken off, and said again ("Men er... Men har den læst"), or said
// twice ("Priser mangler for to varer. Priser mangler for to varer."). The later one stays.
// A candidate is a word that comes back within 15 words, either with the words after it (two
// or more the same) or after a pause (the silence before it: pause(from, to) measures it in the
// audio, since whisper's word ends run on to the next word; without it, the gap between the
// words). It is
// only a restart when the script does not need the first attempt: without it, as many script
// words still find their place. At the end, words after the last one the script needs, after a
// pause, that repeat something already said. Returns [{ kind, from, to }] index ranges.
export function restarts(words, script, pause) {
  const gap = (j) => (j <= 0 || j >= words.length ? 0 : pause ? pause(Math.min(words[j - 1].end, words[j - 1].start + 0.6), words[j].start) : words[j].start - words[j - 1].end);
  const a = String(script ?? "").split(/\s+/).map(norm).filter(Boolean), b = words.map((w) => norm(w.word));
  if (!a.length) return [];
  const base = lcsLen(a, b), cut = new Array(b.length).fill(false), out = [];
  const without = (i, j) => b.filter((_, k) => !cut[k] && (k < i || k >= j));
  for (let j = 1; j < b.length; j++) {
    for (let i = Math.max(0, j - 15); i < j && b[j]; i++) {
      if (b[i] !== b[j] || cut.slice(i, j).some(Boolean)) continue;
      let m = 0;
      while (j + m < b.length && b[i + m] === b[j + m]) m++;
      if (Math.min(m, j - i) < 2 && gap(j) < 0.3) continue;
      // A phrase said twice can be cut anywhere along it with the same words left; cut where
      // the second one starts after the longest pause, at a sentence end when that ties.
      let s = 0;
      const score = (x) => gap(j + x) + (/[.!?,;:]$/.test(words[j + x - 1].word) ? 0.05 : 0);
      for (let x = 1; x <= m - (j - i); x++) if (score(x) > score(s)) s = x;
      if (lcsLen(a, without(i + s, j + s)) < base) continue;
      for (let k = i + s; k < j + s; k++) cut[k] = true;
      out.push({ kind: "restart", from: i + s, to: j + s });
      break;
    }
  }
  let need = b.length;
  while (need > 0 && lcsLen(a, without(need - 1, b.length)) === base) need--;
  const tail = b.slice(need).filter(Boolean);
  if (need > 0 && need < b.length && gap(need) >= 0.3 && tail.length) {
    const said = b.slice(0, need).join(" ");
    if ((" " + said + " ").includes(" " + tail.join(" ") + " ")) out.push({ kind: "restart", from: need, to: b.length });
  }
  return out;
}

// Filler words in the transcript that the script does not have.
export function fillers(words, script) {
  const inScript = new Set(String(script ?? "").split(/\s+/).map(norm));
  return words.flatMap((w, i) => (FILLER.test(norm(w.word)) && !inScript.has(norm(w.word)) ? [{ kind: "filler", from: i, to: i + 1 }] : []));
}

// edits (with adopt): leave restarts and filler words out of the adopted text, and return them
// as removed: [{ kind, from, to, text, start, end }] (transcript indices and seconds), with the
// whole transcript, so the caller can cut them out of the take.
export function narrationWords({ words, scribe, whisper, script, adopt = false, edits = false, pause }) {
  if ([words, scribe, whisper].filter((value) => value !== undefined).length !== 1) throw new Error("Pass exactly one of words, scribe or whisper");
  const transcript = words !== undefined ? clean(words) : scribe !== undefined ? fromScribe(scribe) : fromWhisper(whisper);
  if (!adopt) return align(transcript, script);
  if (!transcript.length) throw new Error("the transcript has no words to adopt");
  if (!edits) return adoptText(transcript, script ?? "");
  const removed = [...restarts(transcript, script, pause), ...fillers(transcript, script)].sort((x, y) => x.from - y.from);
  const drop = new Set(removed.flatMap((r) => Array.from({ length: r.to - r.from }, (_, k) => r.from + k)));
  const r = adoptText(transcript.filter((_, i) => !drop.has(i)), script ?? "");
  return { ...r, transcript, removed: removed.map((x) => ({ ...x, text: transcript.slice(x.from, x.to).map((w) => w.word).join(" "), start: transcript[x.from].start, end: transcript[x.to - 1].end })) };
}
