// A server that ran on the older settings (one password, SCENE_LOOP_TOKENS, the share
// listener's SCENE_LOOP_SHARE_*) starts on the people list: everyone moves in once, tokens keep
// working, and the shared password works only until the first owner has an account.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TEMPLATE_DIR } from "../lib/projects.mjs";
import { totp } from "../lib/people.mjs";

const BEN = "ben-token-0123456789abcdef";
const PASSWORD = "the old shared password";
const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
let root, proc, base, log = "";

before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-migrate-"));
  for (const n of ["film", "secret"]) cpSync(TEMPLATE_DIR, join(root, n), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["server.mjs", root, "--port", String(port)], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, SCENE_LOOP_PASSWORD: PASSWORD, SCENE_LOOP_TOKENS: `Ben=${BEN}`, SCENE_LOOP_SHARE_PORT: "4999", SCENE_LOOP_SHARE_PROJECTS: "film", SCENE_LOOP_SHARE_PEOPLE: "anna@example.com=Anna,ben@example.com=Ben" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const take = (d) => (log += d) && log.includes("Login on") && resolve();
    proc.stdout.on("data", take);
    proc.stderr.on("data", take);
    proc.on("exit", (c) => reject(new Error(`server exited ${c}: ${log}`)));
  });
});
after(() => {
  proc?.kill();
  rmSync(root, { recursive: true, force: true });
});

const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const post = (path, form, cookie = "") => fetch(base + path, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: cookie }, body: new URLSearchParams(form) });
const get = (path, cookie = "") => fetch(base + path, { redirect: "manual", headers: { Cookie: cookie } });

test("the older settings move into the people file, and the share listener is gone", async () => {
  assert.match(log, /Moved 2 people/);
  assert.match(log, /Ben \(owner, ben@example.com, 1 token\)/);
  assert.match(log, /Anna \(commenter, anna@example.com\)/);
  assert.match(log, /SCENE_LOOP_SHARE_PORT is gone/);
  assert.ok(existsSync(join(root, ".people.json")));
  await assert.rejects(fetch("http://127.0.0.1:4999/"), "no second listener");
});

test("a moved token still works and still names its person", async () => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${BEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_comment", arguments: { project: "film", scene: "s01-intro", t: 1, text: "from Ben's agent" } } }),
  });
  const j = await r.json();
  assert.equal(JSON.parse(j.result.content[0].text).by, "Ben");
});

test("the shared password works until the first owner has finished their invite", async () => {
  assert.equal((await post("/login", { email: "", password: "wrong" })).status, 401);
  const boot = await post("/login", { email: "", password: PASSWORD });
  assert.equal(boot.status, 302);
  const cookie = cookieOf(boot);
  const people = await (await get("/people", cookie)).text();
  assert.match(people, /anna@example.com/);
  assert.match(people, /No login yet/);
  const benId = people.split("<tr>").slice(1).find((r) => r.includes("ben@example.com")).match(/name="id" value="(p_\w+)"/)[1];
  const link = (await (await post("/people", { action: "invite", id: benId }, cookie)).text()).match(/value="http[^"]*(\/invite\/[\w-]+)"/)[1];
  const page = await (await get(link)).text();
  const secret = page.match(/id="totpKey">([A-Z2-7 ]+)</)[1].replace(/ /g, "");
  const setup = page.match(/name="setup" value="([^"]*)"/)[1];
  const done = await post(link, { password: "ben password 123", again: "ben password 123", setup, code: totp(secret, Math.floor(Date.now() / 30000)) });
  assert.equal(done.status, 302);
  assert.equal((await get("/api/whoami", cookieOf(done))).status, 200);
  assert.equal((await get("/api/whoami", cookie)).status, 401, "the password session ends");
  assert.equal((await post("/login", { email: "", password: PASSWORD })).status, 401, "and the password no longer logs in");
});
