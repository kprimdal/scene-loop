// The older shared password, with nobody on the people list: logging out ends that session on
// the server and writes nothing to disk, so the people file (and the one-time move of the old
// env settings into it) is still to come.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TEMPLATE_DIR } from "../lib/projects.mjs";

const PASSWORD = "the shared password";
const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
let root, proc, base;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-password-"));
  cpSync(TEMPLATE_DIR, join(root, "film"), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["server.mjs", root, "--port", String(port)], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, SCENE_LOOP_PASSWORD: PASSWORD },
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

test("logging out of a password session ends it and creates no people file", async () => {
  const login = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base }, body: new URLSearchParams({ password: PASSWORD }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const whoami = () => fetch(base + "/api/whoami", { headers: { Cookie: cookie } }).then((r) => r.status);
  assert.equal(await whoami(), 200);
  const out = await fetch(base + "/logout", { method: "POST", redirect: "manual", headers: { Cookie: cookie, Origin: base } });
  assert.equal(out.status, 302);
  assert.equal(await whoami(), 401, "the copied cookie no longer works");
  assert.equal(existsSync(join(root, ".people.json")), false);
});
