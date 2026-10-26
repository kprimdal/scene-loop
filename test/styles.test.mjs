import { test } from 'node:test';
import { STARTER, setLibraryDir } from '../lib/cards.mjs';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRegistry, TEMPLATE_DIR } from '../lib/projects.mjs';
import { callTool, toolList } from '../lib/tools.mjs';
import { inspectStyle, listStyles, withStyle, withoutStyle, pinnedStyle, styleExample } from '../lib/styles.mjs';
import { buildWhole, buildScene, examplePage } from '../lib/assemble.mjs';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sl-styles-'));
  for (const project of ['one', 'other']) {
    mkdirSync(join(root, project, 'videos'), { recursive: true });
    writeFileSync(join(root, project, 'project.md'), '# Project rules\nKeep the approved wording.');
    cpSync(TEMPLATE_DIR, join(root, project, 'videos', 'demo'), { recursive: true });
  }
  const registry = createRegistry(root, { reviewer: 'Tester', emit() {} });
  const video = await registry.get('one', 'demo');
  const call = (tool, args = {}) => callTool(tool, { project: 'one', video: 'demo', model: 'Tester', ...args }, { registry, via: 'page-js', origin: 'http://localhost' });
  return { root, video, call, registry };
}

test('style scene scope: pin, context, preserve content/music/timing/comments, remove and restore', async () => {
  const { video, call, registry } = await fixture();
  const id = 's01-intro';
  await video.createScene({ id: 'second', title: 'Second', duration: 3, model: 'Tester' });
  await video.updateScene(id, { narration: 'Keep this line.', duration: 4, model: 'Tester' });
  await video.setMeta({ music: 'assets/music/example.mp3', musicLibrary: 'example', model: 'Tester' });
  const beforeSb = readFileSync(join(video.dir, 'storyboard.json'), 'utf8');
  const before = (await video.sceneHtml(id)).html;
  const other = (await video.sceneHtml('second')).html;
  await video.addComment(id, { text: 'Review this later', t: 1 });
  const result = await call('apply_style', { scene: id, style: 'paper' });
  await assert.rejects(call('apply_style', { scene: id, style: 'paper', version: '2.0.0' }), /changed in the catalog/);
  await assert.rejects(call('apply_style', { scene: id, style: 'paper', contentHash: 'changed' }), /changed in the catalog/);
  const styled = await video.sceneHtml(id);
  assert.equal(result.scenes.length, 1);
  assert.deepEqual(styled.style, inspectStyle('paper'));
  assert.equal(withoutStyle(styled.html), before, 'all authored bytes survive application');
  assert.equal((await video.sceneHtml('second')).html, other);
  assert.equal(readFileSync(join(video.dir, 'storyboard.json'), 'utf8'), beforeSb);
  assert.equal((await video.view()).scenes[0].comments[0].status, 'pending');
  const rules = await call('get_rules');
  assert.match(rules.instructions, /approved wording/);
  assert.deepEqual(rules.styles[0].style, inspectStyle('paper'));
  assert.deepEqual((await call('list_scenes')).scenes[0].style, styled.style);
  assert.equal((await call('list_cards', { kind: 'style' })).items.length, 3);
  assert.match((await call('get_card', { card: 'paper' })).implementation.exampleHtml, /data-sl-surface/);
  assert.ok(toolList().some((t) => t.name === 'apply_style' && t.inputSchema.properties.project));
  // New agent-authored content keeps the exact pin even if its replacement HTML omits it.
  await call('write_scene_html', { scene: id, html: before.replace('My video', 'A revised heading'), resolves: [] });
  const edited = await video.sceneHtml(id);
  assert.equal(edited.style.contentHash, styled.style.contentHash);
  assert.match(edited.html, /A revised heading/);
  const remove = await call('remove_style', { scene: id });
  assert.equal((await video.sceneHtml(id)).html, before.replace('My video', 'A revised heading'));
  await call('restore_version', { scene: id, version: edited.version });
  assert.deepEqual((await video.sceneHtml(id)).style, styled.style);
  assert.equal((await video.sceneHtml(id, remove.scenes[0].version)).style, null);
  const reopened = createRegistry(registry.root, { reviewer: 'Tester', emit() {} });
  assert.deepEqual((await (await reopened.get('one', 'demo')).sceneHtml(id)).style, styled.style);
  assert.equal((await (await registry.get('other', 'demo')).sceneHtml(id)).style, null, 'other projects stay untouched');
});

test('video scope changes every current scene, is idempotent, and removal uses ordinary versions', async () => {
  const { video, call } = await fixture();
  await video.createScene({ id: 'second', title: 'Second', duration: 3, model: 'Tester' });
  const result = await call('apply_style', { style: 'grove', scope: 'video' });
  assert.deepEqual(result.scenes.map((s) => s.scene), ['s01-intro', 'second']);
  assert.ok((await call('list_scenes')).scenes.every((s) => s.style.id === 'grove'));
  assert.ok((await call('apply_style', { style: 'grove', scope: 'video' })).scenes.every((s) => s.unchanged));
  await call('remove_style', { scope: 'video' });
  assert.ok((await call('list_scenes')).scenes.every((s) => s.style === null));
  for (const s of result.scenes) await video.restore(s.scene, s.version);
  assert.ok((await call('list_scenes')).scenes.every((s) => s.style.id === 'grove'));
  await assert.rejects(call('apply_style', { style: 'signal' }), /not a scene/);
  await assert.rejects(call('apply_style', { style: 'absent', scope: 'video' }), /Unknown style/);
  await assert.rejects(call('remove_style', { scope: 'oops' }), /scope/);
});

test('later catalog updates cannot change the pinned CSS, agent context, preview or export build', async (t) => {
  const { root, video, call } = await fixture();
  // Update a scratch copy of the library, never the repository's starter library or a production project.
  const lib = join(root, 'library');
  cpSync(STARTER, lib, { recursive: true });
  setLibraryDir(lib);
  t.after(() => setLibraryDir(STARTER));
  const catalog = { inspectStyle };
  const original = catalog.inspectStyle('signal');
  await video.setStyle(original, { scene: 's01-intro' });
  const file = join(lib, 'cards', 'signal.json');
  const next = JSON.parse(readFileSync(file, 'utf8'));
  next.version = '2.0.0'; next.apply.css = '#root { background:red !important; }';
  writeFileSync(file, JSON.stringify(next));
  assert.equal(catalog.inspectStyle('signal').version, '2.0.0');
  const current = await video.sceneHtml('s01-intro');
  assert.deepEqual(current.style, original);
  assert.deepEqual((await call('get_rules')).styles[0].style, original);
  const sb = video.storyboard();
  const preview = buildScene(video.dir, sb, 's01-intro', current.html, 'style-preview');
  const whole = buildWhole(video.dir, sb, { 's01-intro': current.html }, 'style-whole');
  for (const dir of [preview, whole]) {
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(html, /background:#101a32 !important/);
    assert.doesNotMatch(html, /background:red/);
  }
});

test('all three examples share the actual treatment and frozen clock without cross-scene selectors', () => {
  for (const style of listStyles()) {
    const html = styleExample(style);
    assert.deepEqual(pinnedStyle(html), style);
    assert.equal(withStyle(html, style), html, 'repeat selection is byte-identical');
    const page = examplePage(html);
    assert.match(page, /window\.__sl/);
    assert.match(page, /#sc-library-example \[data-sl-surface\]/);
    assert.doesNotMatch(page, /#root \[data-sl-surface\]/);
  }
});

test('style changes preserve manual edits as a recoverable baseline and serialize concurrent writes', async () => {
  const { video, call } = await fixture();
  const id = 's01-intro';
  const file = join(video.dir, 'scenes', id, 'scene.html');
  const manual = readFileSync(file, 'utf8').replace('My video', 'Hand-authored title');
  writeFileSync(file, manual);
  const result = await call('apply_style', { scene: id, style: 'signal' });
  assert.equal(withoutStyle((await video.sceneHtml(id)).html), manual);
  assert.equal((await video.sceneHtml(id, result.scenes[0].version - 1)).html, manual);
  await Promise.all([
    call('apply_style', { style: 'paper', scope: 'video' }),
    call('write_scene_html', { scene: id, html: manual.replace('Hand-authored title', 'Concurrent title'), resolves: [] }),
  ]);
  await assert.rejects(call('write_scene_html', { scene: id, html: manual.replace('</template>', ''), resolves: [] }), /closing <\/template>/);
  const final = await video.sceneHtml(id);
  assert.match(final.html, /Concurrent title/);
  assert.equal(final.style.id, 'paper');
});
