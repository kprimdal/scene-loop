// Built-in styles are original, dependency-free treatments. The complete descriptor and CSS
// travel with each scene's HTML; rendering and history never consult the current catalog.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const catalogUrl = new URL('../catalog/styles/index.json', import.meta.url);
const BLOCK = /<!-- scene-loop:style ([A-Za-z0-9+/=]+) -->\n<style>[\s\S]*?<\/style>\n<!-- \/scene-loop:style -->\n?/g;
export const withoutStyle = (html) => html.replace(BLOCK, '');
export function pinnedStyle(html) {
  const match = [...html.matchAll(BLOCK)][0];
  if (!match) return null;
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}
export function withStyle(html, style) {
  const clean = withoutStyle(html);
  if (!style) return clean;
  if (!/<\/template>(?=\s*$)/.test(clean)) throw new Error("Keep the closing </template> to preserve the pinned style");
  const block = `<!-- scene-loop:style ${Buffer.from(JSON.stringify(style)).toString('base64')} -->\n<style>\n${style.css}\n</style>\n<!-- /scene-loop:style -->\n`;
  return clean.replace(/<\/template>(?=\s*$)/, () => `${block}</template>`);
}
export function listStyles() {
  return JSON.parse(readFileSync(catalogUrl, 'utf8')).map((style) => ({ ...style, contentHash: createHash('sha256').update(JSON.stringify(style)).digest('hex') }));
}
export function inspectStyle(id) {
  const style = listStyles().find((s) => s.id === id);
  if (!style) throw new Error(`Unknown style ${id}`);
  return style;
}

// One original example, with the same authored motion in each treatment. No sample content
// is inserted into a user's scene when a style is applied.
export function styleExample(style) {
  return withStyle(`<template>
<style>
#root { width:960px;height:540px;padding:48px 52px;background:#fff;color:#172221;font-family:Arial,sans-serif; }
#root .eyebrow { font-size:14px;letter-spacing:.18em;text-transform:uppercase; }
#root h1 { font-size:60px;line-height:1.03;letter-spacing:-.04em;margin:30px 0 16px;max-width:650px;animation:library-example-rise .8s .1s both; }
#root p {font-size:21px;line-height:1.5;margin:0;animation:library-example-rise .8s .3s both;}
#root .steps {display:flex;gap:16px;margin-top:36px;}
#root .step {flex:1;padding:20px;font-size:21px;border:1px solid;animation:library-example-rise .7s both;}
#root .step:nth-child(1){animation-delay:.5s} #root .step:nth-child(2){animation-delay:.8s} #root .step:nth-child(3){animation-delay:1.1s}
#root .step b {display:block;font-size:13px;margin-bottom:12px;letter-spacing:.1em;}
#root .line {height:5px;transform-origin:left;margin-top:32px;animation:library-example-line 2s .5s both;}
@keyframes library-example-rise {from {opacity:0;transform:translateY(22px)}}
@keyframes library-example-line {from {transform:scaleX(0)}}
</style>
<div id="root" data-composition-id="library-example" data-width="960" data-height="540" data-duration="4">
<div class="eyebrow" data-sl-muted>A small idea, clearly told</div>
<h1>Make room for<br><em data-sl-accent>the next idea.</em></h1>
<p data-sl-muted>From a first thought to something worth sharing.</p>
<div class="steps"><div class="step" data-sl-surface><b data-sl-accent>01 / NOTICE</b>Find the spark</div><div class="step" data-sl-surface><b data-sl-accent>02 / SHAPE</b>Give it focus</div><div class="step" data-sl-surface><b data-sl-accent>03 / SHARE</b>Let it travel</div></div>
<div class="line" data-sl-fill></div>
</div>
</template>`, style);
}
