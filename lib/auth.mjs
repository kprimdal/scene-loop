// Login for when scene-loop is reachable from beyond localhost. Hand-rolled, no dependency.
//
//   Web UI   a password, a login page, a signed session cookie.
//   /mcp     a bearer token: either SCENE_LOOP_TOKEN (for Claude Code's --header), or an
//            access token from the OAuth flow a claude.ai custom connector runs.
//   OAuth    the minimum of the MCP authorization spec: Protected Resource Metadata,
//            Authorization Server Metadata, client ID metadata documents and dynamic client
//            registration, /authorize with PKCE (S256) where the user logs in with the same
//            password and approves, /token with authorization_code and refresh_token.
//
// Nothing is stored. Sessions, client ids, codes and tokens are signed values
// (payload.HMAC-SHA256), so a restart with the same secret keeps everyone logged in and a
// new secret or password logs everyone out. The only memory is a set of used codes and a
// failed-login counter.
//
// server.mjs calls gate(req, res) first for every request: it answers the auth endpoints
// itself, answers 401/302 for requests without a login, and returns false to let the
// request through (with req.auth set when it carried one).
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const SESSION_DAYS = 30;
const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 30;
const CODE_SECONDS = 120;
const COOKIE = "sl_session";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (s) => createHash("sha256").update(s).digest();
const same = (a, b) => typeof a === "string" && typeof b === "string" && timingSafeEqual(sha256(a), sha256(b));
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (clientId) => b64u(sha256(String(clientId))).slice(0, 22); // keeps codes and tokens small
const isLoopback = (host) => /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/.test(host);

export function createAuth({ password, token, secret, publicUrl, host, noLogin }) {
  const enabled = Boolean(password || token);
  if (!enabled && !isLoopback(host) && !noLogin)
    throw new Error(`--host ${host} reaches beyond this machine, so scene-loop needs a login: set SCENE_LOOP_PASSWORD (or --password). --no-login runs it open anyway.`);
  const generated = enabled && !secret;
  // The password is part of the key, so changing it ends every session and token.
  const key = createHmac("sha256", secret || randomBytes(32)).update(`scene-loop:${password ?? ""}`).digest();

  const sign = (payload) => {
    const body = b64u(JSON.stringify(payload));
    return `${body}.${b64u(createHmac("sha256", key).update(body).digest())}`;
  };
  const verify = (value, type) => {
    if (typeof value !== "string") return null;
    const [body, mac] = value.split(".");
    if (!body || !mac || !same(mac, b64u(createHmac("sha256", key).update(body).digest()))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url"));
      return p.t === type && (!p.exp || p.exp > now()) ? p : null;
    } catch {
      return null;
    }
  };
  const clientSecret = (clientId) => b64u(createHmac("sha256", key).update(`secret:${clientId}`).digest());

  // The public URL. Behind a proxy, set SCENE_LOOP_URL; otherwise it comes from the
  // forwarded headers or the Host header.
  const baseUrl = (req) => {
    if (publicUrl) return publicUrl.replace(/\/+$/, "");
    const first = (h) => (Array.isArray(h) ? h[0] : h)?.split(",")[0].trim();
    const proto = first(req.headers["x-forwarded-proto"]) || (req.socket.encrypted ? "https" : "http");
    return `${proto}://${first(req.headers["x-forwarded-host"]) || req.headers.host || "localhost"}`;
  };

  // ---------- login state ----------
  const cookies = (req) => Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((c) => c[0]).map(([k, ...v]) => [k, v.join("=")]));
  const setSession = (req, res) => {
    const secure = baseUrl(req).startsWith("https:") ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${sign({ t: "session", exp: now() + SESSION_DAYS * 86400 })}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  };
  const hasSession = (req) => Boolean(verify(cookies(req)[COOKIE], "session"));
  const bearer = (req) => req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1].trim() ?? null;
  const resourceOf = (req) => `${baseUrl(req)}/mcp`;
  const tokenOk = (req, t) => {
    if (token && same(t, token)) return { kind: "token" };
    const a = verify(t, "access");
    return a && [resourceOf(req), baseUrl(req)].includes(a.aud.replace(/\/+$/, "")) ? { kind: "oauth", client: a.c } : null;
  };

  // Failed password attempts per address: 10 per 10 minutes.
  const failures = new Map();
  const throttled = (req) => {
    const ip = req.socket.remoteAddress;
    const f = failures.get(ip);
    if (f && f.until < Date.now()) failures.delete(ip);
    return (failures.get(ip)?.n ?? 0) >= 10;
  };
  const checkPassword = (req, given) => {
    if (same(given, password)) return true;
    const ip = req.socket.remoteAddress;
    const f = failures.get(ip) ?? { n: 0, until: Date.now() + 600_000 };
    f.n++;
    failures.set(ip, f);
    return false;
  };
  const usedCodes = new Map(); // jti -> exp
  const useCode = (jti, exp) => {
    for (const [k, e] of usedCodes) if (e < now()) usedCodes.delete(k);
    if (usedCodes.has(jti)) return false;
    usedCodes.set(jti, exp);
    return true;
  };

  // ---------- http helpers ----------
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let b = "";
      req.on("data", (d) => {
        b += d;
        if (b.length > 65536) reject(new Error("body too large"));
      });
      req.on("end", () => resolve(b));
      req.on("error", reject);
    });
  const parseBody = async (req) => {
    const raw = await readBody(req);
    if ((req.headers["content-type"] ?? "").includes("json")) return raw ? JSON.parse(raw) : {};
    return Object.fromEntries(new URLSearchParams(raw));
  };
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors, ...headers });
    res.end(JSON.stringify(body));
    return true;
  };
  const html = (res, code, body, headers = {}) => {
    res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", ...headers });
    res.end(page(body));
    return true;
  };
  const redirect = (res, to) => {
    res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
    res.end();
    return true;
  };
  const oauthError = (res, error, description, code = 400) => json(res, code, { error, error_description: description });

  // ---------- metadata ----------
  const resourceMetadata = (req) => ({
    resource: resourceOf(req),
    authorization_servers: [baseUrl(req)],
    bearer_methods_supported: ["header"],
    resource_name: "scene-loop",
  });
  const serverMetadata = (req) => {
    const base = baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  };
  const challenge = (req, res, error) => {
    const params = [`resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp"`];
    if (error) params.unshift(`error="invalid_token"`, `error_description="${error}"`);
    return json(res, 401, { error: "unauthorized", error_description: error ?? "Log in first: a bearer token or the OAuth flow." }, { "WWW-Authenticate": `Bearer ${params.join(", ")}` });
  };

  // ---------- clients ----------
  const okRedirect = (u) => {
    try {
      const url = new URL(u);
      return !url.hash && (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)) || !["http:", "https:", "javascript:", "data:", "file:"].includes(url.protocol));
    } catch {
      return false;
    }
  };
  // Client ID metadata documents: the client_id is an https URL to a JSON document.
  const cimdCache = new Map();
  async function fetchClientDocument(clientId) {
    const hit = cimdCache.get(clientId);
    if (hit && hit.until > Date.now()) return hit.doc;
    const url = new URL(clientId);
    if (url.protocol !== "https:" || url.pathname === "/" || url.username || url.password) throw new Error("client_id URL must be https with a path");
    const addrs = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
    if (addrs.some(({ address: a }) => /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|f[cd]|fe80:|::ffff:(127|10|192\.168)\.)/i.test(a)))
      throw new Error("client_id URL points at a private address");
    const r = await fetch(clientId, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`client metadata answered ${r.status}`);
    const text = await r.text();
    if (text.length > 16384) throw new Error("client metadata too large");
    const doc = JSON.parse(text);
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length) throw new Error("client metadata must carry its own URL as client_id and redirect_uris");
    cimdCache.set(clientId, { doc, until: Date.now() + 600_000 });
    return doc;
  }
  async function resolveClient(clientId) {
    if (typeof clientId !== "string" || !clientId) throw new Error("client_id is required");
    if (clientId.startsWith("https://")) {
      const doc = await fetchClientDocument(clientId);
      return { id: clientId, name: doc.client_name || new URL(clientId).host, redirects: doc.redirect_uris };
    }
    const c = verify(clientId, "client");
    if (!c) throw new Error("unknown client_id: register again");
    return { id: clientId, name: c.n || "An MCP client", redirects: c.r };
  }

  async function register(req, res) {
    let b;
    try {
      b = await parseBody(req);
    } catch {
      return oauthError(res, "invalid_client_metadata", "send JSON");
    }
    const redirects = b.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || !redirects.every((u) => typeof u === "string" && okRedirect(u)))
      return oauthError(res, "invalid_redirect_uri", "redirect_uris must be https, or http on localhost");
    const name = typeof b.client_name === "string" ? b.client_name.slice(0, 100) : undefined;
    const client_id = sign({ t: "client", r: redirects, n: name });
    const method = ["client_secret_post", "client_secret_basic"].includes(b.token_endpoint_auth_method) ? b.token_endpoint_auth_method : "none";
    return json(res, 201, {
      client_id,
      client_id_issued_at: now(),
      ...(method !== "none" ? { client_secret: clientSecret(client_id), client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    });
  }

  // ---------- /authorize ----------
  const AUTH_PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"];
  const back = (redirectUri, params) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    return u.toString();
  };

  async function authorize(req, res) {
    const post = req.method === "POST";
    const p = post ? await parseBody(req) : Object.fromEntries(new URL(req.url, "http://x").searchParams);
    let client;
    try {
      client = await resolveClient(p.client_id);
    } catch (e) {
      return html(res, 400, `<h1>Can't connect</h1><p>${esc(e.message)}</p>`);
    }
    if (!client.redirects.includes(p.redirect_uri)) return html(res, 400, `<h1>Can't connect</h1><p>The redirect_uri is not one this client registered.</p>`);
    const iss = baseUrl(req);
    const fail = (error, description) => redirect(res, back(p.redirect_uri, { error, error_description: description, state: p.state, iss }));
    if (p.response_type !== "code") return fail("unsupported_response_type", "only code");
    if (!p.code_challenge || p.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with S256 is required");
    if (p.resource && ![resourceOf(req), baseUrl(req)].includes(p.resource.replace(/\/+$/, ""))) return fail("invalid_target", `resource must be ${resourceOf(req)}`);

    let error = "";
    if (post) {
      if (p.action !== "approve") return fail("access_denied", "the user said no");
      const sessionOk = hasSession(req);
      if (!sessionOk && throttled(req)) error = "Too many wrong passwords. Wait ten minutes.";
      else if (!sessionOk && !checkPassword(req, p.password)) error = "Wrong password.";
      else {
        if (!sessionOk) setSession(req, res);
        const code = sign({ t: "code", c: short(client.id), r: p.redirect_uri, ch: p.code_challenge, res: p.resource || resourceOf(req), sc: p.scope, j: b64u(randomBytes(12)), exp: now() + CODE_SECONDS });
        return redirect(res, back(p.redirect_uri, { code, state: p.state, iss }));
      }
    }
    const hidden = AUTH_PARAMS.filter((k) => p[k] != null).map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join("");
    const where = new URL(p.redirect_uri).host;
    return html(res, error ? 401 : 200, `
      <h1>Connect ${esc(client.name)}?</h1>
      <p>It asks to use the scene-loop tools at <b>${esc(iss)}</b>: read and write scenes, stills, comments and renders, in every project here. It will send you back to <b>${esc(where)}</b>.</p>
      <form method="post" action="/authorize">${hidden}
        ${hasSession(req) ? "" : `<label>Password<input type="password" name="password" autofocus autocomplete="current-password"></label>`}
        ${error ? `<p class="err">${esc(error)}</p>` : ""}
        <div class="row"><button name="action" value="approve">Allow</button><button name="action" value="deny" class="ghost">Cancel</button></div>
      </form>`);
  }

  // ---------- /token ----------
  async function tokenEndpoint(req, res) {
    let b;
    try {
      b = await parseBody(req);
    } catch {
      return oauthError(res, "invalid_request", "send application/x-www-form-urlencoded");
    }
    const basic = req.headers.authorization?.match(/^Basic\s+(.+)$/i)?.[1];
    if (basic) {
      const [id, sec] = Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent);
      b.client_id ??= id;
      b.client_secret ??= sec;
    }
    // Public clients send no secret and rely on PKCE; a secret, when sent, has to be ours.
    if (b.client_secret && !same(b.client_secret, clientSecret(b.client_id ?? ""))) return oauthError(res, "invalid_client", "wrong client_secret", 401);
    const issue = (clientId, aud, scope) =>
      json(res, 200, {
        access_token: sign({ t: "access", c: clientId, aud, exp: now() + ACCESS_SECONDS }),
        token_type: "Bearer",
        expires_in: ACCESS_SECONDS,
        refresh_token: sign({ t: "refresh", c: clientId, aud, sc: scope, j: b64u(randomBytes(6)), exp: now() + REFRESH_DAYS * 86400 }),
        ...(scope ? { scope } : {}),
      });

    if (b.grant_type === "authorization_code") {
      const c = verify(b.code, "code");
      if (!c) return oauthError(res, "invalid_grant", "code is invalid or expired");
      if (b.client_id && short(b.client_id) !== c.c) return oauthError(res, "invalid_grant", "code was issued to another client");
      if (b.redirect_uri !== c.r) return oauthError(res, "invalid_grant", "redirect_uri does not match");
      if (typeof b.code_verifier !== "string" || b64u(sha256(b.code_verifier)) !== c.ch) return oauthError(res, "invalid_grant", "PKCE check failed");
      if (b.resource && b.resource.replace(/\/+$/, "") !== c.res.replace(/\/+$/, "")) return oauthError(res, "invalid_target", "resource does not match the authorization");
      if (!useCode(c.j, c.exp)) return oauthError(res, "invalid_grant", "code was already used");
      return issue(c.c, c.res, c.sc);
    }
    if (b.grant_type === "refresh_token") {
      const r = verify(b.refresh_token, "refresh");
      if (!r || (b.client_id && short(b.client_id) !== r.c)) return oauthError(res, "invalid_grant", "refresh_token is invalid or expired");
      return issue(r.c, r.aud, r.sc);
    }
    return oauthError(res, "unsupported_grant_type", "authorization_code or refresh_token");
  }

  // ---------- /login ----------
  const safeNext = (n) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/");
  async function login(req, res) {
    if (req.method === "GET") return html(res, 200, loginForm(new URL(req.url, "http://x").searchParams.get("next")));
    const b = await parseBody(req);
    if (throttled(req)) return html(res, 429, loginForm(b.next, "Too many wrong passwords. Wait ten minutes."));
    if (!checkPassword(req, b.password)) return html(res, 401, loginForm(b.next, "Wrong password."));
    setSession(req, res);
    return redirect(res, safeNext(b.next));
  }
  const loginForm = (next, error) => `
    <h1>scene-loop</h1>
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(safeNext(next))}">
      <label>Password<input type="password" name="password" autofocus autocomplete="current-password"></label>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <div class="row"><button>Log in</button></div>
    </form>`;

  // ---------- the gate ----------
  const PUBLIC = new Set(["/login", "/logout", "/authorize", "/token", "/register"]);
  async function gate(req, res) {
    const path = new URL(req.url, "http://x").pathname;
    if (!enabled) {
      // Open mode is for localhost. A proxy in front means someone else can reach it.
      if (!noLogin && ["x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip"].some((h) => req.headers[h])) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("scene-loop is reached through a proxy but has no password. Set SCENE_LOOP_PASSWORD, or start it with --no-login if that is on purpose.\n");
        return true;
      }
      return false;
    }
    if (req.method === "OPTIONS" && (path.startsWith("/.well-known/") || PUBLIC.has(path) || path === "/mcp")) {
      res.writeHead(204, cors);
      res.end();
      return true;
    }
    if (req.method === "GET" && /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/.test(path)) return json(res, 200, resourceMetadata(req));
    if (req.method === "GET" && /^\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/mcp)?$/.test(path)) return json(res, 200, serverMetadata(req));
    // A browser form posted from another site must not count, whatever cookie it carries.
    const origin = req.headers.origin;
    const crossSite = origin && origin !== "null" && origin.replace(/^\w+:\/\//, "") !== baseUrl(req).replace(/^\w+:\/\//, "") && !path.startsWith("/.well-known/") && !["/token", "/register", "/mcp"].includes(path);
    if (req.method !== "GET" && req.method !== "HEAD" && crossSite) return json(res, 403, { error: "cross-site request refused" });
    try {
      if (path === "/login") return await login(req, res);
      if (path === "/logout") {
        res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return redirect(res, "/login");
      }
      if (path === "/register" && req.method === "POST") return await register(req, res);
      if (path === "/authorize" && ["GET", "POST"].includes(req.method)) return await authorize(req, res);
      if (path === "/token" && req.method === "POST") return await tokenEndpoint(req, res);
    } catch (e) {
      return json(res, 400, { error: "invalid_request", error_description: e.message });
    }

    const t = bearer(req);
    if (t) {
      const who = tokenOk(req, t);
      if (!who) return challenge(req, res, "the token is invalid or expired");
      req.auth = who;
      return false;
    }
    if (path !== "/mcp" && hasSession(req)) {
      req.auth = { kind: "session" };
      return false;
    }
    if (path === "/mcp") return challenge(req, res);
    if (req.method === "GET" && (path === "/" || (req.headers.accept ?? "").includes("text/html"))) return redirect(res, `/login?next=${encodeURIComponent(req.url)}`);
    return json(res, 401, { error: "log in first" });
  }

  return { enabled, generated, gate, baseUrl };
}

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>scene-loop</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f3f0;color:#16171a;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{background:#fff;border:1px solid #e2e0db;border-radius:10px;padding:28px 32px;width:min(420px,90vw)}
h1{font-size:20px;margin:0 0 12px}p{color:#3d3f44}label{display:grid;gap:6px;margin:16px 0;font-weight:600}
input[type=password]{font:inherit;padding:9px 11px;border:1px solid #e2e0db;border-radius:8px}
.row{display:flex;gap:10px}button{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:0;background:#2456b8;color:#fff;cursor:pointer}
button.ghost{background:transparent;color:#16171a;border:1px solid #e2e0db}.err{color:#c2410c}
</style></head><body><main>${body}</main></body></html>`;
