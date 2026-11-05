// Sign-in with Microsoft Entra ID, against a fake Entra on localhost that signs real RS256 ID
// tokens: the page login, the OAuth flow a chat runs, who gets in (the people list, bound to the
// Entra account on first sign-in), and the checks on the ID token. Needs git, not Chrome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign as rsaSign } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TEMPLATE_DIR } from "../lib/projects.mjs";
import { createPeople } from "../lib/people.mjs";

const SERVER = join(import.meta.dirname, "..", "server.mjs");
const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const b64u = (b) => Buffer.from(b).toString("base64url");
const freePort = () => new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---------- a fake Entra ----------
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };
let fake, entraBase, issuer;
let identity = null; // who "signs in" at the fake's authorize page
let tamper = null; // (claims) => claims, or { key } to sign with another key
const codes = new Map();
const idToken = (claims, key = privateKey) => {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(rsaSign("RSA-SHA256", Buffer.from(`${h}.${p}`), key))}`;
};
async function startFake() {
  const port = await freePort();
  entraBase = `http://127.0.0.1:${port}`;
  issuer = `${entraBase}/${TENANT}/v2.0`;
  fake = createServer(async (req, res) => {
    const u = new URL(req.url, entraBase);
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === `/${TENANT}/v2.0/.well-known/openid-configuration`)
      return send(200, { issuer, authorization_endpoint: `${entraBase}/${TENANT}/oauth2/v2.0/authorize`, token_endpoint: `${entraBase}/${TENANT}/oauth2/v2.0/token`, jwks_uri: `${entraBase}/${TENANT}/discovery/v2.0/keys` });
    if (u.pathname === `/${TENANT}/discovery/v2.0/keys`) return send(200, { keys: [jwk] });
    if (u.pathname === `/${TENANT}/oauth2/v2.0/authorize`) {
      const q = u.searchParams;
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("state", q.get("state"));
      if (!identity) back.searchParams.set("error", "access_denied");
      else {
        const code = b64u(randomBytes(12));
        codes.set(code, { who: identity, nonce: q.get("nonce"), challenge: q.get("code_challenge"), redirect: q.get("redirect_uri"), client: q.get("client_id") });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (u.pathname === `/${TENANT}/oauth2/v2.0/token` && req.method === "POST") {
      let raw = "";
      for await (const d of req) raw += d;
      const b = Object.fromEntries(new URLSearchParams(raw));
      const c = codes.get(b.code);
      codes.delete(b.code);
      if (!c || b.client_secret !== "entra-secret" || b.client_id !== c.client || b.redirect_uri !== c.redirect) return send(400, { error: "invalid_grant" });
      if (b64u(createHash("sha256").update(b.code_verifier ?? "").digest()) !== c.challenge) return send(400, { error: "invalid_grant", error_description: "PKCE" });
      let claims = { iss: issuer, aud: CLIENT, tid: TENANT, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), nonce: c.nonce, ...c.who };
      let key = privateKey;
      if (typeof tamper === "function") claims = tamper(claims);
      else if (tamper?.key) key = tamper.key;
      return send(200, { id_token: idToken(claims, key), token_type: "Bearer" });
    }
    send(404, {});
  });
  await new Promise((r) => fake.listen(port, "127.0.0.1", r));
}

// ---------- scene-loop ----------
let root, proc, base;
before(async () => {
  await startFake();
  root = mkdtempSync(join(tmpdir(), "sl-entra-"));
  for (const n of ["film", "secret"]) cpSync(TEMPLATE_DIR, join(root, n), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [SERVER, root, "--port", String(port), "--host", "0.0.0.0", "--url", base], {
    env: {
      ...process.env,
      SCENE_LOOP_SECRET: "test-secret",
      SCENE_LOOP_ENTRA_TENANT: TENANT,
      SCENE_LOOP_ENTRA_CLIENT_ID: CLIENT,
      SCENE_LOOP_ENTRA_CLIENT_SECRET: "entra-secret",
      SCENE_LOOP_ENTRA_AUTHORITY: entraBase,
      SCENE_LOOP_ENTRA_OWNERS: "owner@example.com=Owner",
      SCENE_LOOP_OAUTH_REDIRECTS: `${CLAUDE},https://claude.com/api/mcp/auth_callback`,
      SCENE_LOOP_PASSWORD: "ignored with entra",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stderr.on("data", (d) => { log += d; });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => String(d).includes("Login on") && resolve());
    proc.on("exit", (c) => reject(new Error(`server exited ${c}: ${log}`)));
  });
});
after(() => {
  proc?.kill();
  fake?.close();
  rmSync(root, { recursive: true, force: true });
});

// A browser: keeps cookies per host, sends this site's Origin on writes, no automatic redirects.
function browser() {
  const jar = {};
  const go = async (url, { method, form, json, headers = {} } = {}) => {
    const full = url.startsWith("http") ? url : base + url;
    const h = { ...headers };
    if (full.startsWith(base) && Object.keys(jar).length) h.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    let body;
    if (form) { h["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
    if (json) { h["Content-Type"] = "application/json"; body = JSON.stringify(json); }
    const m = method ?? (body ? "POST" : "GET");
    if (m !== "GET" && full.startsWith(base)) h.Origin = base;
    const r = await fetch(full, { method: m, headers: h, body, redirect: "manual" });
    if (full.startsWith(base)) for (const c of r.headers.getSetCookie()) {
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
// Sign in on the page as `who`, following the redirects through the fake Entra.
async function signIn(go, who, next = "/") {
  identity = who;
  const start = await go(`/login/entra?next=${encodeURIComponent(next)}`);
  assert.equal(start.status, 302);
  assert.ok(start.location.startsWith(`${entraBase}/${TENANT}/oauth2/v2.0/authorize`), start.location);
  const at = new URL(start.location).searchParams;
  assert.equal(at.get("client_id"), CLIENT);
  assert.equal(at.get("redirect_uri"), `${base}/login/entra/callback`);
  assert.equal(at.get("code_challenge_method"), "S256");
  assert.ok(at.get("nonce"));
  const fromEntra = await go(start.location);
  return go(fromEntra.location);
}
const OWNER = { oid: "oid-owner", name: "Owner", preferred_username: "Owner@Example.com" };
const ANNA = { oid: "oid-anna", name: "Anna", email: "anna@example.com", preferred_username: "anna.x@example.com" };

test("the login page offers Microsoft only: no password, no invite links", async () => {
  const go = browser();
  const page = await go("/login");
  assert.match(page.text, /Sign in with Microsoft/);
  assert.doesNotMatch(page.text, /type="password"/);
  const pw = await go("/login", { form: { email: "", password: "ignored with entra" } });
  assert.equal(pw.status, 401);
  assert.equal((await go("/invite/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).status, 404);
  assert.equal((await go("/api/projects")).status, 401);
});

test("the owner from SCENE_LOOP_ENTRA_OWNERS signs in with Microsoft; the UPN matches the email", async () => {
  const go = browser();
  const done = await signIn(go, OWNER, "/?project=film");
  assert.equal(done.status, 302);
  assert.equal(done.location, "/?project=film");
  const me = await go("/api/whoami");
  assert.equal(me.json.reviewer, "Owner");
  assert.equal(me.json.owner, true);
  assert.match((await go("/people")).text, /Active/);
});

test("someone not on the list is turned away", async () => {
  const go = browser();
  const r = await signIn(go, { oid: "oid-stranger", name: "S", preferred_username: "stranger@example.com" });
  assert.equal(r.status, 403);
  assert.match(r.text, /not on this scene-loop's list/);
  assert.equal((await go("/api/whoami")).status, 401);
});

test("an owner adds a commenter; their first sign-in binds the account, and another account with the email is refused", async () => {
  const owner = browser();
  await signIn(owner, OWNER);
  const added = await owner("/people", { form: { action: "add", name: "Anna", email: "anna@example.com", role: "commenter", projects: "film" } });
  assert.match(added.text, /signs in with Microsoft/);
  assert.doesNotMatch(added.text, /\/invite\//);

  const anna = browser();
  const r = await signIn(anna, ANNA);
  assert.equal(r.location, "/?project=film");
  const projects = await anna("/api/projects");
  assert.deepEqual(projects.json.projects.map((p) => p.name), ["film"]);
  assert.equal((await anna("/people")).status, 403);

  const imposter = browser();
  const x = await signIn(imposter, { oid: "oid-other", name: "Anna?", email: "anna@example.com" });
  assert.equal(x.status, 403);
});

test("a sign-in finished in another browser, or refused at Entra, does not log in", async () => {
  const a = browser();
  identity = OWNER;
  const start = await a("/login/entra");
  const fromEntra = await a(start.location);
  const b = browser();
  const r = await b(fromEntra.location);
  assert.equal(r.status, 400);
  assert.equal((await b("/api/whoami")).status, 401);

  const c = browser();
  identity = null;
  const s2 = await c("/login/entra");
  const refused = await c((await c(s2.location)).location);
  assert.equal(refused.status, 401);
});

test("ID tokens with a wrong signature, audience, nonce or tenant are refused", async () => {
  try {
    for (const t of [{ key: other.privateKey }, (c) => ({ ...c, aud: "someone-else" }), (c) => ({ ...c, nonce: "x" }), (c) => ({ ...c, tid: "99999999-2222-3333-4444-555555555555" }), (c) => ({ ...c, iss: "https://evil.example/v2.0" }), (c) => ({ ...c, exp: 1000 })]) {
      tamper = t;
      const go = browser();
      const r = await signIn(go, OWNER);
      assert.equal(r.status, 502, String(t));
      assert.equal((await go("/api/whoami")).status, 401);
    }
  } finally {
    tamper = null;
  }
});

// The OAuth flow a chat runs: register, /authorize, Microsoft, code, token, /mcp.
async function connect(go, who, redirect = CLAUDE) {
  const reg = await go("/register", { json: { redirect_uris: [redirect], client_name: "Claude", token_endpoint_auth_method: "none" } });
  assert.equal(reg.status, 201, reg.text);
  const verifier = b64u(randomBytes(32));
  const params = { response_type: "code", client_id: reg.json.client_id, redirect_uri: redirect, code_challenge: b64u(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", state: "st8", resource: `${base}/mcp` };
  const page = await go(`/authorize?${new URLSearchParams(params)}`);
  assert.match(page.text, /Sign in with Microsoft and allow/);
  identity = who;
  const toEntra = await go("/authorize", { form: { ...params, action: "approve" } });
  assert.equal(toEntra.status, 302);
  assert.ok(toEntra.location.startsWith(entraBase));
  const back = await go((await go(toEntra.location)).location);
  assert.equal(back.status, 302);
  const u = new URL(back.location);
  assert.equal(u.origin + u.pathname, redirect);
  assert.equal(u.searchParams.get("state"), "st8");
  if (!u.searchParams.get("code")) return { error: u.searchParams.get("error") };
  const tok = await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: redirect, client_id: reg.json.client_id, code_verifier: verifier, resource: `${base}/mcp` }) }).then((r) => r.json());
  return tok;
}
const mcpList = (token) => fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

test("OAuth: an owner connects a chat through Microsoft sign-in, and its token works on /mcp", async () => {
  const tok = await connect(browser(), OWNER);
  assert.ok(tok.access_token, JSON.stringify(tok));
  const r = await mcpList(tok.access_token);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /list_projects/);
  assert.equal((await mcpList("nonsense")).status, 401);
});

test("OAuth: a refresh token runs out 30 days after the Microsoft sign-in, however often it is used", async () => {
  const tok = await connect(browser(), OWNER);
  const claims = (t) => JSON.parse(Buffer.from(t.split(".")[0], "base64url"));
  const first = claims(tok.refresh_token);
  assert.ok(first.ea && first.exp <= first.ea + 30 * 86400);
  const again = await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }) }).then((r) => r.json());
  assert.ok(again.access_token);
  assert.equal(claims(again.refresh_token).ea, first.ea);
  assert.ok(claims(again.refresh_token).exp <= first.ea + 30 * 86400);
});

test("OAuth: loopback redirects work (mcp-remote, Claude Code); a commenter can't connect", async () => {
  const local = await connect(browser(), OWNER, "http://127.0.0.1:33418/oauth/callback");
  assert.ok(local.access_token);
  const anna = await connect(browser(), ANNA);
  assert.equal(anna.error, "access_denied");
});

test("OAuth: a redirect URI that is not on SCENE_LOOP_OAUTH_REDIRECTS can't register", async () => {
  const r = await browser()("/register", { json: { redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" } });
  assert.equal(r.status, 400);
});

test("a guest account is never matched by email, so it can't take over a person", async () => {
  const owner = browser();
  await signIn(owner, OWNER);
  await owner("/people", { form: { action: "add", name: "Ben", email: "ben@example.com", role: "commenter", projects: "film" } });
  const guest = browser();
  const r = await signIn(guest, { oid: "oid-guest", name: "Ben?", email: "ben@example.com", idp: "https://sts.windows.net/99999999-0000-0000-0000-000000000000/" });
  assert.equal(r.status, 403);
  const ben = browser();
  const ok = await signIn(ben, { oid: "oid-ben", name: "Ben", preferred_username: "ben@example.com" });
  assert.equal(ok.status, 302);
});

test("a session signed without a Microsoft sign-in (from before Entra) is refused", async () => {
  const p = JSON.parse(readFileSync(join(root, ".people.json"), "utf8")).people.find((x) => x.email === "owner@example.com");
  const key = createHmac("sha256", "test-secret").update("scene-loop:").digest();
  const body = b64u(JSON.stringify({ t: "session", p: p.id, g: p.gen, n: "old-session", exp: Math.floor(Date.now() / 1000) + 3600 }));
  const old = `${body}.${b64u(createHmac("sha256", key).update(body).digest())}`;
  const r = await fetch(`${base}/api/whoami`, { headers: { Cookie: `sl_session=${old}` } });
  assert.equal(r.status, 401);
  const withEa = b64u(JSON.stringify({ t: "session", p: p.id, g: p.gen, n: "new-session", ea: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));
  const good = `${withEa}.${b64u(createHmac("sha256", key).update(withEa).digest())}`;
  assert.equal((await fetch(`${base}/api/whoami`, { headers: { Cookie: `sl_session=${good}` } })).status, 200);
});

test("access tokens carry the Microsoft sign-in time and never run past its 30 days", async () => {
  const tok = await connect(browser(), OWNER);
  const a = JSON.parse(Buffer.from(tok.access_token.split(".")[0], "base64url"));
  assert.ok(a.ea && a.exp <= a.ea + 30 * 86400 && tok.expires_in <= 3600);
});

test("two owners who sign in with Microsoft: either can be made a commenter", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-entra-people-"));
  try {
    const people = createPeople(join(dir, ".people.json"));
    const a = people.add({ name: "A", email: "a@example.com", role: "owner" }).person;
    const b = people.add({ name: "B", email: "b@example.com", role: "owner" }).person;
    people.linkEntra(a.id, { oid: "oa" });
    people.linkEntra(b.id, { oid: "ob" });
    assert.equal(people.update(b.id, { role: "commenter", projects: ["film"] }).role, "commenter");
    assert.throws(() => people.update(a.id, { role: "commenter" }), /nobody who can log in/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
