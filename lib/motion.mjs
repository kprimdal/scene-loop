import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { withPage } from './chrome.mjs';
import { resolveMotionTime, motionTargetsInPage, installMotion } from './motion-runtime.mjs';
export { resolveMotionTime };
import { listCards, motionOf } from './cards.mjs';
const BLOCK = /<!-- scene-loop:motion ([A-Za-z0-9+/=]+) -->\n[\s\S]*?<!-- \/scene-loop:motion -->\n?/g;
export const withoutMotion = html => html.replace(BLOCK,'');
export function sceneMotion(html) {
  const m=[...html.matchAll(BLOCK)][0];
  return m?JSON.parse(Buffer.from(m[1],'base64').toString('utf8')):[];
}
const runtime = `(${installMotion.toString()})(SCENE, ITEMS, ${motionTargetsInPage.toString()}, ${resolveMotionTime.toString()});`;
export function listMotions() {
  const source = readFileSync(new URL('./motion.mjs',import.meta.url),'utf8');
  return listCards().filter(c=>c.kind==='motion'||c.kind==='transition').map(motionOf).map(p=>({...p,contentHash:createHash('sha256').update(JSON.stringify(p)+runtime+source).digest('hex')}));
}
export function inspectMotion(id) {
  const p=listMotions().find(p=>p.id===id);
  if (!p) throw new Error(`Unknown motion ${id}`);
  return p;
}
export const pinMotion = effect => ({...effect,runtime});
const json = v => JSON.stringify(v).replaceAll('<','\\u003c');
export function withMotion(html,scene,items) {
  const clean=withoutMotion(html);
  if (!items.length) return clean;
  if (!/^[a-zA-Z][\w-]*$/.test(scene) || !/<\/template>\s*$/.test(clean)) throw new Error('Keep the scene id and closing </template> to preserve motion.');
  const scripts=items.map(item=> `<script>${item.effect.runtime.replace('SCENE',json(scene)).replace('ITEMS',()=>json([{...item,effect:{...item.effect,runtime:undefined}}]))}</script>`).join('\n');
  return clean.replace(/<\/template>\s*$/,`<!-- scene-loop:motion ${Buffer.from(JSON.stringify(items)).toString('base64')} -->\n${scripts}\n<!-- /scene-loop:motion -->\n</template>`);
}
export function validateMotion(items,duration) {
  if (!Number.isFinite(duration) || duration<=0) throw new Error('Motion needs a positive scene duration.');
  if (!Array.isArray(items) || items.length>4) throw new Error('Use at most four motion choices per scene.');
  const ids=new Set();
  for (const m of items) {
    if (!m || !/^motion-[a-z0-9-]{1,48}$/.test(m.id) || ids.has(m.id)) throw new Error('Motion needs unique motion-… ids.');
    ids.add(m.id);
    if (!/^(scene|heading|named:[a-z][a-z0-9-]{0,39}|text:text-[a-z0-9-]{1,48})$/.test(m.target)) throw new Error('Choose a target from get_scene_motion. CSS selectors are not accepted.');
    if (!Number.isFinite(m.start) || !Number.isFinite(m.duration) || m.start<0 || m.duration<.05 || m.duration>5 || m.start+m.duration>duration+1e-6) throw new Error(`Motion needs 0 ≤ fallback start and 0.05–5 s duration ending by ${duration} s. Edit or remove motion before shortening the scene.`);
    if (m.anchor!=null && (typeof m.anchor!=='string' || m.anchor.length>160 || !m.anchor.split('|').every(s=>/^(?:word:[\p{L}\p{N}'’_-]+(?:#[1-9]\d{0,2})?|sentence:[1-9]\d{0,2})(?:[+-]\d*\.?\d+)?$/u.test(s)))) throw new Error('Anchor: word:hello, word:hello#2, sentence:2, offsets or | alternatives.');
    if (!m.effect || m.effect.kind!=='motion' || typeof m.effect.runtime!=='string') throw new Error('Motion must have its pinned implementation.');
  }
  return items;
}
// Chrome is our existing HTML/CSS parser. No regex parser or wrapper changes the layout.
export async function inspectMotionPage(build,scene,size) {
  return withPage(size,async page=> {
    await page.goto(pathToFileURL(join(build,'index.html')).href);
    await page.evaluate('window.__sl.ready');
    const targets=await page.evaluate(`(${motionTargetsInPage.toString()})(${json(scene)})`);
    const errors=await page.evaluate('window.__motionErrors || []');
    if (page.errors.length) throw new Error(`Scene error: ${page.errors.join('; ')}`);
    return {targets,errors};
  });
}
export function motionExample(p) {
  const id='library-example';
  let html=`<template><style>#root{background:#163b39;color:#fff;font-family:Arial;display:grid;place-items:center}#root .demo-card{width:580px;padding:55px;background:#d5f2bc;color:#163b39;border-radius:25px;font-size:45px;font-weight:bold}#root small{display:block;font-size:20px;margin-top:18px;font-weight:normal}</style><div id="root" data-composition-id="${id}"><div class="demo-card" data-motion-target="card" data-motion-label="Example card">One clear idea<small>Space to read. Time to understand.</small></div></div></template>`;
  if (p.kind==='motion') html=withMotion(html,id,[{id:'motion-example',target:'named:card',start:1,duration:p.duration,effect:pinMotion(p)}]);
  return html;
}
