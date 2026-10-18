// The share listener: Cloudflare Access JWTs checked against a stand-in key server, and a
// server run on two scratch copies of the template, one of them shared. Needs git (versions);
// no Chrome or ffmpeg, it does not wait for stills.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createShare } from "../lib/share.mjs";
import { TEMPLATE_DIR } from "../lib/projects.mjs";

const TEAM = "testteam";
const AUD = "aud-tag-1";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(claims, { key = privateKey, kid = "k1" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64u({ alg: "RS256", kid, typ: "JWT" })}.${b64u({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], iat: now, exp: now + 600, ...claims })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
}

let certs, certsUrl, root, proc, main, shared;
const PEOPLE = "anna@example.com=Anna,kristian@example.com=Kristian";
const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  certs = createServer((req, res) => res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }] })));
  await new Promise((r) => certs.listen(0, "127.0.0.1", r));
  certsUrl = `http://127.0.0.1:${certs.address().port}/certs`;

  root = mkdtempSync(join(tmpdir(), "sl-share-"));
  cpSync(TEMPLATE_DIR, join(root, "film"), { recursive: true });
  cpSync(TEMPLATE_DIR, join(root, "secret"), { recursive: true });
  const [mp, sp] = [await freePort(), await freePort()];
  main = `http://127.0.0.1:${mp}`;
  shared = `http://127.0.0.1:${sp}`;
  proc = spawn(process.execPath, ["server.mjs", root, "--port", String(mp), "--reviewer", "Kristian"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, SCENE_LOOP_SHARE_PORT: String(sp), SCENE_LOOP_SHARE_PROJECTS: "film", SCENE_LOOP_SHARE_PEOPLE: PEOPLE, SCENE_LOOP_ACCESS_TEAM: TEAM, SCENE_LOOP_ACCESS_AUD: AUD, SCENE_LOOP_ACCESS_CERTS: certsUrl },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    let out = "";
    proc.stdout.on("data", (d) => (out += d) && out.includes("Share listener") && resolve());
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(() => {
  proc?.kill();
  certs?.close();
  rmSync(root, { recursive: true, force: true });
});

const as = (email) => ({ "Cf-Access-Jwt-Assertion": jwt({ email }) });
const call = async (base, path, { headers = {}, method, body } = {}) => {
  const r = await fetch(base + path, { method: method ?? (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

test("createShare turns a valid Access JWT into the listed person, and nothing else", async () => {
  const s = createShare({ port: 1, projects: "film", people: PEOPLE, team: TEAM, aud: AUD, certsUrl });
  const who = (token) => s.who({ headers: token ? { "cf-access-jwt-assertion": token } : {} });
  assert.deepEqual(await who(jwt({ email: "Anna@Example.com" })), { email: "anna@example.com", name: "Anna" });
  assert.equal(await who(null), null);
  assert.equal(await who(jwt({ email: "someone@example.com" })), null, "not on the list");
  assert.equal(await who(jwt({ email: "anna@example.com", aud: ["another-app"] })), null, "another Access app");
  assert.equal(await who(jwt({ email: "anna@example.com", iss: "https://evil.cloudflareaccess.com" })), null, "another team");
  assert.equal(await who(jwt({ email: "anna@example.com", exp: Math.floor(Date.now() / 1000) - 5 })), null, "expired");
  assert.equal(await who(jwt({ email: "anna@example.com" }, { key: other.privateKey })), null, "signed by someone else");
  const [h, , sig] = jwt({ email: "kristian@example.com" }).split(".");
  assert.equal(await who(`${h}.${b64u({ email: "anna@example.com", aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`, exp: 9e9 })}.${sig}`), null, "payload swapped");
  assert.throws(() => createShare({ port: 1, projects: "film", people: PEOPLE }), /ACCESS_TEAM/);
  assert.throws(() => createShare({ port: 1, projects: "", people: PEOPLE, team: TEAM, aud: AUD }), /PROJECTS/);
  assert.throws(() => createShare({ port: 1, projects: "film", people: "anna", team: TEAM, aud: AUD }), /email=Name/);
});

test("the share listener refuses requests without a listed person's JWT", async () => {
  assert.equal((await call(shared, "/")).status, 403);
  assert.equal((await call(shared, "/api/whoami", { headers: as("stranger@example.com") })).status, 403);
  const me = await call(shared, "/api/whoami", { headers: as("anna@example.com") });
  assert.deepEqual(me.json, { reviewer: "Anna", guest: true });
  assert.deepEqual((await call(main, "/api/whoami")).json, { reviewer: "Kristian", guest: false });
});

test("a guest sees only the shared project", async () => {
  const h = { headers: as("anna@example.com") };
  const list = (await call(shared, "/api/projects", h)).json;
  assert.deepEqual(list.projects.map((p) => p.name), ["film"]);
  assert.equal(list.root, null);
  assert.ok(list.projects.every((p) => !("dir" in p)), "no server paths");
  assert.equal((await call(shared, "/api/project?project=film&video=film", h)).status, 200);
  assert.equal((await call(shared, "/api/project", h)).status, 200, "the one shared project is the default");
  assert.equal((await call(shared, "/api/project?project=secret&video=secret", h)).status, 404);
  assert.equal((await call(shared, "/api/chat/s01-intro?project=secret", h)).status, 404);
  assert.equal((await call(shared, "/p/secret/secret/storyboard.json", h)).status, 404);
  assert.equal((await call(shared, "/p/film/film/storyboard.json", h)).status, 200);
  assert.equal((await call(shared, "/p/film/film/../../secret/storyboard.json", h)).status, 404);
  assert.equal((await call(shared, "/renders/secret/secret/x.mp4", h)).status, 404);
  assert.deepEqual((await call(shared, "/api/tools", h)).json, []);
  // the main listener still sees both
  assert.deepEqual((await call(main, "/api/projects")).json.projects.map((p) => p.name), ["film", "secret"]);
});

test("a guest cannot reach the agent tools, renders, restores or deletes", async () => {
  const h = as("anna@example.com");
  assert.equal((await call(shared, "/mcp", { headers: h, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 404);
  assert.equal((await call(shared, "/api/tools/update_scene?project=film", { headers: h, body: { args: { scene: "s01-intro", narration: "x" } } })).status, 403);
  assert.equal((await call(shared, "/api/tools/list_projects?project=film", { headers: h, body: { args: {} } })).status, 403);
  assert.equal((await call(shared, "/api/render?project=film", { headers: h, body: {} })).status, 403);
  assert.equal((await call(shared, "/api/scene/s01-intro/restore?project=film", { headers: h, body: { v: 1 } })).status, 403);
  assert.equal((await call(shared, "/api/videos/film/film", { headers: h, method: "DELETE" })).status, 403);
});

test("comments carry who wrote them; a guest removes only their own", async () => {
  const anna = as("anna@example.com");
  const r = await call(shared, "/api/scene/s01-intro/comments?project=film", { headers: anna, body: { t: 1, text: "Hold the title longer", by: "Kristian" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.by, "Anna", "the server sets by, not the page");
  const k = await call(main, "/api/scene/s01-intro/comments?project=film", { body: { t: 2, text: "Warmer blue" } });
  assert.equal(k.json.by, "Kristian");

  const view = (await call(shared, "/api/project?project=film", { headers: anna })).json;
  const comments = view.scenes.find((s) => s.id === "s01-intro").comments;
  assert.deepEqual(comments.map((c) => [c.text, c.by]), [["Hold the title longer", "Anna"], ["Warmer blue", "Kristian"]]);

  const tools = await call(main, "/api/tools/list_scenes?project=film", { body: { args: {} } });
  assert.deepEqual(tools.json.scenes.find((s) => s.id === "s01-intro").pendingComments.map((c) => c.by), ["Anna", "Kristian"]);

  const del = (id, headers) => call(shared, `/api/scene/s01-intro/comments/${id}?project=film`, { headers, method: "DELETE" });
  assert.equal((await del(k.json.id, anna)).status, 400);
  assert.equal((await del(r.json.id, anna)).status, 200);
  const left = (await call(main, "/api/project?project=film")).json.scenes.find((s) => s.id === "s01-intro").comments;
  assert.deepEqual(left.map((c) => c.by), ["Kristian"]);
  // the owner removes anyone's
  assert.equal((await call(main, `/api/scene/s01-intro/comments/${k.json.id}?project=film`, { method: "DELETE" })).status, 200);
});

test("a guest's write from another site is refused", async () => {
  const r = await call(shared, "/api/scene/s01-intro/comments?project=film", { headers: { ...as("anna@example.com"), Origin: "https://evil.example" }, body: { t: 1, text: "x" } });
  assert.equal(r.status, 403);
});

test("live events reach a guest only for the shared project", async () => {
  const ctrl = new AbortController();
  const r = await fetch(shared + "/api/events", { headers: as("anna@example.com"), signal: ctrl.signal });
  const reader = r.body.getReader();
  let got = "";
  const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; got += Buffer.from(value).toString(); } })().catch(() => {});
  await call(main, "/api/scene/s01-intro/comments?project=secret", { body: { t: 1, text: "secret note" } });
  await call(main, "/api/scene/s01-intro/comments?project=film", { body: { t: 1, text: "film note" } });
  await new Promise((res) => setTimeout(res, 300));
  ctrl.abort();
  await reading;
  assert.match(got, /"project":"film"/);
  assert.doesNotMatch(got, /secret/);
});
