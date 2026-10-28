// Shared, bounded markup for saved captions. Used by lib/subtitles.mjs; the chat edits captions through the tools.
export const SUBTITLE_STYLES = {
  dark: { id: 'dark', version: 1, label: 'Dark card', css: 'background:#15202b!important;color:#fff!important;' },
  light: { id: 'light', version: 1, label: 'Light card', css: 'background:#fff!important;color:#15202b!important;' },
  shadow: { id: 'shadow', version: 1, label: 'White · shadow', css: 'background:transparent!important;color:#fff!important;text-shadow:0 2px 6px #000,0 0 3px #000!important;' },
};
export function validateCues(cues, duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Scene duration must be finite and positive.');
  if (!Array.isArray(cues) || cues.length > 200) throw new Error('Use at most 200 caption cues per scene.');
  let end = 0;
  return cues.map((c, i) => {
    if (!c || typeof c.text !== 'string' || !c.text.trim() || c.text.length > 84 || c.text.split(/\r\n|\r|\n/).length > 2 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c.text)) throw new Error(`Caption ${i+1}: enter 1–84 characters on at most 2 lines.`);
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < end || c.start < 0 || c.end <= c.start || c.end > duration || c.end-c.start > 8) throw new Error(`Caption ${i+1}: use ordered, non-overlapping 0 ≤ start < end ≤ ${duration} s, at most 8 s per cue. Edit or remove captions before shortening this scene.`);
    end = c.end;
    return { text: c.text, start: c.start, end: c.end };
  });
}
const escapeText = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function subtitleMarkup(scene, snapshot) {
  if (!snapshot) return '';
  if (!/^[a-zA-Z][\w-]*$/.test(scene)) throw new Error('Invalid caption scene id.');
  return snapshot.cues.map((c,i) => {
    const name = `sl-caption-${scene}-${i}`;
    return `<style data-sl-caption-css>@keyframes ${name}{from{opacity:1}to{opacity:0}}</style>
<div data-sl-caption="${i}" style="all:initial;position:absolute!important;inset:0!important;z-index:2147483100!important;pointer-events:none!important;box-sizing:border-box!important;padding:5% 6% 7%!important;display:flex!important;align-items:flex-end!important;justify-content:center!important;visibility:inherit!important;opacity:0;animation:${name} ${c.end-c.start}s steps(1,end) ${c.start}s forwards!important;">
<div style="all:initial;visibility:inherit!important;display:block!important;box-sizing:border-box!important;max-width:100%!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;text-align:center!important;font-family:Arial,Helvetica,sans-serif!important;font-size:min(5vw,5vh)!important;font-weight:700!important;line-height:1.25!important;padding:.25em .5em!important;border-radius:.15em!important;${snapshot.style.css}">${escapeText(c.text)}</div></div>`;
  }).join('\n');
}
