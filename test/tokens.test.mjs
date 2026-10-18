// One MCP token per person (SCENE_LOOP_TOKENS): the agent's writes and comments carry the
// person's name, the shared SCENE_LOOP_TOKEN still works, anything else gets a 401. Runs the
// server on a scratch copy of the template; needs git, not Chrome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TEMPLATE_DIR } from "../lib/projects.mjs";

const ANNA = "anna-token-0123456789abcdef";
const BEN = "ben-token-0123456789abcdef";
const SHARED = "shared-token-0123456789abcdef";
let root, proc, base;
const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

before(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-tokens-"));
  cpSync(TEMPLATE_DIR, join(root, "film"), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["server.mjs", root, "--port", String(port), "--reviewer", "Owner", "--no-login"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, SCENE_LOOP_TOKEN: SHARED, SCENE_LOOP_TOKENS: `Anna=${ANNA}, Ben=${BEN}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => String(d).includes("scene-loop") && resolve());
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(() => {
  proc?.kill();
  rmSync(root, { recursive: true, force: true });
});

let nextId = 1;
async function tool(token, name, args) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  if (r.status !== 200) return { status: r.status };
  const j = await r.json();
  const text = j.result.content.find((c) => c.type === "text")?.text;
  return { status: 200, error: j.result.isError ? text : null, data: j.result.isError ? null : JSON.parse(text) };
}

test("/mcp wants a known token", async () => {
  assert.equal((await tool(null, "list_projects", {})).status, 401);
  assert.equal((await tool("not-a-token-0123456789", "list_projects", {})).status, 401);
  assert.equal((await tool(ANNA, "list_projects", {})).status, 200);
  assert.equal((await tool(SHARED, "list_projects", {})).status, 200);
});

test("a person's writes and comments carry their name; the shared token's do not", async () => {
  const { data: scene } = await tool(ANNA, "get_scene_html", { scene: "s01-intro" });
  const w = await tool(ANNA, "write_scene_html", { scene: "s01-intro", html: scene.html.replace("</template>", "<!-- anna --></template>"), model: "claude", note: "anna's edit" });
  assert.equal(w.error, null);
  const c1 = await tool(BEN, "add_comment", { scene: "s01-intro", t: 1, text: "From Ben's chat" });
  const c2 = await tool(SHARED, "add_comment", { scene: "s01-intro", t: 2, text: "From the shared token" });
  assert.equal(c1.data.by, "Ben");
  assert.equal(c2.data.by, undefined);

  const view = await (await fetch(`${base}/api/project`)).json();
  const sc = view.scenes.find((s) => s.id === "s01-intro");
  assert.equal(sc.versions.at(-1).agent, "claude (Anna)");
  assert.deepEqual(sc.comments.map((c) => c.by), ["Ben", undefined]);
  const pending = await tool(SHARED, "get_pending_comments", {});
  assert.deepEqual(pending.data.pending.map((c) => c.by), ["Ben", undefined]);
});

test("the token's name always ends the agent label, whatever model says", async () => {
  const { data: scene } = await tool(BEN, "get_scene_html", { scene: "s01-intro" });
  await tool(BEN, "write_scene_html", { scene: "s01-intro", html: scene.html.replace("</template>", "<!-- ben --></template>"), model: "gpt (Anna)" });
  const view = await (await fetch(`${base}/api/project`)).json();
  assert.equal(view.scenes.find((s) => s.id === "s01-intro").versions.at(-1).agent, "gpt (Anna) (Ben)");
});
