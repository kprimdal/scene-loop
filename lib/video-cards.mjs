// Cards attached to one video: the techniques and workflows the chat should follow while it
// works on it. Each attachment is a full copy of the card as it was (cardBrief), so a later
// change in the library never changes what a video was told; get_rules returns these copies
// after the project instructions. Attachments live in the video's cards.json, committed to the
// video's project-file history, with up to ten undo steps.
//
// Videos from before the card library kept guides.json (attached task guides). Until the first
// change, those copies are read as attached workflow cards; the first change writes cards.json.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cardBrief, getCard, hashOf } from "./cards.mjs";

export const MAX_CARDS = 12;
export const ATTACHABLE = ["technique", "workflow"];
export const CARD_HISTORY = "Attached cards belong to cards.json in this video's project-file history (.history, project/vN), separate from scene HTML. undo_cards restores only the previous attachment set (up to 10 changes, including removals); it keeps scene edits, narration, storyboard, pins and project instructions. Library changes never rewrite saved copies: detach and attach again to take a newer version.";

export function cardHandoff(brief, project, video) {
  return `Use this card ONCE for project ${JSON.stringify(project)}, video ${JSON.stringify(video)}. Do not attach it. Read get_rules for this exact project/video first; project instructions and my rules take priority.\n\n${brief.prompt ?? brief.what ?? brief.summary}\n\nThe card (id, version, content hash, what, when, sources):\n${JSON.stringify(brief, null, 2)}`;
}

export function createCardStore(dir, history) {
  const file = join(dir, "cards.json"), legacy = join(dir, "guides.json");
  const empty = () => ({ revision: "initial", items: [], undo: [] });
  function read() {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    if (existsSync(legacy)) {
      const g = JSON.parse(readFileSync(legacy, "utf8"));
      return { revision: g.revision ?? "initial", items: (g.items ?? []).map((x) => ({ ...x, kind: "workflow", stage: "workflow" })), undo: [] };
    }
    return empty();
  }
  const info = () => { const s = read(); return { items: s.items, contextHash: hashOf(s), undoCount: s.undo.length, limit: MAX_CARDS, history: CARD_HISTORY }; };

  async function change(action, b) {
    const s = read();
    if (b.contextHash && b.contextHash !== hashOf(s)) throw new Error("Attached cards changed. Refresh the video's cards before trying again.");
    let next;
    if (action === "attach") {
      const card = getCard(b.card, ATTACHABLE);
      if ((b.version && b.version !== card.version) || (b.contentHash && b.contentHash !== card.contentHash)) throw new Error("This card changed in the library. Get it again before attaching.");
      const current = s.items.find((x) => x.id === card.id);
      if (current) {
        if (current.contentHash !== card.contentHash) throw new Error("An older copy of this card is attached. Detach it first to take the new version.");
        return { ...info(), unchanged: true };
      }
      if (s.items.length >= MAX_CARDS) throw new Error(`At most ${MAX_CARDS} cards can be attached to one video. Detach one first.`);
      next = { ...s, items: [...s.items, cardBrief(card)], undo: [...s.undo, s.items].slice(-10) };
    } else if (action === "detach") {
      if (!s.items.some((x) => x.id === b.card)) throw new Error(`"${b.card}" is not attached to this video.`);
      next = { ...s, items: s.items.filter((x) => x.id !== b.card), undo: [...s.undo, s.items].slice(-10) };
    } else if (action === "undo") {
      if (!s.undo.length) throw new Error("No card attachment change to undo.");
      next = { ...s, items: s.undo.at(-1), undo: s.undo.slice(0, -1) };
    } else throw new Error("Unknown card action.");
    next.revision = randomUUID(); // a stale form after attach/detach/undo is rejected (ABA)
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    writeFileSync(file + ".tmp", JSON.stringify(next, null, 2) + "\n");
    renameSync(file + ".tmp", file);
    let version;
    try { version = await history.commitProject(["cards.json"], `${action} card${b.card ? ": " + b.card : " attachment change"}`, b.model ?? "Library"); }
    catch (error) {
      if (before === null) unlinkSync(file); else writeFileSync(file, before);
      throw error;
    }
    return { ...info(), version };
  }
  return { info, change };
}
