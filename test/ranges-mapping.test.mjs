import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rangePlan,mapRangeWords,localMutes} from '../lib/ranges.mjs';
const s=[{from:1,to:2},{from:4,to:6}];
test('range composition preserves explicit bounds across previous cuts, including 50ms fragments',()=>{
  assert.deepEqual(rangePlan(s,[],{action:'remove',from:.5,to:1.5}).segments,[{from:1,to:1.5},{from:4.5,to:6}]);
  assert.deepEqual(rangePlan(s,[],{action:'keep',from:.95,to:1.2}).segments,[{from:1.95,to:2},{from:4,to:4.2}]);
  assert.throws(()=>rangePlan(s,[],{action:'remove',from:.01,to:1}),/50 ms/);
  for(const [from,to] of [[NaN,1],[0,Infinity],[-1,1],[0,4],[1,1],[0,3]])assert.throws(()=>rangePlan(s,[],{action:'remove',from,to}));
  assert.throws(()=>rangePlan(s,[],{action:'keep',from:.0001,to:.0002}),/empty/);
});
test('mute uses original coordinates and follows future cuts',()=>{
  const p=rangePlan(s,[],{action:'mute',from:.8,to:1.2});
  assert.deepEqual(p.mutes,[{from:1.8,to:2},{from:4,to:4.2}]);
  const cut=rangePlan(s,p.mutes,{action:'keep',from:.9,to:2});
  assert.deepEqual(localMutes(cut.segments,cut.mutes),[{from:0,to:.3}]);
});
test('words include partials and half-open points with exact removal reports',()=>{
  const r=mapRangeWords([{word:'partial',start:.4,end:1.6},{word:'gone',start:.8,end:1},{word:'point',start:1.5,end:1.5},{word:'end',start:3,end:3}],[{from:0,to:.5},{from:1.5,to:3}]);
  assert.deepEqual(r.words.map(w=>[w.word,w.start,w.end]),[['partial',.4,.6],['point',.5,.5]]);
  assert.deepEqual(r.removed.map(w=>w.word),['gone','end']);assert.equal(r.affected.length,1);
});
