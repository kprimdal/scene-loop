// A server whose root is itself one video keeps the people file in that video's folder. It
// must never reach the version history (whose objects would carry the password hashes and
// the session key) and never be served, not even to an owner.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { TEMPLATE_DIR } from "../lib/projects.mjs";
import { createHistory } from "../lib/history.mjs";

const SERVER = join(import.meta.dirname, "..", "server.mjs");
const PASSWORD = "bootstrap password here";
const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
let dir, proc, base, name;

before(async () => {
  dir = join(mkdtempSync(join(tmpdir(), "sl-single-")), "film");
  cpSync(TEMPLATE_DIR, dir, { recursive: true });
  name = basename(dir);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, [SERVER, dir, "--invite-owner", "owner@example.com", "Owner"], { encoding: "utf8" });
  proc = spawn(process.execPath, [SERVER, dir, "--port", String(port)], { env: { ...process.env, SCENE_LOOP_PASSWORD: PASSWORD }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => String(d).includes("Login on") && resolve());
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  // the history is made when the video first opens, in the background
  for (let i = 0; i < 100 && !existsSync(join(dir, ".history", "refs", "tags")); i++) await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 50; i++) {
    try { execFileSync("git", ["--git-dir", join(dir, ".history"), "rev-parse", "HEAD"], { stdio: "ignore" }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
after(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("the people file is not in the video's history", () => {
  assert.ok(existsSync(join(dir, ".people.json")));
  const files = execFileSync("git", ["--git-dir", join(dir, ".history"), "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" }).split("\n");
  assert.ok(files.includes("storyboard.json"), "the history holds the video");
  assert.ok(!files.some((f) => f.includes("people")), files.join(", "));
  assert.match(readFileSync(join(dir, ".history", "info", "exclude"), "utf8"), /^\.people\.json\*$/m);
});

test("a history made before the exclude gets it added", () => {
  const old = mkdtempSync(join(tmpdir(), "sl-oldhist-"));
  try {
    mkdirSync(join(old, ".history", "info"), { recursive: true });
    writeFileSync(join(old, ".history", "info", "exclude"), ".history/\n.build/\n");
    createHistory(old);
    assert.match(readFileSync(join(old, ".history", "info", "exclude"), "utf8"), /^\.people\.json\*$/m);
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});

test("neither the people file nor the history is served, even to an owner", async () => {
  const login = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base }, body: new URLSearchParams({ email: "", password: PASSWORD }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const get = (p) => fetch(base + p, { headers: { Cookie: cookie } });
  assert.equal((await get(`/p/${name}/${name}/storyboard.json`)).status, 200);
  assert.equal((await get(`/p/${name}/${name}/.people.json`)).status, 403);
  assert.equal((await get(`/p/${name}/${name}/.history/HEAD`)).status, 404);
  assert.equal((await get(`/p/${name}/${name}/.history/config`)).status, 404);
});
