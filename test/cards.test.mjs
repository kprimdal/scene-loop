import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRegistry, TEMPLATE_DIR } from '../lib/projects.mjs';
import { callTool, toolList } from '../lib/tools.mjs';
import { STARTER, loadLibrary, setLibraryDir, libraryDir, getCard, demoFile, styleOf, motionOf, patternOf, workflowOf } from '../lib/cards.mjs';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sl-cards-'));
  for (const [p, v] of [['one', 'demo'], ['one', 'other']]) cpSync(TEMPLATE_DIR, join(root, p, 'videos', v), { recursive: true });
  writeFileSync(join(root, 'one', 'project.md'), '# Scratch project\nKeep the language plain.\n');
  const registry = createRegistry(root, { reviewer: 'Tester', emit() {} }), video = await registry.get('one', 'demo');
  const ctx = { registry, via: 'webmcp', origin: 'http://localhost', defaults: { project: 'one', video: 'demo' } };
  const call = (name, args = {}) => callTool(name, { project: 'one', video: 'demo', model: 'Tester', ...args }, ctx);
  return { root, registry, video, ctx, call };
}
// A library of our own: the starter copied, so a test can break and add files.
function copyLibrary() {
  const dir = mkdtempSync(join(tmpdir(), 'sl-lib-'));
  cpSync(STARTER, dir, { recursive: true });
  return dir;
}
const technique = (id, extra = {}) => ({ id, kind: 'technique', version: '1', title: `Card ${id}`, summary: 'One line.', stage: 'hook', what: 'What it is.', when: 'When to use it.', status: 'missing', prompt: { text: 'Do the thing.', asShown: true }, sources: [{ source: 'scene-loop', at: '1:23' }], ...extra });

test('the starter library loads clean and gives the apply code the shapes it pins', () => {
  const lib = loadLibrary(STARTER);
  assert.deepEqual(lib.errors, []);
  assert.deepEqual(lib.cards.filter((c) => c.kind === 'style').map((c) => c.id), ['signal', 'paper', 'grove']);
  assert.deepEqual(lib.cards.filter((c) => ['motion', 'transition'].includes(c.kind)).map((c) => c.id), ['fade-in', 'fade-out', 'rise', 'pop', 'cut', 'dissolve']);
  assert.deepEqual(lib.cards.filter((c) => c.kind === 'pattern').map((c) => c.id), ['process', 'comparison', 'presenter']);
  assert.deepEqual(lib.cards.filter((c) => c.kind === 'workflow').map((c) => c.id), ['explain-concept', 'show-workflow', 'improve-pacing', 'review-video']);
  assert.deepEqual(Object.keys(styleOf(getCard('paper'))), ['id', 'kind', 'version', 'title', 'summary', 'tags', 'guidance', 'css']);
  assert.deepEqual(Object.keys(motionOf(getCard('rise'))), ['id', 'title', 'version', 'kind', 'summary', 'guidance', 'duration', 'keyframes', 'easing']);
  assert.deepEqual(Object.keys(motionOf(getCard('cut'))), ['id', 'title', 'version', 'kind', 'summary', 'guidance', 'duration']);
  assert.deepEqual(Object.keys(patternOf(getCard('process'))), ['id', 'version', 'title', 'summary', 'guidance', 'fields', 'defaults']);
  assert.deepEqual(Object.keys(workflowOf(getCard('review-video'))), ['id', 'title', 'summary', 'workflow', 'example', 'checklist', 'prompt', 'version', 'guidance']);
  assert.equal(execFileSync(process.execPath, ['bin/check-library.mjs'], { encoding: 'utf8' }).includes('17 cards'), true);
});

test('list_cards filters, get_card explains, and the old list/inspect tools are gone', async () => {
  const { call } = await fixture();
  for (const channel of ['page', 'mcp']) {
    const names = toolList(channel).map((t) => t.name);
    for (const n of ['list_cards', 'get_card', 'list_formats', 'list_sources', 'use_card_once', 'get_video_cards', 'attach_card', 'detach_card', 'undo_cards', 'apply_style', 'apply_motion', 'apply_transition', 'instantiate_pattern']) assert.ok(names.includes(n), n);
    for (const n of ['list_styles', 'inspect_style', 'list_patterns', 'inspect_pattern', 'list_motions', 'inspect_motion', 'list_guides', 'inspect_guide', 'attach_guide']) assert.ok(!names.includes(n), n);
  }
  const all = await call('list_cards');
  assert.equal(all.count, 17);
  assert.equal(all.library.stages[0].id, 'before-script');
  assert.deepEqual((await call('list_cards', { kind: 'pattern' })).items.map((c) => c.id), ['process', 'comparison', 'presenter']);
  assert.deepEqual((await call('list_cards', { status: 'have', kind: 'technique' })).items.map((c) => c.id), ['signal-the-word']);
  assert.deepEqual((await call('list_cards', { q: 'introduces' })).items.map((c) => c.id), ['signal-the-word']);
  assert.ok(all.items.find((c) => c.id === 'paper').previewUrl.startsWith('http://localhost/api/cards/paper/preview?contentHash='));
  assert.equal(all.items.find((c) => c.id === 'review-video').previewUrl, null);
  const paper = await call('get_card', { card: 'paper' });
  assert.match(paper.implementation.css, /--sl/);
  assert.equal(paper.implementation.contentHash.length, 64);
  assert.match(paper.use, /apply_style style:paper/);
  const process = await call('get_card', { card: 'process' });
  assert.match(process.implementation.exampleHtml, /pat-process/);
  const t = await call('get_card', { card: 'signal-the-word' });
  assert.equal(t.sources[0].title, "scene-loop's own originals");
  assert.equal(t.related[0].id, 'rise');
  assert.equal(t.implementation, null);
  await assert.rejects(call('get_card', { card: 'nope' }), /No card "nope"/);
  const formats = await call('list_formats');
  assert.deepEqual(formats.items.map((f) => f.id), ['widescreen']);
  assert.deepEqual(formats.items[0].cards.map((c) => c.id), ['signal-the-word', 'explain-concept']);
  const sources = await call('list_sources');
  assert.equal(sources.items[0].cards.length, 17);
});

test('the apply tools take card ids, and a changed card is rejected', async () => {
  const { call, video } = await fixture();
  const scene = video.storyboard().scenes[0].id;
  const paper = (await call('get_card', { card: 'paper' })).implementation;
  const applied = await call('apply_style', { scene, style: 'paper', version: paper.version, contentHash: paper.contentHash });
  assert.equal(applied.scenes.length, 1);
  await assert.rejects(call('apply_style', { scene, style: 'paper', contentHash: 'old' }), /changed/);
  const made = await call('instantiate_pattern', { pattern: 'comparison', title: 'Two ways' });
  assert.ok(video.storyboard().scenes.some((s) => s.id === made.id));
  await assert.rejects(call('apply_style', { scene, style: 'rise' }), /Unknown style rise/);
});

test('attached cards: saved copies in get_rules, stale contexts, old copies, undo, limits and legacy guides', async () => {
  const { call, video, root, ctx } = await fixture();
  const initial = await call('get_video_cards');
  assert.deepEqual(initial.items, []);
  const card = await call('get_card', { card: 'signal-the-word' });
  await assert.rejects(call('attach_card', { card: card.id, contentHash: 'old' }), /changed in the library/);
  await assert.rejects(call('attach_card', { card: 'paper' }), /No technique or workflow card "paper"/);
  for (const name of ['attach_card', 'detach_card', 'undo_cards', 'use_card_once']) await assert.rejects(callTool(name, { card: card.id, model: 'T' }, ctx), /explicitly/);
  const saved = await call('attach_card', { card: card.id, version: card.version, contentHash: card.contentHash, contextHash: initial.contextHash });
  assert.equal(saved.items.length, 1);
  assert.equal((await call('attach_card', { card: card.id, contextHash: saved.contextHash })).unchanged, true);
  await assert.rejects(call('detach_card', { card: card.id, contextHash: initial.contextHash }), /changed/);
  const rules = await call('get_rules');
  assert.ok(Object.keys(rules).indexOf('instructions') < Object.keys(rules).indexOf('cards'));
  assert.equal(rules.cards[0].prompt, 'Bring each element in on the word that introduces it. Use word anchors, not seconds.');
  assert.deepEqual(rules.cards[0].sources, ["scene-loop's own originals"]);
  assert.match(rules.cardContract, /take priority/);
  assert.equal((await call('get_video_cards', { video: 'other' })).items.length, 0);
  await call('attach_card', { card: 'review-video' });
  assert.equal((await call('get_rules')).cards[1].checklist.length, 4);
  await call('undo_cards');
  assert.deepEqual((await call('get_video_cards')).items.map((c) => c.id), ['signal-the-word']);
  await call('detach_card', { card: card.id });
  assert.equal((await call('get_video_cards')).items.length, 0);
  assert.ok(existsSync(join(video.dir, 'cards.json')));
  const once = await call('use_card_once', { card: 'improve-pacing' });
  assert.equal(once.persisted, false);
  assert.match(once.prompt, /Use this card ONCE/);

  // A library change does not change the saved copy; the old copy must be detached first.
  const dir = copyLibrary();
  try {
    setLibraryDir(dir);
    await call('attach_card', { card: 'signal-the-word' });
    const f = join(dir, 'cards', 'signal-the-word.json'), c = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...c, version: '2', what: 'A newer explanation.' }));
    assert.equal((await call('get_rules')).cards[0].version, '1');
    await assert.rejects(call('attach_card', { card: 'signal-the-word' }), /older copy/);
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, 'cards', `extra-${i}.json`), JSON.stringify(technique(`extra-${i}`)));
    for (let i = 0; i < 11; i++) await call('attach_card', { card: `extra-${i}` });
    await assert.rejects(call('attach_card', { card: 'extra-11' }), /At most 12/);
  } finally { setLibraryDir(STARTER); rmSync(dir, { recursive: true, force: true }); }

  // A video from before the card library: its guides.json reads as attached workflow cards.
  const other = join(root, 'one', 'videos', 'other');
  const guide = workflowOf(getCard('explain-concept'));
  writeFileSync(join(other, 'guides.json'), JSON.stringify({ revision: 'r', items: [{ ...guide, contentHash: 'x' }], undo: [] }));
  assert.deepEqual((await call('get_rules', { video: 'other' })).cards.map((c) => [c.id, c.kind]), [['explain-concept', 'workflow']]);
});

test('a video format is a saved copy that get_rules returns', async () => {
  const { call, video } = await fixture();
  assert.equal((await call('get_rules')).format, null);
  await assert.rejects(call('set_video', { format: 'tiktok' }), /No format "tiktok"/);
  await call('set_video', { width: 1080, height: 1920 });
  const r = await call('set_video', { format: 'widescreen' });
  assert.match(r.formatCanvas, /1920x1080; this video is 1080x1920/);
  const rules = await call('get_rules');
  assert.equal(rules.format.title, 'Widescreen video');
  assert.deepEqual(rules.format.rules.length, 2);
  await call('set_video', { format: null });
  assert.equal(video.storyboard().format, undefined);
});

test('another library folder: bad files are reported and left out, new files show without a restart', () => {
  const dir = copyLibrary();
  try {
    setLibraryDir(dir);
    assert.equal(libraryDir(), dir);
    writeFileSync(join(dir, 'cards', 'good.json'), JSON.stringify(technique('good')));
    writeFileSync(join(dir, 'cards', 'dash.json'), JSON.stringify(technique('dash', { what: 'One — two.' })));
    writeFileSync(join(dir, 'cards', 'nosource.json'), JSON.stringify(technique('nosource', { sources: [{ source: 'unknown' }] })));
    writeFileSync(join(dir, 'cards', 'wrongname.json'), JSON.stringify(technique('other-name')));
    writeFileSync(join(dir, 'cards', 'broken.json'), '{ not json');
    const lib = loadLibrary();
    assert.ok(lib.cards.some((c) => c.id === 'good'));
    for (const id of ['dash', 'nosource', 'other-name']) assert.ok(!lib.cards.some((c) => c.id === id), id);
    const problems = Object.fromEntries(lib.errors.map((e) => [e.file.split('/').pop(), e.problems.join('; ')]));
    assert.match(problems['dash.json'], /no em dashes/);
    assert.match(problems['nosource.json'], /no source "unknown"/);
    assert.match(problems['wrongname.json'], /must be other-name.json/);
    assert.match(problems['broken.json'], /not JSON/);
    let failed = false;
    try { execFileSync(process.execPath, ['bin/check-library.mjs', dir], { stdio: 'pipe' }); } catch (e) { failed = e.status === 1 && /no em dashes/.test(String(e.stderr)); }
    assert.ok(failed);
    assert.throws(() => setLibraryDir(tmpdir()), /no library.json/);
  } finally { setLibraryDir(STARTER); rmSync(dir, { recursive: true, force: true }); }
});

test('a library folder is read on top of the starter: additions, replacements, its own stages and demo files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sl-layer-'));
  try {
    mkdirSync(join(dir, 'cards'), { recursive: true }); mkdirSync(join(dir, 'sources')); mkdirSync(join(dir, 'demos', 'mine', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'library.json'), JSON.stringify({ title: 'Mine', stages: [{ id: 'hook', title: 'Hook' }, { id: 'look', title: 'Look' }, { id: 'motion', title: 'Motion' }, { id: 'cuts', title: 'Cuts' }, { id: 'on-screen', title: 'On screen' }, { id: 'workflow', title: 'Work' }] }));
    writeFileSync(join(dir, 'sources', 'me.json'), JSON.stringify({ id: 'me', title: 'My notes', author: 'Me', kind: 'our-notes', url: null }));
    writeFileSync(join(dir, 'demos', 'mine', 'scene.html'), '<template><div id="root" data-composition-id="mine" data-width="1080" data-height="1920" data-duration="3"><img src="assets/a.png"></div></template>');
    writeFileSync(join(dir, 'demos', 'mine', 'assets', 'a.png'), 'png');
    writeFileSync(join(dir, 'cards', 'mine.json'), JSON.stringify(technique('mine', { sources: [{ source: 'me' }], related: ['rise'], implementedBy: [{ card: 'cut' }], demo: 'demos/mine/scene.html' })));
    const paper = JSON.parse(readFileSync(join(STARTER, 'cards', 'paper.json'), 'utf8'));
    writeFileSync(join(dir, 'cards', 'paper.json'), JSON.stringify({ ...paper, version: '9', title: 'Paper, mine' }));
    setLibraryDir(dir);
    const lib = loadLibrary();
    assert.deepEqual(lib.errors, []);
    assert.equal(lib.title, 'Mine');
    assert.equal(lib.cards.length, 18);
    assert.equal(getCard('paper').title, 'Paper, mine');
    assert.equal(getCard('rise').kind, 'motion');
    assert.equal(demoFile(getCard('mine')), realpathSync(join(dir, 'demos', 'mine', 'scene.html')));
    assert.equal(demoFile(getCard('mine'), 'assets/a.png'), realpathSync(join(dir, 'demos', 'mine', 'assets', 'a.png')));
    assert.equal(demoFile(getCard('mine'), '../../library.json'), null);
    assert.equal(execFileSync(process.execPath, ['bin/check-library.mjs', dir], { encoding: 'utf8' }).includes('Mine: 18 cards'), true);
  } finally { setLibraryDir(STARTER); rmSync(dir, { recursive: true, force: true }); }
});
