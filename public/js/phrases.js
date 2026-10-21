// Narration split for the teleprompter. No DOM in here, so node --test can import it.
// A block of narration as sentences: after . ! ? … (and a closing quote), and at line breaks.
export const sentences = (text) => String(text ?? "").split(/(?<=[.!?…]["'»”)]*)\s+|\s*\n+\s*/).map((x) => x.trim()).filter(Boolean);

// The lens layout shows phrases, not sentences: a long sentence is split at , ; : and, if a
// piece is still long, before a joining word (og, men, så ...) or in even halves, so the text
// under the lens stays at two or three short lines.
const JOIN = /^(og|men|så|eller|der|som|at|hvis|fordi|når|mens|and|but|so|or|that|which|because|when|if)$/i;
export function phrases(text, max = 8) {
  const words = (x) => x.split(/\s+/).filter(Boolean);
  const split = (piece) => {
    const w = words(piece);
    if (w.length <= max + 2) return [piece];
    let at = -1;
    for (let i = 3; i < w.length - 2; i++) if (JOIN.test(w[i]) && (at < 0 || Math.abs(i - w.length / 2) < Math.abs(at - w.length / 2))) at = i;
    if (at < 0) at = Math.ceil(w.length / 2);
    return [...split(w.slice(0, at).join(" ")), ...split(w.slice(at).join(" "))];
  };
  return sentences(text).flatMap((sentence) => {
    const parts = sentence.split(/(?<=[,;:])\s+/).filter(Boolean);
    const out = [];
    for (const part of parts) {
      const last = out.at(-1);
      if (last && words(last).length + words(part).length <= max) out[out.length - 1] = `${last} ${part}`;
      else out.push(part);
    }
    return out.flatMap(split);
  });
}
