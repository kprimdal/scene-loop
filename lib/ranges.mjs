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
// remove also takes ranges: [{from,to}|[from,to], ...], the parts a split edit marks for removal.
// They are one edit (one preview, one undo); touching or overlapping ranges merge.
export function rangePlan(segments,mutes,{action,from,to,ranges},seconds=span(segments)) {
  if(!['remove','mute','keep'].includes(action)) throw new Error('Action must be remove, mute or keep.');
  if(ranges!=null && action!=='remove') throw new Error('ranges is only for remove; mute and keep take from and to.');
  if(ranges!=null && (!Array.isArray(ranges) || !ranges.length)) throw new Error('ranges is a non-empty list of {from, to} in recording seconds.');
  const list=(ranges??[{from,to}]).map(r=>Array.isArray(r)?{from:r[0],to:r[1]}:r??{});
  const cuts=mergeRanges(list.map(({from,to})=>{
    if(typeof from!=='number'||typeof to!=='number'||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to>seconds+1e-8||to<=from) throw new Error(`Use finite recording seconds: 0 ≤ start < end ≤ ${seconds}.`);
    const a=ms(from),b=ms(to);
    if(b<=a) throw new Error('Range is empty at 1 ms precision. Use at least 1 ms.');
    return {from:a,to:b};
  }));
  const a=cuts[0].from,b=cuts.at(-1).to;
  const duration=span(segments);
  if(Math.abs(duration-seconds)>.002) throw new Error('Selected audio duration disagrees with its saved take mapping. Choose the take again before range editing.');
  const gaps=[];let at=0;
  for(const c of cuts){if(c.from>at)gaps.push({from:at,to:c.from});at=c.to;}
  if(at<duration)gaps.push({from:at,to:duration});
  const windows=action==='keep'?[{from:a,to:b}]:action==='remove'?gaps:[{from:0,to:duration}];
  const next=windows.flatMap(w=>intersect(segments,w.from,w.to));
  if(!next.length) throw new Error('The edit would remove the entire recording. Keep at least 50 ms.');
  if(action!=='mute') for(const s of next) if(s.to-s.from<.05-1e-8) throw new Error(`Retained original range ${s.from}–${s.to} s is shorter than the 50 ms minimum. Adjust the selection; no speech was dropped.`);
  return {action,requested:ranges!=null?{ranges}:{from,to},selection:{from:a,to:b},...(ranges!=null?{ranges:cuts}:{}),windows,segments:next,mutes:action==='mute'?mergeRanges([...(mutes??[]),...intersect(segments,a,b)]):structuredClone(mutes??[]),seconds:span(next)};
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
