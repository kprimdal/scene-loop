import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRegistry, TEMPLATE_DIR } from '../lib/projects.mjs';
import { callTool, toolList } from '../lib/tools.mjs';
import { sceneTexts, withTexts, withoutTexts, validateTexts } from '../lib/text.mjs';
import { buildScene, buildWhole } from '../lib/assemble.mjs';
import { launch } from '../lib/chrome.mjs';
import { renderClip } from '../lib/render.mjs';
import { analyze } from '../lib/composite.mjs';

const item = (overrides = {}) => ({ id: 'text-title', text: 'Rødgrød\nmed fløde', position: 'title', style: 'dark', start: 1, end: 2, ...overrides });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sl-text-'));
  for (const name of ['one', 'other']) {
    mkdirSync(join(root, name, 'videos'), { recursive: true });
    writeFileSync(join(root, name, 'project.md'), '# Synthetic project');
    cpSync(TEMPLATE_DIR, join(root, name, 'videos', 'demo'), { recursive: true });
  }
  const registry = createRegistry(root, { reviewer: 'Tester', emit() {} });
  const video = await registry.get('one', 'demo');
  const call = (name, args = {}) => callTool(name, { project: 'one', video: 'demo', model: 'Tester', scene: 's01-intro', ...args }, { registry, via: 'page-js', origin: 'http://localhost' });
  return { root, registry, video, call };
}

test('plain text serialization, escaping, bounded presets and finite ranges', () => {
  const html = '<template>\n<div id="root" data-composition-id="intro">Keep authored bytes.</div>\n</template>';
  const items = validateTexts([item({ text: '</style><script>throw "x"</script> & æøå\n#root{}' })], 3);
  const next = withTexts(html, 'intro', items);
  assert.deepEqual(sceneTexts(next), items);
  assert.equal(withoutTexts(next), html);
  assert.equal(withTexts(next, 'intro', items), next);
  assert.doesNotMatch(next, /<script>/);
  assert.match(next, /&lt;script&gt;/);
  for (const range of [{ start: NaN }, { end: Infinity }, { start: -1 }, { start: 2 }, { end: 0 }, { end: 4 }, { end: '2' }]) assert.throws(() => validateTexts([item(range)], 3), /start < end/);
  for (const bad of [{ text: '' }, { text: 'a'.repeat(241) }, { text: 'a\nb\nc\nd\ne' }, { text: '\0' }, { position: '__proto__' }, { style: 'color:red' }, { id: 'x"' }]) assert.throws(() => validateTexts([item(bad)], 3));
  assert.throws(() => validateTexts([item(), item()], 3), /unique/);
  assert.throws(() => validateTexts(Array(5).fill(item()), 3), /at most 4/);
});

test('text edits isolate scenes, retain authored content/style/assets and survive writes, reopen and restore', async () => {
  const { registry, video, call } = await fixture();
  const id = 's01-intro';
  const original = (await video.sceneHtml(id)).html;
  await video.createScene({ id: 'second', title: 'Other scene', duration: 4 });
  await video.addComment(id, { text: 'Keep pending', t: 0 });
  const sb = readFileSync(join(video.dir, 'storyboard.json'), 'utf8');
  const result = await call('set_scene_text', { items: [item()] });
  assert.deepEqual(result.texts, [item()]);
  assert.equal(withoutTexts((await video.sceneHtml(id)).html), original);
  assert.equal(readFileSync(join(video.dir, 'storyboard.json'), 'utf8'), sb);
  assert.equal((await video.view()).scenes[0].comments[0].status, 'pending');
  assert.deepEqual((await call('list_scenes')).scenes[0].texts, [item()]);
  assert.match((await call('get_rules')).textContract, /set_scene_text/);
  assert.ok(toolList().some((t) => t.name === 'set_scene_text' && t.inputSchema.properties.project));
  await call('apply_style', { style: 'paper' });
  const styled = (await video.sceneHtml(id)).style;
  await call('write_scene_html', { html: original.replace('My video', 'Changed authored content'), resolves: [] });
  assert.deepEqual((await video.sceneHtml(id)).texts, [item()]);
  assert.deepEqual((await video.sceneHtml(id)).style, styled);
  await call('remove_style');
  assert.deepEqual((await video.sceneHtml(id)).texts, [item()]);
  const edited = await call('get_scene_html');
  const removed = await call('set_scene_text', { items: [] });
  assert.deepEqual((await video.sceneHtml(id)).texts, []);
  assert.match((await video.sceneHtml(id)).html, /Changed authored content/);
  await call('restore_version', { version: edited.version });
  assert.deepEqual((await video.sceneHtml(id)).texts, [item()]);
  assert.deepEqual((await video.sceneHtml(id, removed.version)).texts, []);
  assert.deepEqual((await video.sceneHtml('second')).texts, []);
  assert.deepEqual((await (await registry.get('other', 'demo')).sceneHtml(id)).texts, []);
  const reopened = createRegistry(registry.root, { reviewer: 'Tester', emit() {} });
  assert.deepEqual((await (await reopened.get('one', 'demo')).sceneHtml(id)).texts, [item()]);
});

test('stale drafts and shortening reject before mutation; restore checks current duration', async () => {
  const { video, call } = await fixture();
  const first = await call('set_scene_text', { items: [item()] });
  const updated = await call('set_scene_text', { items: [item({ text: 'New text' })], baseVersion: first.version });
  await assert.rejects(call('set_scene_text', { items: [], baseVersion: first.version }), /Scene changed/);
  assert.deepEqual((await video.sceneHtml('s01-intro')).texts, updated.texts);
  const sb = readFileSync(join(video.dir, 'storyboard.json'), 'utf8');
  await assert.rejects(call('update_scene', { duration: 1.5, narration: 'Do not save' }), /Edit or remove this text/);
  assert.equal(readFileSync(join(video.dir, 'storyboard.json'), 'utf8'), sb);
  await call('set_scene_text', { items: [] });
  await call('update_scene', { duration: 1.5 });
  await assert.rejects(call('restore_version', { version: first.version }), /end ≤ 1.5/);
  assert.deepEqual((await video.sceneHtml('s01-intro')).texts, []);
  await call('update_scene', { duration: 3 });
  await call('restore_version', { version: first.version });
  assert.deepEqual((await video.sceneHtml('s01-intro')).texts, [item()]);
});

test('text and authored edits serialize, and a manual baseline stays restorable', async () => {
  const { video, call } = await fixture();
  const file = join(video.dir, 'scenes/s01-intro/scene.html');
  const original = readFileSync(file, 'utf8').replace('My video', 'Manual heading');
  writeFileSync(file, original);
  const first = await call('set_scene_text', { items: [item()] });
  assert.equal((await video.sceneHtml('s01-intro', first.version - 1)).html, original);
  await Promise.all([call('set_scene_text', { items: [item({ position: 'lower' })] }), call('write_scene_html', { html: original.replace('Manual heading', 'Concurrent heading'), resolves: [] })]);
  const final = await video.sceneHtml('s01-intro');
  assert.match(final.html, /Concurrent heading/);
  assert.equal(final.texts[0].position, 'lower');
});

test('preview, stills and real optimized exports agree at boundaries, on backward seeks and across scenes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sl-text-export-'));
  const sceneHtml = (id, text) => withTexts(`<template><style>#root{background:#253a53;font-family:Arial}</style><div id="root" data-composition-id="${id}"></div></template>`, id, text);
  const items = [item({ start: .5, end: 1 }), item({ id: 'text-lower', position: 'lower', style: 'light', start: 1.5, end: 2.5, text: 'Søren Øster\nSynthetic presenter' })];
  const html = sceneHtml('intro', items), second = sceneHtml('second', [item({ start: 0, end: 1, position: 'heading' })]);
  const sb = { width: 640, height: 360, duration: 4, fps: 10, scenes: [{ id: 'intro', start: 0, duration: 3 }, { id: 'second', start: 3, duration: 1, transitionIn: { type: 'cut' } }] };
  const build = buildScene(root, sb, 'intro', html, 'preview');
  const whole = buildWhole(root, sb, { intro: html, second }, 'whole');
  const browser = await launch();
  try {
    const page = await browser.newPage({ width: 640, height: 360 });
    await page.goto(pathToFileURL(join(build, 'index.html')).href);
    await page.evaluate('window.__sl.ready');
    const plan = await analyze(page);
    assert.deepEqual(plan.windows, [[.5, 1], [1.5, 2.5]], 'the optimizer sees both text intervals');
    const states = [];
    for (const t of [0, .499, .5, .999, 1, 1.5, 2.499, 2.5, 3, .5, 0]) {
      await page.evaluate(`window.__sl.seek(${t})`);
      states.push(await page.evaluate('[...document.querySelectorAll("[data-sl-text-item]")].map(e=>(Number(getComputedStyle(e).opacity) > 0 && getComputedStyle(e).visibility === "visible" ? "visible" : "hidden"))'));
    }
    assert.deepEqual(states, [['hidden','hidden'],['hidden','hidden'],['visible','hidden'],['visible','hidden'],['hidden','hidden'],['hidden','visible'],['hidden','visible'],['hidden','hidden'],['hidden','hidden'],['visible','hidden'],['hidden','hidden']]);
    const out = join(root, 'text.mp4');
    const exported = await renderClip(build, out, { width: 640, height: 360, fps: 10, start: 0, duration: 3 });
    assert.equal(exported.frames, 30);
    for (const frame of [0, 4, 5, 9, 10, 14, 15, 24, 25, 29]) {
      await page.evaluate(`window.__sl.seek(${frame / 10})`);
      const shot = join(root, `preview-${frame}.png`);
      writeFileSync(shot, await page.screenshot());
      const exportedFrame = execFileSync('ffmpeg', ['-v','error','-i',out,'-vf',`select=eq(n\\,${frame})`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'], { maxBuffer: 2000000 });
      const previewFrame = execFileSync('ffmpeg', ['-v','error','-i',shot,'-f','rawvideo','-pix_fmt','rgb24','pipe:1'], { maxBuffer: 2000000 });
      const difference = exportedFrame.reduce((sum, value, i) => sum + Math.abs(value - previewFrame[i]), 0) / exportedFrame.length;
      assert.ok(difference < 5, `frame ${frame} mean RGB difference ${difference}`);
    }
    await page.goto(pathToFileURL(join(whole, 'index.html')).href);
    await page.evaluate('window.__sl.ready');
    for (const [t, want] of [[2.999,'hidden'],[3,'visible'],[4,'hidden'],[3,'visible']]) {
      await page.evaluate(`window.__sl.seek(${t})`);
      assert.equal(await page.evaluate('(()=>{const e=document.querySelector("#sc-second [data-sl-text-item]");return Number(getComputedStyle(e).opacity) > 0 && getComputedStyle(e).visibility === "visible" ? "visible" : "hidden"})()'), want);
    }
    // Portrait and long unbroken content must stay inside the safe area.
    sb.width = 360; sb.height = 640;
    const portrait = buildScene(root, sb, 'intro', sceneHtml('intro', [item({ text: 'Ø'.repeat(240) })]), 'portrait');
    const tall = await browser.newPage({ width: 360, height: 640 });
    await tall.goto(pathToFileURL(join(portrait, 'index.html')).href);
    await tall.evaluate('window.__sl.ready');
    await tall.evaluate('window.__sl.seek(1)');
    const rect = await tall.evaluate('(()=>{const e=document.querySelector("[data-sl-text-item]").firstElementChild,r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,scroll:e.scrollWidth,width:e.clientWidth}})()');
    assert.ok(rect.left >= 0 && rect.right <= 360 && rect.top >= 0 && rect.bottom <= 640 && rect.scroll <= rect.width, JSON.stringify(rect));
    await tall.close();
    await page.close();
  } finally { await browser.close(); }
});

test('narration fit rejects incompatible text without a partial storyboard or lead change', async () => {
  const { video, call } = await fixture();
  const audio = join(video.dir, 'short.wav');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','0.1',audio]);
  await video.setNarrationAudio('s01-intro', { path: audio });
  await call('set_scene_text', { items: [item()] });
  const sb = readFileSync(join(video.dir, 'storyboard.json'), 'utf8');
  await assert.rejects(call('fit_scenes_to_narration', { lead: .1, tail: .1 }), /Edit or remove this text/);
  assert.equal(readFileSync(join(video.dir, 'storyboard.json'), 'utf8'), sb);
  await call('set_scene_text', { items: [item({ start: 0, end: .1 })] });
  const fit = await call('fit_scenes_to_narration', { lead: .1, tail: .1 });
  assert.equal(fit.scenes[0].newDuration, .3);
  assert.deepEqual((await video.sceneHtml('s01-intro')).texts, [item({ start: 0, end: .1 })]);
});

test('exact-end text holds match preview across two dissolves, cached renders, audio and cuts', { timeout: 30000 }, async () => {
  const { video, call } = await fixture();
  const dims = { width: 320, height: 180 }, fps = 10;
  await video.setMeta({ ...dims, soundtrack: 'assets/tone.wav' });
  // fps is not a public set_video option; set it in this synthetic fixture before rendering.
  const sbFile = join(video.dir, 'storyboard.json');
  const sb0 = JSON.parse(readFileSync(sbFile)); sb0.fps = fps; writeFileSync(sbFile, JSON.stringify(sb0));
  mkdirSync(join(video.dir, 'assets'), { recursive: true });
  const audio = join(video.dir, 'assets/tone.wav');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','5',audio]);
  const html = (id, color) => `<template><style>#root{background:${color};font-family:Arial}</style><div id="root" data-composition-id="${id}" data-duration="2"></div></template>`;
  await video.updateScene('s01-intro', { duration: 2 });
  await call('write_scene_html', { html: html('s01-intro', '#264e68'), resolves: [] });
  await video.createScene({ id: 'second', title: 'Second', duration: 2, html: html('second','#425e3c'), transitionIn: { duration: .6 } });
  await video.createScene({ id: 'third', title: 'Third', duration: 1, html: html('third','#574153'), transitionIn: { duration: .4 } });
  await call('set_scene_text', { items: [item({ start: 0, end: 2, text: 'Title until the end' })] });
  await call('set_scene_text', { scene: 'second', items: [item({ start: 0, end: 2, position: 'lower', text: 'Name until the end' })] });
  const run = async () => {
    const job = await video.render();
    for (let i = 0; i < 1000 && video.getRender(job.job).state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    const result = video.getRender(job.job);
    assert.equal(result.state, 'done', result.error);
    return result;
  };
  const first = await run();
  const cached = await run();
  assert.equal(cached.clips.cached, 3);
  assert.equal(cached.clips.rendered, 0);
  // Job-scoped exact-end frames are deleted after the join, including on cached renders.
  const { readdirSync } = await import('node:fs');
  assert.ok(readdirSync(join(video.dir,'.build')).every((name) => !name.startsWith('render-')));
  const probe = JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',cached.path]));
  assert.equal(probe.streams.find((s) => s.codec_type === 'video').nb_frames, '50');
  assert.ok(probe.streams.some((s) => s.codec_type === 'audio' && Number(s.duration) >= 4.9), 'audio keeps its correct input map');
  const browser = await launch();
  const page = await browser.newPage(dims);
  const raw = (file, frame) => execFileSync('ffmpeg',['-v','error','-i',file,...(frame == null ? [] : ['-vf',`select=eq(n\\,${frame})`,'-frames:v','1']),'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:1000000});
  const compare = async (render, frames) => {
    const sb = video.storyboard(), map = {};
    for (const s of sb.scenes) map[s.id] = (await video.sceneHtml(s.id)).html;
    const build = buildWhole(video.dir,sb,map,`check-${render.job}`);
    await page.goto(pathToFileURL(join(build,'index.html')).href);await page.evaluate('window.__sl.ready');
    for (const n of frames) {
      await page.evaluate(`window.__sl.seek(${n / fps})`);
      const still = join(video.dir,`preview-${n}.png`);writeFileSync(still,await page.screenshot());
      const a = raw(still), b = raw(render.path,n);
      const mean = a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length;
      assert.ok(mean < 5, `dissolve frame ${n}, mean RGB difference ${mean}`);
    }
  };
  try {
    await compare(cached,[0,19,20,21,23,25,26,39,40,41,43,44,49]);
    // Restore older text after an edit and change the theme. Clips and end frames must
    // follow the newly selected content and theme, never a previous job's stills.
    const original = await video.sceneHtml('s01-intro');
    await call('set_scene_text',{items:[item({start:0,end:2,text:'A replacement'})]});
    await video.restore('s01-intro',original.version);
    await video.setTheme('.scene { background:#284460 !important; }');
    const restored = await run();
    assert.equal(restored.clips.rendered,3);
    await compare(restored,[19,20,21,39,40,41]);
    // No text means no hold snapshots. The unchanged join path still handles both
    // dissolves and cuts with the soundtrack and the original frame count.
    await call('set_scene_text',{items:[]});
    await call('set_scene_text',{scene:'second',items:[]});
    await video.updateScene('third',{transitionIn:{type:'cut'}});
    const bare = await run();
    await compare(bare,[19,20,21,39,40,41]);
    assert.equal(first.picked['s01-intro'],original.version);
  } finally { await browser.close(); }
});
