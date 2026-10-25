// A real scratch server and Chrome page: catches stale forms, module cycles and mobile overflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { launch } from '../lib/chrome.mjs';
import { TEMPLATE_DIR } from '../lib/projects.mjs';

test('page text controls save, cancel, discard stale forms across scene/version/compare changes and fit 390px', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sl-text-ui-'));
  cpSync(TEMPLATE_DIR, join(root, 'demo'), { recursive: true });
  const listener = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const server = spawn(process.execPath, ['server.mjs', join(root, 'demo'), '--port', String(port)], { cwd: join(import.meta.dirname, '..'), env: process.env, stdio: ['ignore','pipe','pipe'] });
  let logs = '';
  server.stdout.on('data', (chunk) => logs += chunk);
  server.stderr.on('data', (chunk) => logs += chunk);
  const browser = await launch();
  try {
    const page = await browser.newPage({ width: 1280, height: 900 });
    const wait = async (code) => {
      const until = Date.now() + 10000;
      while (!(await page.evaluate(code))) {
        if (Date.now() > until) throw new Error(`Waiting for ${code}; ${logs}`);
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    while (!logs.includes('MCP:')) {
      if (server.exitCode !== null) throw new Error(logs);
      await new Promise((r) => setTimeout(r, 30));
    }
    await page.goto(`http://127.0.0.1:${port}`);
    await wait('document.querySelector("#player").ready && !!window.sceneLoop');
    const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const input = (selector, value, type = 'input') => page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(type)}));})()`);
    await click('#sceneText summary');
    await wait('!!document.querySelector("#sceneText form")');
    await page.evaluate('[...document.querySelectorAll("#sceneText button")].find(b=>b.textContent==="+ Add text").click()');
    await input('#textContent', 'Æble, ø og å\nA useful name');
    await input('[aria-label="Position"]', 'lower', 'change');
    await input('[aria-label="Treatment"]', 'light', 'change');
    await input('[aria-label="Start (s)"]', '0.5');
    await input('[aria-label="End (s)"]', '2');
    await page.evaluate('document.querySelector("#player").seek(1)');
    const textInFrame = () => page.evaluate('document.querySelector("#player iframe").contentDocument.querySelector("[data-sl-text-item]")?.textContent.trim()');
    assert.equal(await textInFrame(), 'Æble, ø og å\nA useful name');
    await click('#sceneText button[type=submit]');
    await wait('document.querySelector("#versionsBtn").textContent === "Versions (2)" && !!document.querySelector("#textContent")');
    let saved = await page.evaluate('window.sceneLoop.get_scene_html({scene:"s01-intro"})');
    assert.equal(saved.texts[0].position, 'lower');
    assert.equal(saved.texts[0].style, 'light');
    assert.equal(saved.texts[0].start, .5);
    assert.equal(saved.texts[0].end, 2);
    await page.evaluate('window.sceneLoop.create_scene({id:"second",title:"Second",duration:2,model:"UI test"})');
    await wait('!!document.querySelector(".card[data-id=second]") && !!document.querySelector("#textContent")');
    await input('#textContent', 'Unsaved draft');
    await page.evaluate('window.staleForm=document.querySelector("#sceneText form");window.staleInput=document.querySelector("#textContent")');
    await click('.card[data-id=second]');
    await wait('document.querySelector("#panelSub").textContent.startsWith("second") && !!document.querySelector("#sceneText form")');
    await click('.card[data-id="s01-intro"]');
    await wait('document.querySelector("#textContent")?.value.startsWith("Æble")');
    await page.evaluate('window.staleInput.value="Stale input";window.staleInput.dispatchEvent(new Event("input"));window.staleForm.dispatchEvent(new Event("submit",{cancelable:true}))');
    await new Promise((r) => setTimeout(r, 80));
    saved = await page.evaluate('window.sceneLoop.get_scene_html({scene:"s01-intro"})');
    assert.equal(saved.version, 2);
    assert.equal(saved.texts[0].text, 'Æble, ø og å\nA useful name');
    await input('#textContent', 'Draft for compare');
    await page.evaluate('import("/js/versions.js").then(m=>m.openCompare(1))');
    await wait('!document.querySelector("#textContent")');
    assert.equal(await textInFrame(), saved.texts[0].text, 'compare removes unsaved text from the current frame');
    await click('#closeCompare');
    await wait('!!document.querySelector("#textContent")');
    await page.evaluate('import("/js/versions.js").then(m=>m.viewVersion(1))');
    await wait('!document.querySelector("#textContent") && document.querySelector("#viewing").textContent.includes("v1") && document.querySelector("#sceneText").textContent.includes("latest version")');
    assert.match(await page.evaluate('document.querySelector("#sceneText").textContent'), /latest version/);
    await page.evaluate('import("/js/versions.js").then(m=>m.viewVersion(2))');
    await wait('document.querySelector("#player").ready && !!document.querySelector("#textContent")');
    await input('#textContent', 'Cancelled text');
    await page.evaluate('[...document.querySelectorAll("#sceneText button")].find(b=>b.textContent==="Cancel").click()');
    await wait('!document.querySelector("#sceneText").open');
    assert.equal(await textInFrame(), saved.texts[0].text);
    // A second page at 390 px checks a clean reload and responsive layout.
    const mobile = await browser.newPage({ width: 390, height: 844 });
    await mobile.goto(`http://127.0.0.1:${port}`);
    for (let i = 0; i < 100 && !(await mobile.evaluate('document.querySelector("#player").ready')); i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal(await mobile.evaluate('document.documentElement.scrollWidth'), 390);
    assert.deepEqual(page.errors, []);
    assert.deepEqual(mobile.errors, []);
    await mobile.close();
    await page.close();
  } finally {
    await browser.close();
    server.kill();
    await new Promise((r) => server.exitCode !== null ? r() : server.once('exit', r));
    rmSync(root, { recursive: true, force: true });
  }
});
