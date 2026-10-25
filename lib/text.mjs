// A pinned, generated block inside the scene root. Scene history owns the complete state.
import { textMarkup, validateTexts } from '../public/js/text-core.js';
export { validateTexts };
const BLOCK = /<!-- scene-loop:text ([A-Za-z0-9+/=]+) -->\n[\s\S]*?<!-- \/scene-loop:text -->\n?/g;
export const withoutTexts = (html) => html.replace(BLOCK, '');
export function sceneTexts(html) {
  const match = [...html.matchAll(BLOCK)][0];
  return match ? JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) : [];
}
export function withTexts(html, scene, items) {
  const clean = withoutTexts(html);
  if (!items.length) return clean;
  const root = /<div\b[^>]*\bid="root"[^>]*>/;
  if (!root.test(clean)) throw new Error('Keep <div id="root"> to preserve scene text.');
  const block = `<!-- scene-loop:text ${Buffer.from(JSON.stringify(items)).toString('base64')} -->\n${textMarkup(scene, items)}\n<!-- /scene-loop:text -->\n`;
  return clean.replace(root, (open) => open + block);
}
