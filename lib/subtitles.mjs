// Caption edits are a separate immutable-source snapshot, owned by scene HTML history.
import { createHash } from 'node:crypto';
import { SUBTITLE_STYLES, subtitleMarkup, validateCues } from '../public/js/subtitles.js';
export { validateCues };
export const subtitleHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const BLOCK = /<!-- scene-loop:subtitles ([A-Za-z0-9+/=]+) -->\n[\s\S]*?<!-- \/scene-loop:subtitles -->\n?/g;
export const withoutSubtitles = html => html.replace(BLOCK,'');
export function sceneSubtitles(html) {
  const m=[...html.matchAll(BLOCK)][0];
  return m ? JSON.parse(Buffer.from(m[1],'base64').toString('utf8')) : null;
}
export function validateSubtitles(snapshot,duration) { if(snapshot) validateCues(snapshot.cues,duration); }
export function withSubtitles(html,scene,snapshot, exactBlock) {
  const clean=withoutSubtitles(html);
  if(!snapshot || !snapshot.cues.length) return clean;
  if(!/<div\b[^>]*\bid="root"[^>]*>/.test(clean)) throw new Error('Keep <div id="root"> to preserve captions.');
  const block=exactBlock ?? `<!-- scene-loop:subtitles ${Buffer.from(JSON.stringify(snapshot)).toString('base64')} -->\n${subtitleMarkup(scene,snapshot)}\n<!-- /scene-loop:subtitles -->\n`;
  return clean.replace(/<div\b[^>]*\bid="root"[^>]*>/,open=>open+block);
}
export function preserveSubtitles(html,current,scene,duration) {
  const snapshot=sceneSubtitles(current); validateSubtitles(snapshot,duration);
  return withSubtitles(html,scene,snapshot,[...current.matchAll(BLOCK)][0]?.[0]);
}
export function pinSubtitles(cues,duration,style,provenance,previous) {
  const preset=Object.hasOwn(SUBTITLE_STYLES,style) ? SUBTITLE_STYLES[style] : null;
  if(!preset) throw new Error('Caption style: dark, light or shadow.');
  return {schema:1,cues:validateCues(cues,duration),style:structuredClone(previous?.style.id===style ? previous.style : preset),provenance:structuredClone(provenance)};
}
// Point-timed words are valid transcript data. Keep their text in phrase context;
// only infer display intervals, never change a source word or invent audio timing.
export function deriveCaptionDraft(words, lead, duration) {
  if (!Array.isArray(words) || !words.length) throw new Error('Timed narration words are required. Add word timings for this scene first with set_narration_words.');
  if (!Number.isFinite(lead) || lead < 0) throw new Error('Narration lead must be finite and non-negative.');
  validateCues([], duration);
  // Remove arithmetic noise such as .2-.8+1 without rounding genuine source/lead
  // precision across a scene boundary (e.g. a point at a 30 fps frame-grid end).
  const cleanTime = t => Math.abs(t-Number(t.toFixed(6))) < 1e-12 ? Number(t.toFixed(6)) : t;
  const sceneTime = t => cleanTime(t+lead);
  const groups = [];
  let group = [], prior = 0;
  const textOf = g => g.words.map(w => w.word).join(' ');
  const flush = () => {
    if (group.length) {
      const spoken=group.filter(w=>!w.point);
      // Points do not constrain a spoken phrase's interval. A point-only phrase
      // has no measured span: its first point seeds the neighbor inference below.
      groups.push({ words:group, start:spoken[0]?.start ?? group[0].start, end:spoken.at(-1)?.end ?? group[0].start });
    }
    group = [];
  };
  for (const [i, w] of words.entries()) {
    if (!w || typeof w.word !== 'string' || !w.word.trim() || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || (w.end>w.start && w.start<prior) || w.end < w.start) throw new Error(`Source word ${i+1} has missing, overlapping or reversed timing. Review transcript timings before generating captions.`);
    if (w.end>w.start) prior = w.end;
    const next = { word:w.word.trim(), start:sceneTime(w.start), end:sceneTime(w.end), index:i+1, point:w.end===w.start };
    if (next.end > duration || next.start > duration) throw new Error(`Source word ${i+1} is outside scene bounds after narration lead (${duration} s scene). Lengthen the scene or review narration lead before generating captions; no source words were clipped.`);
    if (group.length && (group.map(x=>x.word).join(' ').length+1+next.word.length>72 || group.length>=10 || next.end-group[0].start>5 || next.start-group.at(-1).end>.6)) flush();
    group.push(next);
    if (/[.!?…][”"')\]]?$/.test(next.word)) flush();
  }
  flush();

  // Prefer a nearby spoken phrase over a separate flash of punctuation/point words.
  // Merging may cross a sentence/soft grouping boundary, but retains the hard cue limits.
  for (let i=0; i<groups.length;) {
    const g = groups[i];
    if (g.end > g.start) { i++; continue; }
    const neighbor = [i-1, i+1].find(n => {
      const other = groups[n];
      if (!other || other.end <= other.start) return false;
      const pair = n<i ? [other,g] : [g,other];
      return Math.abs(pair[1].start-pair[0].end) <= .6 && textOf(pair[0]).length+1+textOf(pair[1]).length <= 84 && other.end-other.start <= 8;
    });
    if (neighbor === undefined) { i++; continue; }
    const first = Math.min(i,neighbor), pair = groups.slice(first,first+2), context=groups[neighbor];
    groups.splice(first,2,{ words:pair.flatMap(g=>g.words), start:context.start, end:context.end, basis:'neighbor phrase context' });
    i = Math.max(0,first-1);
  }

  // Remaining point-only cues use free time bounded by their nearest positive cues.
  // Reserve equal slots (up to .8s each), clamped near each source point. No epsilon
  // additions: if there is no free gap, share a neighboring positive interval instead.
  for (let i=0; i<groups.length;) {
    if (groups[i].end > groups[i].start) { i++; continue; }
    let j=i+1;
    while (j<groups.length && groups[j].end===groups[j].start) j++;
    const lower = groups[i-1]?.end ?? 0, upper = groups[j]?.start ?? duration;
    if (upper > lower) {
      const slot = Math.min(.8,(upper-lower)/(j-i));
      let cursor = lower;
      for (let k=i; k<j; k++) {
        const start = Math.max(cursor,Math.min(groups[k].start,upper-(j-k)*slot));
        const end = Math.min(upper,start+slot);
        Object.assign(groups[k],{start,end,basis:'available neighbor gap (up to 0.8 s per cue)'});
        cursor = end;
      }
    } else {
      // A point exactly between touching phrases has no unoccupied interval. Keep
      // all text/cue limits by sharing the preceding phrase's display time; a leading
      // point run shares the following phrase. All affected cues get review notes.
      const first = i>0 ? i-1 : i, last = i>0 ? j : j+1;
      const context = groups.slice(first,last), anchor = i>0 ? groups[i-1] : groups[j];
      const start = anchor?.start, end = anchor?.end;
      if (!(end > start)) throw new Error('No positive scene interval is available for point-timed words. Lengthen the scene or review narration lead; source words were kept unchanged.');
      const total = context.reduce((sum,g)=>sum+textOf(g).length,0);
      let used = 0, cursor = start;
      for (const g of context) {
        used += textOf(g).length;
        const boundary = used===total ? end : start+(end-start)*used/total;
        Object.assign(g,{start:cursor,end:boundary,basis:'shared neighboring phrase interval (text-length proportions)'});
        cursor = boundary;
      }
    }
    i = j;
  }
  const cues = validateCues(groups.map(g=>({text:textOf(g),start:cleanTime(g.start),end:Math.min(duration,cleanTime(g.end))})),duration);
  const inferences = groups.flatMap((g,i) => {
    const sourceWords = g.words.filter(w=>w.point).map(w=>w.index);
    return sourceWords.length || g.basis ? [{cue:i+1,sourceWords,start:cues[i].start,end:cues[i].end,basis:g.basis ?? 'phrase context'}] : [];
  });
  return {cues,inferences};
}
export const deriveCues = (words,lead,duration) => deriveCaptionDraft(words,lead,duration).cues;
