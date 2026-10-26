// Original starting points, compiled once to editable HTML. No catalog access at playback.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { listCards, patternOf } from './cards.mjs';
const BLOCK = /<!-- scene-loop:pattern ([A-Za-z0-9+/=]+) -->\n?/g;
export function pinnedPattern(html) {
  const match = [...html.matchAll(BLOCK)][0];
  return match ? JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) : null;
}
export function withPattern(html, pattern) {
  const clean = html.replace(BLOCK, '');
  return pattern ? `<!-- scene-loop:pattern ${Buffer.from(JSON.stringify(pattern)).toString('base64')} -->\n${clean}` : clean;
}
// Include renderer source in the hash: a layout change must also invalidate an inspected card.
export function listPatterns() {
  const renderer = readFileSync(new URL('./patterns.mjs', import.meta.url), 'utf8');
  return listCards().filter(c => c.kind === 'pattern').map(patternOf).map(p => ({ ...p, contentHash: createHash('sha256').update(JSON.stringify(p) + renderer).digest('hex') }));
}
export function inspectPattern(id) {
  const p = listPatterns().find(p => p.id === id);
  if (!p) throw new Error(`Unknown pattern ${id}`);
  return p;
}
export function validatePattern(p, inputs = p.defaults) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('inputs must be an object');
  if (Object.keys(inputs).some(k => !p.fields.some(f => f.key === k))) throw new Error('Unknown pattern input');
  const out = {};
  for (const f of p.fields) {
    const clean = (s) => {
      if (typeof s !== 'string' || (!s.trim() && !f.optional) || s.trim().length > f.max || /[\u0000-\u0008\u000b-\u001f]/.test(s)) throw new Error(`${f.label}: ${f.optional ? '0' : '1'}–${f.max} text characters${f.minItems ? ' per line' : ''}`);
      return s.trim();
    };
    const v = inputs[f.key] ?? (f.optional ? '' : undefined);
    if (f.minItems) {
      if (!Array.isArray(v) || v.length < f.minItems || v.length > f.maxItems) throw new Error(`${f.label}: ${f.minItems}–${f.maxItems} lines`);
      out[f.key] = v.map(clean);
    } else out[f.key] = clean(v);
  }
  return out;
}
export function patternMedia(dir, media) {
  if (!media) return null;
  if (!/^assets\/[\w /.-]+$/.test(media) || media.split('/').some(s => s === '..' || s === '.') || media.includes('//')) throw new Error('media must be a local path under this video’s assets/');
  let file, root;
  try { root = realpathSync(resolve(dir, 'assets')); file = realpathSync(resolve(dir, media)); }
  catch { throw new Error('Project media does not exist'); }
  if (!file.startsWith(root + sep) || !file.startsWith(realpathSync(dir) + sep) || !statSync(file).isFile()) throw new Error('Project media must stay inside this video’s assets/');
  const ext = extname(file).toLowerCase();
  if (/^\.(mp4|webm|mov)$/.test(ext)) return 'video';
  if (/^\.(png|jpg|jpeg|webp)$/.test(ext)) return 'image';
  throw new Error('Project media must be mp4, webm, mov, png, jpg, jpeg or webp');
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function patternHtml(p, { id, width = 1920, height = 1080, duration = 8, inputs, mediaKind = null }) {
  if (!/^[a-z][\w-]*$/.test(id)) throw new Error('Invalid scene id');
  if (![width,height].every(n => Number.isFinite(n) && n >= 240 && n <= 7680) || !Number.isFinite(duration) || duration < 3 || duration > 60) throw new Error('Patterns need a 240–7680 px canvas and 3–60 seconds');
  const v = validatePattern(p, inputs), portrait = height >= width * 1.5, compact = !portrait && width / height < 1.5, u = Math.min(width,height) / 540;
  const px = n => `${+(n*u).toFixed(2)}px`, delay = n => +(duration * n).toFixed(3);
  const items = (list, numbered = false) => list.map((t,i) => `<div class="pat-item" data-sl-surface style="animation-delay:${delay(.12+i*.1)}s">${numbered ? `<span class="pat-number" data-sl-accent>${String(i+1).padStart(2,'0')}</span>` : '<span class="pat-dot" data-sl-fill></span>'}<p>${esc(t)}</p></div>`).join('');
  let body;
  if ((p.layout ?? p.id) === 'process') body = `<div class="pat-process">${items(v.steps,true)}</div>`;
  else if ((p.layout ?? p.id) === 'comparison') body = `<div class="pat-compare">${[['leftLabel','leftPoints'],['rightLabel','rightPoints']].map(([label,points],i) => `<section class="pat-panel" data-sl-surface style="animation-delay:${delay(.06+i*.08)}s"><div class="pat-side" data-sl-accent>${i===0?'A':'B'}</div><h2>${esc(v[label])}</h2>${items(v[points])}</section>`).join('')}</div>`;
  else {
    if (v.media && !['video','image'].includes(mediaKind)) throw new Error('Validate project media before generating a presenter');
    const media = !v.media ? '<div class="pat-standin"><div class="pat-person"></div><span>Visual placeholder · replace with your media</span></div>' : mediaKind === 'video' ? `<video class="cam" src="${esc(v.media)}" muted playsinline preload="auto"></video>` : `<img src="${esc(v.media)}" alt="${esc(v.name)}">`;
    body = `<div class="pat-presenter"><div class="pat-portrait">${media}<div class="pat-name"><strong>${esc(v.name)}</strong><span>${esc(v.label)}</span></div></div><div class="pat-support">${items(v.points,true)}</div></div>`;
  }
  const html = `<template>
<style>
#root{box-sizing:border-box;position:absolute;inset:0;width:${width}px;height:${height}px;padding:${px(portrait||compact?32:38)};overflow:hidden;background:var(--sl-background,#f4f3ed);color:var(--sl-ink,#1b3433);font-family:Arial,sans-serif;display:flex;flex-direction:column;gap:${px(24)}}
#root *{box-sizing:border-box} #root p,#root h1,#root h2{margin:0;overflow-wrap:anywhere}
#root .pat-kicker{font-size:${px(11)};letter-spacing:.18em;text-transform:uppercase;color:var(--sl-muted,#526663);margin-bottom:${px(12)}}
#root h1{font-size:${px(portrait?35:compact?32:39)};line-height:1.12;letter-spacing:-.035em;max-width:100%;animation:${id}-rise ${delay(.09)}s both}
#root .pat-process,#root .pat-compare,#root .pat-presenter{display:grid;gap:${px(16)};flex:1;min-height:0}
#root .pat-process{grid-template-columns:${portrait?'1fr':`repeat(${compact?Math.min(2,v.steps?.length??2):v.steps?.length??3},minmax(0,1fr))`}}
#root .pat-item{min-width:0;padding:${px(compact?14:20)};border:1px solid var(--sl-border,#ced8ce);border-radius:${px(12)};background:var(--sl-surface,#fffdf7);animation:${id}-rise ${delay(.09)}s both;display:flex;flex-direction:${portrait&&(p.layout??p.id)==='process'?'row':'column'};gap:${px(compact?10:14)};justify-content:center}
#root .pat-item p{font-size:${px((p.layout??p.id)==='comparison'?(compact?14:18):(compact?18:23))};line-height:1.3}
#root .pat-number{font-size:${px(compact?14:17)};font-weight:700;color:var(--sl-accent,#287b69)}
#root .pat-compare{grid-template-columns:${portrait?'1fr':'1fr 1fr'}}
#root .pat-panel{min-height:0;min-width:0;border-radius:${px(14)};border:1px solid var(--sl-border,#ced8ce);background:var(--sl-surface,#fffdf7);padding:${px(compact?14:22)};animation:${id}-rise ${delay(.1)}s both}
#root .pat-side{font-size:${px(12)};color:var(--sl-accent,#287b69);margin-bottom:${px(10)}}
#root h2{font-size:${px(compact?23:27)};line-height:1.14;margin-bottom:${px(14)}}
#root .pat-panel .pat-item{border:0;padding:${px(compact?5:7)} 0;border-radius:0;flex-direction:row;justify-content:start;align-items:baseline;background:transparent}
#root .pat-dot{width:${px(6)};height:${px(6)};border-radius:50%;flex-shrink:0;background:var(--sl-accent,#287b69)}
#root .pat-presenter{grid-template-columns:${portrait?'1fr':'1fr 1.1fr'};${portrait?'grid-template-rows:1fr 1fr;':''}}
#root .pat-portrait{min-height:0;position:relative;overflow:hidden;border-radius:${px(16)};background:#d6dfda}
#root .pat-portrait video,#root .pat-portrait img{position:absolute;width:100%;height:100%;object-fit:cover}
#root .pat-standin{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ccded5,#9bbcad)}
#root .pat-standin>span{position:absolute;top:${px(12)};left:${px(14)};right:${px(14)};font-size:${px(11)};color:#203f36}
#root .pat-person{width:58%;height:62%;border-radius:50% 50% 0 0;background:#456f63;position:absolute;bottom:0}
#root .pat-person:before{content:"";position:absolute;width:48%;aspect-ratio:1;border-radius:50%;background:#e9c9a6;left:26%;top:-28%}
#root .pat-name{position:absolute;bottom:0;left:0;right:0;background:#142e28e8;color:#fff;padding:${px(17)}}
#root .pat-name strong{display:block;font-size:${px(23)};line-height:1.15;overflow-wrap:anywhere} #root .pat-name span{display:block;font-size:${px(14)};line-height:1.3;margin-top:${px(5)};overflow-wrap:anywhere}
#root .pat-support{display:grid;gap:${px(10)};min-height:0} #root .pat-support .pat-item{padding:${px(compact?10:14)};gap:${px(8)}}
#root .pat-support .pat-item p{font-size:${px(portrait?19:compact?15:21)}}
${portrait||compact?'#root .pat-support .pat-item{flex-direction:row;align-items:center}':''}
@keyframes ${id}-rise{from{opacity:0;transform:translateY(${px(18)})}to{opacity:1;transform:translateY(0)}}
</style>
<div id="root" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
<header><div class="pat-kicker" data-sl-muted>${esc(p.title)} / ${(p.layout??p.id)==='process'?'one step at a time':(p.layout??p.id)==='comparison'?'two perspectives':'ideas in focus'}</div><h1 data-sl-heading>${esc(v.heading)}</h1></header>
${body}
</div>
</template>`;
  return withPattern(html, { ...p, inputs:v, canvas:{width,height}, duration, mediaKind, contract:'Starting point only. Inputs record creation, not subsequent authored edits. Edit HTML normally; restore through scene history.' });
}
export const patternExample = p => patternHtml(p, { id:'library-example',width:960,height:540,duration:4,inputs:p.defaults });
