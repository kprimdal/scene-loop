// Shared by the saved HTML and the page's unsaved preview. No user-provided markup or CSS.
export const TEXT_POSITIONS = { title: 'Centre title', heading: 'Top heading', lower: 'Lower third' };
export const TEXT_STYLES = { plain: 'White · shadow', dark: 'Dark card', light: 'Light card' };
export const MAX_TEXTS = 4;
export function validateTexts(items, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Scene duration must be finite and positive.');
  if (!Array.isArray(items) || items.length > MAX_TEXTS) throw new Error(`Use at most ${MAX_TEXTS} text items per scene.`);
  const ids = new Set();
  return items.map((item) => {
    if (!item || typeof item !== 'object' || !/^text-[a-z0-9-]{1,48}$/.test(item.id) || ids.has(item.id)) throw new Error('Text items need unique text-… ids (letters, digits and hyphens).');
    ids.add(item.id);
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 240 || item.text.split(/\r\n|\r|\n/).length > 4 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item.text)) throw new Error('Enter 1–240 characters on at most 4 lines.');
    if (!Object.hasOwn(TEXT_POSITIONS, item.position)) throw new Error('Position: title, heading or lower.');
    if (!Object.hasOwn(TEXT_STYLES, item.style)) throw new Error('Style: plain, dark or light.');
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start || item.end > duration) throw new Error(`${item.id}: use 0 ≤ start < end ≤ ${duration} s. Edit or remove this text before shortening the scene.`);
    return { id: item.id, text: item.text, position: item.position, style: item.style, start: item.start, end: item.end };
  });
}
const escapeText = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function textMarkup(scene, items) {
  if (!/^[a-zA-Z][\w-]*$/.test(scene)) throw new Error('Invalid scene id for text.');
  return items.map((item) => {
    const name = `sl-text-${scene}-${item.id}`;
    const small = item.position === 'lower';
    const align = item.position === 'title' ? 'center' : item.position === 'heading' ? 'flex-start' : 'flex-end';
    const treatment = item.style === 'dark' ? 'background:#15202b!important;color:#fff!important;' : item.style === 'light' ? 'background:#fff!important;color:#15202b!important;' : 'background:transparent!important;color:#fff!important;text-shadow:0 2px 8px #000,0 0 2px #000!important;';
    // Discrete opacity is a normal CSS animation: the existing clock and render planner
    // seek and detect it. [start, end), including backwards seeks and end == scene duration.
    return `<style data-sl-text-css>@keyframes ${name}{from{opacity:1}to{opacity:0}}</style>
<div data-sl-text-item="${item.id}" style="all:initial;font-family:inherit!important;position:absolute!important;inset:0!important;z-index:2147483000!important;pointer-events:none!important;box-sizing:border-box!important;padding:6%!important;display:flex!important;align-items:${align}!important;justify-content:${small ? 'flex-start' : 'center'}!important;visibility:inherit!important;opacity:0;animation:${name} ${item.end - item.start}s steps(1,end) ${item.start}s forwards!important;">
<div style="all:initial;visibility:inherit!important;box-sizing:border-box!important;display:block!important;max-width:100%!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;text-align:${small ? 'left' : 'center'}!important;font-family:inherit!important;font-size:min(${small ? '3.2vw,4.8vh' : '5vw,7vh'})!important;font-weight:700!important;line-height:1.15!important;padding:.35em .55em!important;border-radius:.16em!important;${treatment}">${escapeText(item.text)}</div></div>`;
  }).join('\n');
}
