// People logging in to one server on the internet: the first owner's invite link with an
// authenticator, a commenter invited from /people who sees one project, sessions that end
// when they are removed, the CSRF and rate limits, agent tokens and OAuth for owners only.
// Runs the server on scratch copies of the template; needs git, not Chrome or ffmpeg.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TEMPLATE_DIR } from "../lib/projects.mjs";
import { totp } from "../lib/people.mjs";

const SERVER = join(import.meta.dirname, "..", "server.mjs");
const SHARED = "shared-token-0123456789abcdef";
const PW = { owner: "owner password 123", anna: "anna password 123", ben: "ben password 1234" };
const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
let root, proc, base, ownerInvite, ownerSecret;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-login-"));
  for (const n of ["film", "film2", "secret"]) cpSync(TEMPLATE_DIR, join(root, n), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const out = execFileSync(process.execPath, [SERVER, root, "--invite-owner", "owner@example.com", "Owner", "--url", base], { encoding: "utf8" });
  ownerInvite = out.match(/\/invite\/[\w-]+/)[0];
  proc = spawn(process.execPath, [SERVER, root, "--port", String(port), "--reviewer", "Nobody"], {
    env: { ...process.env, SCENE_LOOP_TOKEN: SHARED, SCENE_LOOP_TRUST_PROXY: "cloudflare", SCENE_LOOP_SECRET: "test-secret" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => String(d).includes("Login on") && resolve());
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(() => {
  proc?.kill();
  rmSync(root, { recursive: true, force: true });
});

// A browser: keeps cookies, sends this site's Origin on writes, does not follow redirects.
function browser({ ip = "203.0.113.1" } = {}) {
  const jar = {};
  const go = async (path, { method, form, json, headers = {}, origin = base } = {}) => {
    const h = { "CF-Connecting-IP": ip, ...headers };
    if (Object.keys(jar).length) h.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    let body;
    if (form) { h["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
    if (json) { h["Content-Type"] = "application/json"; body = JSON.stringify(json); }
    const m = method ?? (body ? "POST" : "GET");
    if (m !== "GET" && origin) h.Origin = origin;
    const r = await fetch(base + path, { method: m, headers: h, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [k, ...v] = c.split(";")[0].split("=");
      if (/Max-Age=0/.test(c)) delete jar[k];
      else jar[k] = v.join("=");
    }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    return { status: r.status, text, json: j, location: r.headers.get("location") };
  };
  go.jar = jar;
  return go;
}
const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
const inviteLink = (html) => html.match(/value="http[^"]*(\/invite\/[\w-]+)"/)?.[1];
const idOf = (html, email) => html.split("<tr>").slice(1).find((row) => row.includes(email))?.match(/name="id" value="(p_\w+)"/)?.[1];
const step = () => Math.floor(Date.now() / 30000);

let nextId = 1;
async function mcp(token, name, args = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  if (r.status !== 200) return { status: r.status };
  const j = await r.json();
  const text = j.result.content.find((c) => c.type === "text")?.text;
  return { status: 200, error: j.result.isError ? text : null, data: j.result.isError ? null : JSON.parse(text) };
}

const owner = browser();
const anna = browser({ ip: "198.51.100.7" });
let annaId, benId;

test("nothing answers without a login", async () => {
  const b = browser();
  assert.equal((await b("/")).location, "/login?next=%2F");
  assert.equal((await b("/api/projects")).status, 401);
  assert.equal((await b("/p/film/film/storyboard.json")).status, 401);
  assert.equal((await b("/people")).status, 401);
  assert.equal((await b("/people", { headers: { Accept: "text/html" } })).location, "/login?next=%2Fpeople");
  assert.equal((await b("/mcp", { json: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 401);
  assert.match((await b("/login")).text, /name="email"/);
});

test("the first owner sets a password and an authenticator through the invite link", async () => {
  const page = await owner(ownerInvite);
  assert.equal(page.status, 200);
  assert.match(page.text, /Welcome, Owner/);
  ownerSecret = page.text.match(/id="totpKey">([A-Z2-7 ]+)</)[1].replace(/ /g, "");
  const setup = field(page.text, "setup");
  assert.match((await owner(ownerInvite, { form: { password: "short", again: "short", setup, code: "000000" } })).text, /12 characters/);
  assert.match((await owner(ownerInvite, { form: { password: PW.owner, again: PW.owner, setup, code: "000000" } })).text, /That code doesn/);
  const ok = await owner(ownerInvite, { form: { password: PW.owner, again: PW.owner, setup, code: totp(ownerSecret, step()) } });
  assert.equal(ok.status, 302);
  assert.deepEqual((await owner("/api/whoami")).json, { reviewer: "Owner", guest: false, owner: true, account: true, email: "owner@example.com", login: true });
  assert.equal((await browser()(ownerInvite)).status, 404, "the link works once");
});

test("an owner logs in with email, password and a code that works once", async () => {
  const b = browser({ ip: "192.0.2.10" });
  assert.match((await b("/login", { form: { email: "owner@example.com", password: "wrong password" } })).text, /Wrong email or password/);
  assert.match((await b("/login", { form: { email: "nobody@example.com", password: PW.owner } })).text, /Wrong email or password/, "the same answer for an unknown email");
  const first = await b("/login", { form: { email: "owner@example.com", password: PW.owner } });
  assert.match(first.text, /authenticator app/);
  const mfa = field(first.text, "mfa");
  assert.equal((await b("/login", { form: { step: "code", mfa, code: "123456" } })).status, 401);
  const used = totp(ownerSecret, step()); // the invite used no step; the owner's browser above did not log in through /login
  const done = await b("/login", { form: { step: "code", mfa, code: used } });
  assert.equal(done.status, 302);
  assert.equal((await b("/api/whoami")).json.reviewer, "Owner");
  const again = browser({ ip: "192.0.2.11" });
  const m2 = field((await again("/login", { form: { email: "owner@example.com", password: PW.owner } })).text, "mfa");
  assert.match((await again("/login", { form: { step: "code", mfa: m2, code: used } })).text, /already used/);
});

test("an owner adds a commenter to one project; the link sets their password", async () => {
  const added = await owner("/people", { form: { action: "add", name: "Anna", email: "anna@example.com", role: "commenter", projects: "film" } });
  assert.equal(added.status, 200);
  const link = inviteLink(added.text);
  assert.ok(link, "the page shows the invite link");
  assert.match(added.text, /Invited, link valid until/);
  const page = await anna(link);
  assert.doesNotMatch(page.text, /totpKey/, "a commenter needs no authenticator");
  const ok = await anna(link, { form: { password: PW.anna, again: PW.anna } });
  assert.equal(ok.location, "/?project=film", "lands on the one project");
  const me = (await anna("/api/whoami")).json;
  assert.deepEqual(me, { reviewer: "Anna", guest: true, owner: false, account: true, email: "anna@example.com", login: true });
  annaId = idOf((await owner("/people")).text, "anna@example.com");
  // two projects in one form
  const two = await owner("/people", { form: [["action", "add"], ["name", "Ben"], ["email", "ben@example.com"], ["role", "commenter"], ["projects", "film"], ["projects", "film2"]] });
  assert.match(two.text, /Ben/);
  const benLink = inviteLink(two.text);
  await browser({ ip: "198.51.100.8" })(benLink, { form: { password: PW.ben, again: PW.ben } });
  benId = idOf(two.text, "ben@example.com");
  assert.ok(annaId && benId && annaId !== benId);
});

test("a commenter sees only their project and none of the owner's tools", async () => {
  assert.deepEqual((await anna("/api/projects")).json.projects.map((p) => p.name), ["film"]);
  assert.equal((await anna("/api/project?project=film")).status, 200);
  assert.equal((await anna("/api/project")).status, 200, "their one project is the default");
  for (const path of ["/api/project?project=secret", "/api/chat/s01-intro?project=secret", "/p/secret/secret/storyboard.json", "/renders/secret/secret/x.mp4"])
    assert.equal((await anna(path)).status, 404, path);
  // Only what the page shows: builds (with their assets/ and scenes/ links), stills, comment stills.
  const build = (await anna("/api/build/scene/s01-intro?project=film&v=1")).json.url;
  assert.equal((await anna(build)).status, 200, build);
  assert.equal((await anna(build.replace("index.html", "scenes/s01-intro/scene.html"))).status, 200);
  // a scene that loads a file of its own (next to scene.html) and one from assets/
  mkdirSync(join(root, "film", "assets"), { recursive: true });
  writeFileSync(join(root, "film", "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(root, "film", "scenes", "s01-intro", "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const disk = (await anna("/api/build/scene/s01-intro?project=film&v=disk")).json.url.split("?")[0];
  for (const f of ["scenes/s01-intro/pic.svg", "assets/logo.svg"]) assert.equal((await anna(disk.replace("index.html", f))).status, 200, f);
  assert.equal((await anna("/p/film/film/assets/logo.svg")).status, 200);
  for (const path of ["/p/film/film/storyboard.json", "/p/film/film/project.md", "/p/film/film/AGENTS.md", "/p/film/film/scenes/s01-intro/scene.html"])
    assert.equal((await anna(path)).status, 404, path);
  assert.equal((await owner("/p/film/film/AGENTS.md")).status, 200, "an owner gets the files");
  assert.equal((await anna("/p/film/film/..%2Ffilm2%2Fstoryboard.json")).status, 403, "no step into a project whose name starts the same");
  assert.equal((await anna("/p/film/film/..%2F.people.json")).status, 403);
  for (const path of ["/p/film/film/.history/HEAD", "/p/film/film/.state/scenes/s01-intro.json", "/p/film/film/.state/chat/s01-intro.jsonl", "/p/film/film/scenes/.hidden"])
    assert.equal((await anna(path)).status, 404, path);
  assert.equal((await owner("/p/film/film/.history/HEAD")).status, 404, "nobody gets the history over HTTP");
  assert.deepEqual((await anna("/api/tools")).json, []);
  for (const name of ["list_guides", "inspect_guide", "use_guide_once", "get_video_guides", "attach_guide", "remove_guide", "undo_guides", "list_motions", "inspect_motion", "get_scene_motion", "apply_motion", "remove_motion", "apply_transition", "undo_transition", "reset_transition", "list_styles", "inspect_style", "apply_style", "remove_style", "set_scene_text", "get_scene_subtitles", "generate_scene_subtitles", "set_scene_subtitles", "list_patterns", "inspect_pattern", "instantiate_pattern"]) {
    assert.equal((await anna(`/api/tools/${name}?project=film`, { json: { args: { style: "paper", scene: "s01-intro", model: "test" } } })).status, 403, `commenter cannot call ${name}`);
  }
  for (const name of ["get_video_guides", "use_guide_once", "attach_guide", "remove_guide", "undo_guides"]) {
    assert.equal((await anna(`/api/tools/${name}`, {json:{args:{project:"secret",video:"secret",guide:"explain-concept",model:"test"}}})).status,403);
    assert.equal((await anna(`/api/tools/${name}?project=secret`, {json:{args:{project:"secret",video:"secret"}}})).status,404);
  }
  assert.equal((await anna("/api/patterns/process/preview")).status, 403);
  assert.equal((await anna("/api/patterns/process/preview?project=secret")).status, 404);
  assert.equal((await owner("/api/patterns/process/preview")).status, 200);
  assert.equal((await owner("/api/patterns/process/preview?contentHash=stale")).status, 409);
  assert.equal((await owner("/api/tools/instantiate_pattern?project=film", { json:{args:{pattern:"process",title:"Owner creates",model:"test"}} })).status,200);
  assert.equal((await anna("/api/styles/paper/preview")).status, 403);
  assert.equal((await anna("/api/styles/paper/preview?project=secret")).status, 404);
  assert.equal((await owner("/api/styles/paper/preview")).status, 200);
  for (const id of ["fade-in","fade-out","rise","pop","cut","dissolve"]) {
    assert.equal((await anna(`/api/motions/${id}/preview`)).status,403);
    assert.equal((await owner(`/api/motions/${id}/preview`)).status,200);
  }
  const style = await owner("/api/tools/apply_style?project=film", { json: { args: { style: "paper", scene: "s01-intro", model: "test" } } });
  assert.equal(style.status, 200);
  assert.equal((await anna("/api/project?project=film")).json.scenes[0].style.id, "paper");
  assert.equal((await anna("/api/project?project=secret")).status, 404);
  const text = { id: "text-title", text: "A synthetic title", position: "title", style: "dark", start: 0, end: 1 };
  assert.equal((await owner("/api/tools/set_scene_text?project=film", { json: { args: { scene: "s01-intro", items: [text], model: "test" } } })).status, 200);
  assert.deepEqual((await anna("/api/project?project=film")).json.scenes[0].texts, [text]);
  const textBuild = (await anna("/api/build/scene/s01-intro?project=film&v=disk")).json.url;
  assert.match((await anna(textBuild)).text, /A synthetic title/);

  assert.equal((await anna("/api/tools/update_scene?project=film", { json: { args: { scene: "s01-intro", narration: "x" } } })).status, 403);
  assert.equal((await anna("/api/render?project=film", { json: {} })).status, 403);
  assert.equal((await anna("/api/scene/s01-intro/restore?project=film", { json: { v: 1 } })).status, 403);
  assert.equal((await anna("/api/videos/film/film", { method: "DELETE" })).status, 403);
  assert.equal((await anna("/people")).status, 403);
  assert.equal((await anna("/mcp", { json: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 401, "a session never reaches /mcp");
  const auth = await anna("/authorize?response_type=code&client_id=x");
  assert.equal(auth.status, 400);
});

test("comments carry who wrote them; a commenter removes only their own", async () => {
  const r = await anna("/api/scene/s01-intro/comments?project=film", { json: { t: 1, text: "Hold the title longer", by: "Owner" } });
  assert.equal(r.json.by, "Anna", "the server sets by, not the page");
  assert.equal(r.json.byId, annaId);
  const k = await owner("/api/scene/s01-intro/comments?project=film", { json: { t: 2, text: "Warmer blue" } });
  assert.equal(k.json.by, "Owner");
  assert.equal((await anna("/api/scene/s01-intro/comments?project=film", { json: { t: 1, text: "x".repeat(4001) } })).status, 400);
  const del = (b, id) => b(`/api/scene/s01-intro/comments/${id}?project=film`, { method: "DELETE" });
  assert.equal((await del(anna, k.json.id)).status, 400);
  assert.equal((await del(anna, r.json.id)).status, 200);
  assert.equal((await del(owner, k.json.id)).status, 200, "an owner removes anyone's");
  // An agent's comment carries no byId; a commenter named like it still can't remove it.
  const agent = await mcp(SHARED, "add_comment", { project: "film", scene: "s01-intro", t: 3, text: "from an agent" });
  assert.equal(agent.data.byId, undefined);
  assert.equal((await del(anna, agent.data.id)).status, 400);
});

test("writes from another site or not as JSON are refused", async () => {
  assert.equal((await anna("/api/scene/s01-intro/comments?project=film", { json: { t: 1, text: "x" }, origin: "https://evil.example" })).status, 403);
  assert.equal((await anna("/api/scene/s01-intro/comments?project=film", { json: { t: 1, text: "x" }, origin: "null" })).status, 403);
  assert.equal((await owner("/people", { form: { action: "add", name: "Mallory", email: "m@example.com", projects: "film" }, origin: "https://evil.example" })).status, 403);
  const plain = await anna("/api/scene/s01-intro/comments?project=film", { headers: { "Content-Type": "text/plain" }, method: "POST" });
  assert.equal(plain.status, 415);
});

test("live events reach a commenter only for their project, and stop when they lose it", async () => {
  const ctrl = new AbortController();
  const r = await fetch(base + "/api/events", { headers: { Cookie: Object.entries(anna.jar).map(([k, v]) => `${k}=${v}`).join("; ") }, signal: ctrl.signal });
  const reader = r.body.getReader();
  let got = "", closed = false;
  const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) { closed = true; break; } got += Buffer.from(value).toString(); } })().catch(() => {});
  await owner("/api/scene/s01-intro/comments?project=secret", { json: { t: 1, text: "secret note" } });
  await owner("/api/scene/s01-intro/comments?project=film", { json: { t: 1, text: "film note" } });
  await new Promise((res) => setTimeout(res, 300));
  assert.match(got, /"project":"film"/);
  assert.doesNotMatch(got, /secret/);
  await owner("/people", { form: { action: "projects", id: annaId, projects: "film2" } });
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(closed, true, "the stream closes");
  ctrl.abort();
  await reading;
  assert.equal((await anna("/api/whoami")).status, 401, "fewer projects end the session");
  // she logs in again and sees the new project only
  const again = await anna("/login", { form: { email: "anna@example.com", password: PW.anna } });
  assert.equal(again.location, "/?project=film2");
  assert.deepEqual((await anna("/api/projects")).json.projects.map((p) => p.name), ["film2"]);
});

test("too many wrong passwords: per email and address, and per account", async () => {
  const b = browser({ ip: "192.0.2.50" });
  for (let i = 0; i < 5; i++) assert.equal((await b("/login", { form: { email: "nobody@example.com", password: "nope nope nope" } })).status, 401);
  assert.equal((await b("/login", { form: { email: "nobody@example.com", password: "nope nope nope" } })).status, 429);
  assert.equal((await browser({ ip: "192.0.2.51" })("/login", { form: { email: "nobody@example.com", password: "nope nope nope" } })).status, 401, "another address is counted apart");

  for (let i = 0; i < 20; i++) await browser({ ip: `10.9.0.${i + 1}` })("/login", { form: { email: "ben@example.com", password: "wrong wrong wrong" } });
  const ben = browser({ ip: "10.9.1.1" });
  const locked = await ben("/login", { form: { email: "ben@example.com", password: PW.ben } });
  assert.equal(locked.status, 401, "a locked commenter stays out");
  for (let i = 0; i < 20; i++) await browser({ ip: `10.8.0.${i + 1}` })("/login", { form: { email: "ghost@example.com", password: "wrong wrong wrong" } });
  const ghost = await browser({ ip: "10.8.1.1" })("/login", { form: { email: "ghost@example.com", password: PW.ben } });
  const msg = (r) => r.text.match(/class="err">([^<]*)/)[1];
  assert.equal(ghost.status, locked.status, "locked and unknown answer alike");
  assert.equal(msg(ghost), msg(locked));
  assert.match((await owner("/people")).text, /Locked until/);
  await owner("/people", { form: { action: "unlock", id: benId } });
  assert.equal((await ben("/login", { form: { email: "ben@example.com", password: PW.ben } })).status, 302);
});

test("strangers can't lock an owner out: the right password and code still get in", async () => {
  for (let i = 0; i < 20; i++) await browser({ ip: `10.7.0.${i + 1}` })("/login", { form: { email: "owner@example.com", password: "wrong wrong wrong" } });
  assert.match((await owner("/people")).text, /Locked until/);
  const b = browser({ ip: "10.7.1.1" });
  const first = await b("/login", { form: { email: "owner@example.com", password: PW.owner } });
  const mfa = field(first.text, "mfa");
  assert.ok(mfa, "the password step passes");
  // while locked, one password try per 30 s for the account, from any address
  assert.equal((await browser({ ip: "10.7.1.2" })("/login", { form: { email: "owner@example.com", password: PW.owner } })).status, 429);
  const done = await b("/login", { form: { step: "code", mfa, code: totp(ownerSecret, step() + 1) } });
  assert.equal(done.status, 302);
  assert.equal((await b("/api/whoami")).json.reviewer, "Owner");
  const ownerId = idOf((await owner("/people")).text, "owner@example.com");
  await owner("/people", { form: { action: "unlock", id: ownerId } });
});

test("wrong authenticator codes are capped per account, from any address", async () => {
  const mfa = field((await browser({ ip: "10.6.0.1" })("/login", { form: { email: "owner@example.com", password: PW.owner } })).text, "mfa");
  for (let i = 0; i < 10; i++) assert.equal((await browser({ ip: `10.6.1.${i % 3}` })("/login", { form: { step: "code", mfa, code: "000000" } })).status, 401);
  const right = await browser({ ip: "10.6.2.1" })("/login", { form: { step: "code", mfa, code: totp(ownerSecret, step() + 1) } });
  assert.equal(right.status, 429, "the code step is closed for the account, even with the right code");
  const pw = await browser({ ip: "10.6.2.2" })("/login", { form: { email: "owner@example.com", password: PW.owner } });
  assert.ok(field(pw.text, "mfa"), "the password step still shows the code form");
  assert.match((await owner("/people")).text, /Locked until/);
  await owner("/people", { form: { action: "unlock", id: idOf((await owner("/people")).text, "owner@example.com") } });
  assert.equal((await browser({ ip: "10.6.2.3" })("/login", { form: { step: "code", mfa, code: "000000" } })).status, 401, "unlock opens it again");
});

test("a browser that logged in before gets past a lock a stranger keeps up", async () => {
  assert.ok(owner.jar.sl_device, "a login leaves a device cookie");
  for (let i = 0; i < 20; i++) await browser({ ip: `10.5.0.${i + 1}` })("/login", { form: { email: "owner@example.com", password: "wrong wrong wrong" } });
  // the stranger takes the slot of these 30 seconds
  await browser({ ip: "10.5.1.1" })("/login", { form: { email: "owner@example.com", password: "wrong wrong wrong" } });
  assert.equal((await browser({ ip: "10.5.1.2" })("/login", { form: { email: "owner@example.com", password: PW.owner } })).status, 429, "a new browser waits for the slot");
  const mine = browser({ ip: "10.5.1.3" });
  mine.jar.sl_device = owner.jar.sl_device;
  const r = await mine("/login", { form: { email: "owner@example.com", password: PW.owner } });
  assert.ok(field(r.text, "mfa"), "the owner's own browser gets the code form");
  const wrongPw = await mine("/login", { form: { email: "owner@example.com", password: "not it at all" } });
  assert.equal(wrongPw.status, 401, "it still needs the password");
  const other = browser({ ip: "10.5.1.4" });
  other.jar.sl_device = anna.jar.sl_device;
  assert.equal((await other("/login", { form: { email: "owner@example.com", password: PW.owner } })).status, 429, "another person's device cookie doesn't count");
  await owner("/people", { form: { action: "unlock", id: idOf((await owner("/people")).text, "owner@example.com") } });
});

test("next after login stays on this site", async () => {
  const b = browser({ ip: "192.0.2.80" });
  for (const next of ["/\t/evil.com", "//evil.com", "/\\evil.com", "https://evil.com", "/%09/evil.com", "/.//evil.com", "/..//evil.com", "/%2e//evil.com", "/a/..//evil.com"]) {
    const r = await b("/login", { form: { email: "anna@example.com", password: PW.anna, next } });
    assert.ok(r.location === "/" || r.location?.startsWith("/?") || r.location === "/%09/evil.com", `${JSON.stringify(next)} went to ${r.location}`);
    assert.ok(!r.location.startsWith("//"));
    // with a session, GET /login sends you on at once
    const again = await b(`/login?next=${encodeURIComponent(next)}`);
    assert.ok(!again.location.startsWith("//") && !again.location.includes("evil.com/"), `GET ${JSON.stringify(next)} went to ${again.location}`);
    await b("/logout", { method: "POST" });
  }
  const ok = await b("/login", { form: { email: "anna@example.com", password: PW.anna, next: "/?project=film2&video=film2" } });
  assert.equal(ok.location, "/?project=film2&video=film2");
});

test("logging out ends the session on the server, not just in the browser", async () => {
  const b = browser({ ip: "192.0.2.81" });
  await b("/login", { form: { email: "anna@example.com", password: PW.anna } });
  const stolen = { ...b.jar };
  assert.equal((await b("/api/whoami")).status, 200);
  assert.equal((await b("/logout")).status, 200, "GET only shows the button");
  assert.equal((await b("/api/whoami")).status, 200, "and logs nobody out");
  assert.equal((await b("/logout", { method: "POST", origin: "https://evil.example" })).status, 403);
  assert.equal((await b("/api/whoami")).status, 200);
  await b("/logout", { method: "POST" });
  const replay = await fetch(base + "/api/whoami", { headers: { Cookie: Object.entries(stolen).map(([k, v]) => `${k}=${v}`).join("; ") } });
  assert.equal(replay.status, 401);
  assert.equal((await anna("/api/whoami")).status, 200, "her other sessions stay");
});

test("a person changes their password; other devices are logged out", async () => {
  const other = browser({ ip: "198.51.100.9" });
  assert.equal((await other("/login", { form: { email: "anna@example.com", password: PW.anna } })).status, 302);
  assert.match((await anna("/account", { form: { action: "password", current: "wrong", password: "new anna password", again: "new anna password" } })).text, /current password is wrong/);
  assert.match((await anna("/account", { form: { action: "password", current: PW.anna, password: "new anna password", again: "new anna password" } })).text, /Password changed/);
  assert.equal((await anna("/api/whoami")).status, 200, "this device stays in");
  assert.equal((await other("/api/whoami")).status, 401);
});

test("removing someone ends their access at once", async () => {
  const ben = browser({ ip: "10.9.1.2" });
  assert.equal((await ben("/login", { form: { email: "ben@example.com", password: PW.ben } })).status, 302);
  assert.equal((await ben("/api/projects")).status, 200);
  await owner("/people", { form: { action: "remove", id: benId } });
  assert.equal((await ben("/api/projects")).status, 401);
  assert.doesNotMatch((await owner("/people")).text, /ben@example.com/);
});

test("agent tokens belong to owners, carry the name, and can be revoked", async () => {
  assert.equal((await mcp("not-a-token-0123456789", "list_projects")).status, 401);
  assert.equal((await mcp(SHARED, "list_projects")).status, 200, "SCENE_LOOP_TOKEN still works");
  const page = await owner("/account", { form: { action: "new-token", label: "Claude Code" } });
  const token = page.text.match(/value="(sl_[\w-]+)"/)[1];
  const c = await mcp(token, "add_comment", { project: "film", scene: "s01-intro", t: 1, text: "From the owner's agent" });
  assert.equal(c.data.by, "Owner");
  const { data: scene } = await mcp(token, "get_scene_html", { project: "film", scene: "s01-intro" });
  await mcp(token, "write_scene_html", { project: "film", scene: "s01-intro", html: scene.html.replace("</template>", "<!-- o --></template>"), model: "claude" });
  const view = (await owner("/api/project?project=film")).json;
  assert.equal(view.scenes.find((s) => s.id === "s01-intro").versions.at(-1).agent, "claude (Owner)");
  assert.match((await owner("/people", { form: { action: "new-token", id: annaId, label: "x" } })).text, /Only owners have agent access/);
  // An agent token is for /mcp: it can't add an owner, see invite links or mint tokens.
  const bearer = { Authorization: `Bearer ${token}` };
  for (const path of ["/people", "/account", "/api/projects", "/api/whoami"]) assert.equal((await fetch(base + path, { headers: bearer })).status, 401, path);
  const forged = await fetch(base + "/people", { method: "POST", headers: { ...bearer, Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "add", name: "Mallory", email: "m@example.com", role: "owner" }) });
  assert.equal(forged.status, 401);
  assert.equal((await fetch(base + "/people", { headers: { Authorization: `Bearer ${SHARED}` } })).status, 401, "SCENE_LOOP_TOKEN neither");
  assert.doesNotMatch((await owner("/people")).text, /Mallory/);
  const tid = (await owner("/account")).text.match(/name="id" value="p_\w+"><input type="hidden" name="action" value="revoke-token"><input type="hidden" name="token" value="(t_\w+)"/)[1];
  await owner("/account", { form: { action: "revoke-token", token: tid } });
  assert.equal((await mcp(token, "list_projects")).status, 401);
});

test("/authorize fetches client metadata from public addresses only, and shows none of it", async () => {
  for (const id of ["https://100.64.0.1/client.json", "https://127.0.0.1/client.json", "https://localhost/client.json", "https://[::1]/client.json", "https://169.254.169.254/latest", "https://10.0.0.1/c"]) {
    const r = await browser()(`/authorize?${new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: "https://x.example/cb", code_challenge: "x", code_challenge_method: "S256" })}`);
    assert.equal(r.status, 400, id);
    assert.match(r.text, /private address/, id);
  }
});

test("OAuth: only an owner approves, and log out everywhere ends the connector", async () => {
  const reg = await fetch(base + "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://localhost:9/cb"], client_name: "Test client" }) }).then((r) => r.json());
  const verifier = randomBytes(32).toString("base64url");
  const params = { response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:9/cb", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s1" };
  assert.match((await anna(`/authorize?${new URLSearchParams(params)}`)).text, /not connect an agent/);
  assert.match((await owner(`/authorize?${new URLSearchParams(params)}`)).text, /as <b>Owner<\/b>/);
  const ok = await owner("/authorize", { form: { ...params, action: "approve" } });
  const code = new URL(ok.location).searchParams.get("code");
  const tok = await fetch(base + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: params.redirect_uri, code_verifier: verifier, client_id: reg.client_id }) }).then((r) => r.json());
  assert.ok(tok.access_token);
  assert.equal((await mcp(tok.access_token, "list_projects")).status, 200);
  assert.equal((await fetch(base + "/people", { headers: { Authorization: `Bearer ${tok.access_token}` } })).status, 401, "an OAuth token is for /mcp only");
  await owner("/account", { form: { action: "logout" } });
  assert.equal((await mcp(tok.access_token, "list_projects")).status, 401);
  const refresh = await fetch(base + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }) }).then((r) => r.json());
  assert.equal(refresh.error, "invalid_grant");
  assert.equal((await owner("/api/whoami")).status, 401);
});
