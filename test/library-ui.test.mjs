// The Library page in a real browser: the card grid and its filters, the card drawer and what
// each kind of card does from it (attach, apply a style, motion and a boundary, make a scene
// from a pattern), formats and sources, the tabs, and a 390 px wide phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { launch } from '../lib/chrome.mjs';
import { TEMPLATE_DIR } from '../lib/projects.mjs';

test('Library page: grid, filters, drawer actions per kind, formats, sources, tabs and mobile', { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sl-library-ui-'));
  for (const name of ['one', 'two']) cpSync(TEMPLATE_DIR, join(root, 'project', 'videos', name), { recursive: true });
  const listener = createServer().listen(0, '127.0.0.1'); await new Promise((r) => listener.once('listening', r)); const port = listener.address().port; await new Promise((r) => listener.close(r));
  const server = spawn(process.execPath, ['server.mjs', root, '--port', String(port)], { cwd: join(import.meta.dirname, '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', (d) => (logs += d)); server.stderr.on('data', (d) => (logs += d));
  const browser = await launch();
  try {
    while (!logs.includes('MCP:')) { if (server.exitCode !== null) throw new Error(logs); await new Promise((r) => setTimeout(r, 30)); }
    assert.match(logs, /Library: Starter library, 17 cards, 1 formats, 1 sources/);
    const page = await browser.newPage({ width: 1280, height: 1000 });
    const wait = async (code) => { const end = Date.now() + 15000; while (!(await page.evaluate(code))) { if (Date.now() > end) throw new Error(`Wait: ${code}\n${await page.evaluate('document.querySelector("#toast")?.textContent')}`); await new Promise((r) => setTimeout(r, 30)); } };
    const click = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const button = (text, within = '#cardDrawer') => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(within + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
    const input = (sel, value) => page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'));e.dispatchEvent(new Event('input'));})()`);
    const idle = '![...document.querySelectorAll("#cardAction button")].some(b=>b.disabled)';
    const base = `http://127.0.0.1:${port}`, url = `${base}/?library=1&project=project&video=one`;
    await page.goto(url);
    await wait('!!window.sceneLoop && document.querySelectorAll(".lcard").length===17 && document.querySelector("#cardTargetInfo").textContent.includes("0 cards attached")');

    // Grid in stage order, filters and search.
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".card-stage h2")].map(h=>h.textContent)'), ['Camera and motion', 'Cuts and transitions', 'On screen', 'Look', 'Way of working']);
    await page.evaluate('[...document.querySelectorAll("#cardKinds button")].find(b=>b.textContent==="Styles").click()');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".lcard")].map(c=>c.dataset.card)'), ['signal', 'paper', 'grove']);
    await page.evaluate('[...document.querySelectorAll("#cardKinds button")].find(b=>b.textContent==="All kinds").click()');
    await input('#cardSearch', 'introduces');
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".lcard")].map(c=>c.dataset.card)'), ['signal-the-word']);
    assert.match(await page.evaluate('document.querySelector(".lcard .card-prompt").textContent'), /Use word anchors/);
    await input('#cardSearch', 'nothing like this');
    assert.match(await page.evaluate('document.querySelector("#cardGrid").textContent'), /No cards match/);
    await input('#cardSearch', '');

    // A technique: attach, the chat sees it, detach.
    await click('[data-card=signal-the-word] .lcard-foot button');
    await wait('!document.querySelector("#cardDrawer").hidden && document.querySelector("#cardAction")?.textContent.includes("Attach to video")');
    assert.match(await page.evaluate('location.search'), /card=signal-the-word/);
    await button('Attach to video');
    await wait('document.querySelector("#cardTargetInfo").textContent.includes("1 card attached")');
    assert.deepEqual((await page.evaluate('window.sceneLoop.get_rules({project:"project",video:"one"})')).cards.map((c) => c.id), ['signal-the-word']);
    await wait('document.querySelector("#cardAction").textContent.includes("Detach")');
    await button('Detach');
    await wait('document.querySelector("#cardTargetInfo").textContent.includes("0 cards attached")');
    await click('#cardDrawer .x');
    assert.equal(await page.evaluate('document.querySelector("#cardDrawer").hidden'), true);

    // A style on the chosen scene.
    await page.goto(`${url}&card=paper`);
    await wait('document.querySelector("#cardAction")?.textContent.includes("Apply Paper")');
    await button('Apply Paper');
    await wait(`${idle} && document.querySelector("#cardAction").textContent.includes("This scene has Paper")`);
    assert.equal((await page.evaluate('window.sceneLoop.get_scene_html({project:"project",video:"one",scene:"s01-intro"})')).style.id, 'paper');
    await button('Remove style');
    await wait(`${idle} && document.querySelector("#cardAction").textContent.includes("no Library style")`);

    // Motion on a narration word, then removed.
    await page.evaluate(`(async()=>{await window.sceneLoop.update_scene({project:'project',video:'one',scene:'s01-intro',narration:'Choose one idea. Read it now.',model:'UI test'});await window.sceneLoop.set_narration_words({project:'project',video:'one',scene:'s01-intro',words:[{word:'Choose',start:.2,end:.4},{word:'one',start:.4,end:.5},{word:'idea.',start:.5,end:.7},{word:'Read',start:1,end:1.2},{word:'it',start:1.2,end:1.3},{word:'now.',start:1.3,end:1.5}],adopt:false,model:'UI test'});})()`);
    await page.goto(`${url}&card=rise`);
    await wait('!!document.querySelector("#cardAction [aria-label=\'On the word\'] option[value=\'word:read\']")');
    await input('#cardAction [aria-label="On the word"]', 'word:read');
    await button('Apply Rise');
    await wait(`${idle} && document.querySelector("#cardAction").textContent.includes("word:read")`);
    assert.equal((await page.evaluate('window.sceneLoop.get_scene_html({project:"project",video:"one",scene:"s01-intro"})')).motions[0].anchor, 'word:read');
    await button('Remove');
    await wait(`${idle} && !document.querySelector("#cardAction").textContent.includes("Motion in this scene")`);

    // A boundary: not on the first scene; cut, reset and undo on the second.
    await page.evaluate(`window.sceneLoop.create_scene({project:'project',video:'one',id:'second',title:'Second idea',duration:2,model:'UI test'})`);
    await page.goto(`${url}&card=cut`);
    await wait('document.querySelector("#cardAction")?.textContent.includes("first scene has no incoming boundary")');
    await input('#cardScene', 'second');
    await wait('document.querySelector("#cardAction")?.textContent.includes("Use Cut into this scene")');
    await button('Use Cut into this scene');
    await wait(`${idle} && document.querySelector("#cardAction").textContent.includes("Now: cut")`);
    await button('Reset to default');
    await wait(`${idle} && document.querySelector("#cardAction").textContent.includes("Now: dissolve")`);
    await button('Undo');
    await wait(`${idle} && document.querySelector("#cardAction").textContent.includes("Now: cut")`);

    // A pattern makes a new scene in the chosen video, not the other one.
    await page.goto(`${url}&card=process`);
    await wait('!!document.querySelector("#cardAction form [name=heading]")');
    await input('#cardVideo', '1');
    await wait('!!document.querySelector("#cardAction h4")?.textContent.includes("(two)")');
    await input('#cardAction [name=heading]', 'Build a rooftop garden');
    await input('#cardAction [name=steps]', 'Find the light\nChoose hardy plants\nWater a little');
    await input('#cardAction [name=title]', 'Garden plan');
    await page.evaluate('document.querySelector("#cardAction form").requestSubmit()');
    await wait('!!document.querySelector("#cardAction a.btn")');
    assert.equal((await page.evaluate('window.sceneLoop.list_scenes({project:"project",video:"two"})')).scenes.length, 2);
    assert.equal((await page.evaluate('window.sceneLoop.list_scenes({project:"project",video:"one"})')).scenes.length, 2);

    // Formats and sources.
    await click('#libFormatsTab');
    assert.equal(await page.evaluate('document.querySelector("#formatLibrary").hidden'), false);
    await page.evaluate('[...document.querySelectorAll("[data-format=widescreen] button")].find(b=>b.textContent.startsWith("Use for")).click()');
    await wait('document.querySelector("#cardTargetInfo").textContent.includes("Format: Widescreen video")');
    assert.equal((await page.evaluate('window.sceneLoop.get_rules({project:"project",video:"two"})')).format.id, 'widescreen');
    await page.evaluate('[...document.querySelectorAll("[data-format=widescreen] button")].find(b=>b.textContent==="Show its cards").click()');
    assert.equal(await page.evaluate('document.querySelector("#cardLibrary").hidden'), false);
    assert.equal(await page.evaluate('document.querySelector("#cardFormat").value'), 'widescreen');
    await click('#libSourcesTab');
    assert.match(await page.evaluate('document.querySelector("#sourceList").textContent'), /scene-loop's own originals/);
    for (const [tab, panel] of [['libCardsTab', 'cardLibrary'], ['libFormatsTab', 'formatLibrary'], ['libSourcesTab', 'sourceLibrary'], ['libReferencesTab', 'referenceLibrary'], ['libMusicTab', 'musicLibrary']]) {
      await click('#' + tab);
      assert.equal(await page.evaluate(`document.querySelector('#${panel}').hidden`), false, panel);
    }
    assert.equal(await page.evaluate('document.documentElement.scrollWidth'), 1280);

    const mobile = await browser.newPage({ width: 390, height: 844 });
    await mobile.goto(`${url}&card=rise`);
    const end = Date.now() + 15000;
    while (!(await mobile.evaluate('document.querySelectorAll(".lcard").length===17 && !document.querySelector("#cardDrawer").hidden'))) { if (Date.now() > end) throw new Error('mobile timeout'); await new Promise((r) => setTimeout(r, 30)); }
    assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'), 390);
    assert.deepEqual(page.errors, []); assert.deepEqual(mobile.errors, []);
  } finally { await browser.close(); server.kill(); await new Promise((r) => server.once('exit', r)); }
});
