// Original guidance only. No model calls, project instruction edits or scene changes.
import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const catalogue = new URL('../catalog/guides/index.json', import.meta.url);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const listGuides = () => JSON.parse(readFileSync(catalogue, 'utf8')).map(p => ({...p, contentHash:hash(p)}));
export function inspectGuide(id, expected = {}) {
  const p = listGuides().find(p => p.id === id);
  if (!p) throw new Error('Unknown guide. Use list_guides for the four available choices.');
  if ((expected.version && expected.version !== p.version) || (expected.contentHash && expected.contentHash !== p.contentHash)) throw new Error('This guide changed in the catalogue. Inspect it again.');
  return p;
}
export function guideHandoff(snapshot, project, video) {
  return `Use this guide ONCE for project ${JSON.stringify(project)}, video ${JSON.stringify(video)}. Do not attach it as persistent guidance. Read get_rules for this exact project/video first; project instructions and my rules take priority. This selection has not executed any task.\n\n${snapshot.prompt}\n\nExact guide snapshot (id, version, SHA-256 content hash, workflow, original example and checklist):\n${JSON.stringify(snapshot, null, 2)}`;
}
export const GUIDE_HISTORY = 'Guide attachments belong to guides.json in this video’s project-file history (.history, project/vN), separate from scene HTML. undo_guides restores only the previous attachment set (up to 10 changes, including removals); it keeps scene edits, narration, storyboard, pins and project instructions. Catalogue updates never rewrite saved copies.';

// Called by openVideo. All mutations hold its impossible-to-collide :guides lock.
export function createGuideStore(dir, history) {
  const file = join(dir, 'guides.json');
  const empty = () => ({ revision:'initial', items:[], undo:[] });
  const read = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : empty();
  const info = () => {
    const s = read();
    return {items:s.items, contextHash:hash(s), undoCount:s.undo.length, history:GUIDE_HISTORY};
  };
  async function change(action, b) {
    const s = read();
    if (b.contextHash && b.contextHash !== hash(s)) throw new Error('Guide attachments changed. Refresh the selected video before trying again.');
    let next;
    if (action === 'attach') {
      const p = inspectGuide(b.guide, b);
      const current = s.items.find(x => x.id === p.id);
      if (current) {
        if (current.contentHash !== p.contentHash) throw new Error('An older copy of this guide is attached. Remove it first to choose the new version.');
        return {...info(), unchanged:true};
      }
      if (s.items.length >= 4) throw new Error('At most four different guides can be attached.');
      next = {...s, items:[...s.items, p], undo:[...s.undo, s.items].slice(-10)};
    } else if (action === 'remove') {
      if (!s.items.some(x => x.id === b.guide)) throw new Error('This guide is not attached to the selected video.');
      next = {...s, items:s.items.filter(x => x.id !== b.guide), undo:[...s.undo, s.items].slice(-10)};
    } else if (action === 'undo') {
      if (!s.undo.length) throw new Error('No guide attachment change to undo.');
      next = {...s, items:s.undo.at(-1), undo:s.undo.slice(0,-1)};
    } else throw new Error('Unknown guide action.');
    next.revision = randomUUID(); // prevents stale forms after attach/remove/undo (ABA)
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const temp = file + '.tmp';
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n');
    renameSync(temp, file);
    let version;
    try { version = await history.commitProject(['guides.json'], `${action} guide${b.guide ? ': '+b.guide : ' attachment change'}`, b.model ?? 'Guide controls'); }
    catch (error) {
      if (before === null) unlinkSync(file); else writeFileSync(file, before);
      throw error;
    }
    return {...info(), version};
  }
  return {info, change};
}
