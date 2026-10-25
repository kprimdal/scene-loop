// Range editing uses the current edited recording clock, never original take seconds.
// All persisted bounds use the take pipeline's 1 ms precision. No small fragment is dropped.
export const ms = n => Math.round(n * 1000) / 1000;
export const span = segments => ms(segments.reduce((n,s)=>n+s.to-s.from,0));
export function intersect(segments, from, to) {
  let at=0; const out=[];
  for(const s of segments) {
    const end=at+s.to-s.from, a=Math.max(from,at), b=Math.min(to,end);
    if(b>a+1e-8) out.push({from:ms(s.from+a-at),to:ms(s.from+b-at)});
    at=end;
  }
  return out;
}
export function mergeRanges(ranges) {
  const out=[];
  for(const r of ranges.toSorted((a,b)=>a.from-b.from)) {
    if(out.length && r.from<=out.at(-1).to+1e-8) out.at(-1).to=Math.max(r.to,out.at(-1).to);
    else out.push({...r});
  }
  return out;
}
export function localMutes(segments,mutes=[]) {
  let at=0; const out=[];
  for(const s of segments) {
    for(const m of mutes) {
      const a=Math.max(s.from,m.from),b=Math.min(s.to,m.to);
      if(b>a) out.push({from:ms(at+a-s.from),to:ms(at+b-s.from)});
    }
    at+=s.to-s.from;
  }
  return mergeRanges(out);
}
export function rangePlan(segments,mutes,{action,from,to},seconds=span(segments)) {
  if(!['remove','mute','keep'].includes(action)) throw new Error('Action must be remove, mute or keep.');
  if(typeof from!=='number'||typeof to!=='number'||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to>seconds+1e-8||to<=from) throw new Error(`Use finite recording seconds: 0 ≤ start < end ≤ ${seconds}.`);
  const a=ms(from),b=ms(to);
  if(b<=a) throw new Error('Range is empty at 1 ms precision. Use at least 1 ms.');
  const duration=span(segments);
  if(Math.abs(duration-seconds)>.002) throw new Error('Selected audio duration disagrees with its saved take mapping. Choose the take again before range editing.');
  const windows=action==='keep'?[{from:a,to:b}]:action==='remove'?[...(a>0?[{from:0,to:a}]:[]),...(b<duration?[{from:b,to:duration}]:[])]:[{from:0,to:duration}];
  const next=windows.flatMap(w=>intersect(segments,w.from,w.to));
  if(!next.length) throw new Error('The edit would remove the entire recording. Keep at least 50 ms.');
  if(action!=='mute') for(const s of next) if(s.to-s.from<.05-1e-8) throw new Error(`Retained original range ${s.from}–${s.to} s is shorter than the 50 ms minimum. Adjust the selection; no speech was dropped.`);
  return {action,requested:{from,to},selection:{from:a,to:b},windows,segments:next,mutes:action==='mute'?mergeRanges([...(mutes??[]),...intersect(segments,a,b)]):structuredClone(mutes??[]),seconds:span(next)};
}
// Partial words retain their text and the surviving span; an interior cut joins their pieces.
// Point words survive only inside a half-open retained window (a point at audio end is out).
export function mapRangeWords(words,windows) {
  const kept=[],removed=[],affected=[];
  for(const [index,w] of (words??[]).entries()) {
    if(!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.end<w.start) throw new Error(`Word ${index+1} has invalid timing. Review transcript before editing.`);
    let offset=0; const pieces=[];
    for(const win of windows) {
      const a=Math.max(win.from,w.start),b=Math.min(win.to,w.end);
      if(b>a || (w.start===w.end && w.start>=win.from && w.start<win.to)) pieces.push({start:ms(offset+a-win.from),end:ms(offset+b-win.from),length:Math.max(0,b-a)});
      offset+=win.to-win.from;
    }
    const item={index:index+1,word:w.word,start:w.start,end:w.end};
    if(!pieces.length) {removed.push(item);continue;}
    const next={...w,start:pieces[0].start,end:pieces.at(-1).end};kept.push(next);
    if(pieces.reduce((n,p)=>n+p.length,0)<w.end-w.start-1e-6) affected.push({...item,after:next,reason:'Partially cut word: text retained, timing clipped to surviving audio. Review speech and anchors.'});
  }
  return {words:kept,removed,affected};
}
