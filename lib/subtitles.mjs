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
export function deriveCues(words,lead,duration) {
  if(!Array.isArray(words) || !words.length) throw new Error('Timed narration words are required. Add word timings for this scene first with set_narration_words.');
  if(!Number.isFinite(lead) || lead<0) throw new Error('Narration lead must be finite and non-negative.');
  const cues=[];let group=[];
  const flush=()=>{if(group.length){cues.push({text:group.map(w=>w.word).join(' '),start:group[0].start,end:group.at(-1).end});group=[];}};
  let prior=0;
  for(const [i,w] of words.entries()) {
    if(!w || typeof w.word!=='string' || !w.word.trim() || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start<prior || w.end<=w.start) throw new Error(`Source word ${i+1} has missing, overlapping or zero-length timing. Review transcript timings before generating captions.`);
    prior=w.end;
    const next={word:w.word.trim(),start:Number((w.start+lead).toFixed(6)),end:Number((w.end+lead).toFixed(6))};
    if(group.length && (group.map(x=>x.word).join(' ').length+1+next.word.length>72 || group.length>=10 || next.end-group[0].start>5 || next.start-group.at(-1).end>.6)) flush();
    group.push(next);
    if(/[.!?…][”"')\]]?$/.test(next.word)) flush();
  }
  flush();
  return validateCues(cues,duration);
}
