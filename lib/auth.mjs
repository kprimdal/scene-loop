// Login for when scene-loop is reachable from beyond localhost. Hand-rolled, no dependency.
//
//   People   everyone who may use this server is on the people list (lib/people.mjs). They get
//            in through a one-time invite link that sets a password; owners also set up an
//            authenticator app and give its code at every login. A signed session cookie
//            carries the person's id and their counter on the list, and is checked against
//            the list on every request, so removing someone takes effect at once.
//   Password SCENE_LOOP_PASSWORD, the older shared login: an owner session without a name. It
//            works until the first owner has finished their invite, and then no more.
//   /mcp     a bearer token: SCENE_LOOP_TOKEN (for Claude Code's --header), an owner's own
//            token from the people list (their agents' writes carry the name), or an access
//            token from the OAuth flow a claude.ai custom connector runs.
//   OAuth    the minimum of the MCP authorization spec: Protected Resource Metadata,
//            Authorization Server Metadata, client ID metadata documents and dynamic client
//            registration, /authorize with PKCE (S256) where an owner logs in and approves,
//            /token with authorization_code and refresh_token.
//
// Sessions, client ids, codes and tokens are signed values (payload.HMAC-SHA256). The key comes
// from SCENE_LOOP_SECRET, or else from the people file, so a restart keeps everyone logged in.
// The only memory is a set of used codes and the failed-login counters.
//
// server.mjs calls gate(req, res) first for every request: it answers the auth endpoints
// itself, answers 401/302 for requests without a login, and returns false to let the request
// through with req.user set (who it is, which projects) and req.auth when it carried a login.
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkPassword as checkHash, newTotpSecret, otpauthUrl, passwordProblem, totpStep } from "./people.mjs";

const SESSION_DAYS = 30;
const OWNER_SESSION_DAYS = 7;
const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 30;
const CODE_SECONDS = 120;
const COOKIE = "sl_session";
const SECURE_COOKIE = "__Host-sl_session";
const BOOT = "_pw"; // the session id of a SCENE_LOOP_PASSWORD login

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (s) => createHash("sha256").update(s).digest();
const same = (a, b) => typeof a === "string" && typeof b === "string" && timingSafeEqual(sha256(a), sha256(b));
const now = () => Math.floor(Date.now() / 1000);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (clientId) => b64u(sha256(String(clientId))).slice(0, 22); // keeps codes and tokens small
const isLoopback = (host) => /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\]|::ffff:127\.\d+\.\d+\.\d+)$/.test(host);
const first = (h) => (Array.isArray(h) ? h[0] : h)?.split(",")[0].trim();

export function createAuth({ password, token, secret, publicUrl, host, noLogin, people, trustProxy, reviewer = "The reviewer" }) {
  const loginsOn = () => Boolean(password) || people.loginsOn();
  const tokensOn = () => Boolean(token) || people.list().some((p) => p.tokens?.length);
  if (!loginsOn() && !isLoopback(host) && !noLogin)
    throw new Error(`--host ${host} reaches beyond this machine, so scene-loop needs a login: invite an owner (--invite-owner email Name) or set SCENE_LOOP_PASSWORD. --no-login runs it open anyway.`);
  if (trustProxy && !["cloudflare", "x-forwarded-for"].includes(trustProxy)) throw new Error(`SCENE_LOOP_TRUST_PROXY is "cloudflare" or "x-forwarded-for", not "${trustProxy}"`);
  const generated = !secret && !people.secret();
  const baseSecret = secret || people.secret() || b64u(randomBytes(32));
  // A people file made later keeps this key, so today's sessions survive a restart.
  const secretForNew = secret ? undefined : baseSecret;
  // The password is part of the key, so changing it ends every session and token.
  const key = createHmac("sha256", baseSecret).update(`scene-loop:${password ?? ""}`).digest();

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
    const proto = first(req.headers["x-forwarded-proto"]) || (req.socket.encrypted ? "https" : "http");
    return `${proto}://${first(req.headers["x-forwarded-host"]) || req.headers.host || "localhost"}`;
  };
  // A write must come from a page of this server. The page may be reached under the public
  // URL or another name for the same listener (an SSH tunnel to localhost), so the request's
  // own Host counts too. "null" (a sandboxed frame, a redirect chain) never does.
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    const oh = o.replace(/^\w+:\/\//, "");
    return o !== "null" && [req.headers.host, first(req.headers["x-forwarded-host"]), publicUrl && new URL(publicUrl).host].includes(oh);
  };
  // Who is asking, for the failure counters. Behind cloudflared every request comes from
  // 127.0.0.1, so SCENE_LOOP_TRUST_PROXY names the header that carries the real address.
  const clientIp = (req) => {
    const remote = req.socket.remoteAddress ?? "";
    if (trustProxy && isLoopback(remote)) {
      if (trustProxy === "cloudflare" && req.headers["cf-connecting-ip"]) return first(req.headers["cf-connecting-ip"]);
      if (trustProxy === "x-forwarded-for" && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",").at(-1).trim();
    }
    return remote;
  };

  // ---------- who ----------
  // user: { id, name, email, owner, projects (null: all), gen, boot }. boot is the nameless
  // owner of the open page, SCENE_LOOP_TOKEN or SCENE_LOOP_PASSWORD.
  const BOOT_USER = Object.freeze({ id: null, name: reviewer, email: null, owner: true, projects: null, gen: 0, boot: true });
  const userOf = (p) => ({ id: p.id, name: p.name, email: p.email, owner: p.role === "owner", projects: people.projectsOf(p), gen: p.gen, boot: false });
  const bootOk = () => Boolean(password) && !people.hasActiveOwner();
  // The person a signed value (session, code, OAuth token) names, if it still holds.
  const holder = (pid, gen, { ownerOnly = false } = {}) => {
    if (pid === BOOT) return bootOk() ? BOOT_USER : null;
    const p = people.get(pid);
    if (!p || p.gen !== gen || !p.email || !p.password) return null;
    if (p.role === "owner" && !p.totp) return null;
    if (ownerOnly && p.role !== "owner") return null;
    return userOf(p);
  };
  const cookies = (req) => Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((c) => c[0]).map(([k, ...v]) => [k, v.join("=")]));
  const sessionUser = (req) => {
    const c = cookies(req);
    const s = verify(c[SECURE_COOKIE] ?? c[COOKIE], "session");
    return s ? holder(s.p, s.g) : null;
  };
  const setSession = (req, res, user) => {
    const secure = baseUrl(req).startsWith("https:");
    const days = user.owner ? OWNER_SESSION_DAYS : SESSION_DAYS;
    const value = sign({ t: "session", p: user.boot ? BOOT : user.id, g: user.gen, exp: now() + days * 86400 });
    res.setHeader("Set-Cookie", `${secure ? SECURE_COOKIE : COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure ? "; Secure" : ""}`);
  };
  const bearer = (req) => req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1].trim() ?? null;
  const resourceOf = (req) => `${baseUrl(req)}/mcp`;
  // A bearer token's owner. Only owners have agent access; a commenter's token (left over from
  // before they became one) is refused.
  const tokenUser = (req, t, { oauth = true } = {}) => {
    if (token && same(t, token)) return { kind: "token", user: BOOT_USER, person: null };
    const p = people.byToken(t);
    if (p) return p.role === "owner" ? { kind: "token", user: userOf(p), person: p.name, personId: p.id } : null;
    const a = oauth && verify(t, "access");
    if (!a || ![resourceOf(req), baseUrl(req)].includes(String(a.aud).replace(/\/+$/, ""))) return null;
    const u = holder(a.p, a.g, { ownerOnly: true });
    return u ? { kind: "oauth", client: a.c, user: u, person: u.boot ? null : u.name, personId: u.id } : null;
  };

  // ---------- failed logins ----------
  // Per address: 30 an hour. Per email and address: 5 in 15 minutes. Per account: 20 failures
  // lock it for an hour, the next 20 for two, then four... until an owner unlocks it.
  const windows = new Map(); // key -> { n, until }
  const locks = new Map(); // person id -> { fails, until, times }
  const over = (k, max) => {
    const w = windows.get(k);
    if (w && w.until < Date.now()) { windows.delete(k); return false; }
    return (w?.n ?? 0) >= max;
  };
  const bump = (k, ms) => {
    const old = windows.get(k);
    const w = old && old.until > Date.now() ? old : { n: 0, until: Date.now() + ms };
    w.n++;
    windows.set(k, w);
  };
  setInterval(() => { for (const [k, w] of windows) if (w.until < Date.now()) windows.delete(k); }, 600_000).unref();
  const limited = (req, email) => over(`ip:${clientIp(req)}`, 30) || over(`ai:${email}|${clientIp(req)}`, 5);
  const lockedUntil = (id) => (locks.get(id)?.until > Date.now() ? locks.get(id).until : null);
  const fail = (req, email, p) => {
    bump(`ip:${clientIp(req)}`, 3_600_000);
    bump(`ai:${email}|${clientIp(req)}`, 900_000);
    if (!p) return;
    const l = locks.get(p.id) ?? { fails: 0, until: 0, times: 0 };
    if (++l.fails >= 20) {
      l.times++;
      l.fails = 0;
      l.until = Date.now() + 3_600_000 * 2 ** (l.times - 1);
    }
    locks.set(p.id, l);
  };
  const succeed = (req, email, p) => {
    windows.delete(`ai:${email}|${clientIp(req)}`);
    if (p && locks.has(p.id)) locks.get(p.id).fails = 0;
  };
  const TOO_MANY = "Too many tries. Wait a while and try again.";
  const WRONG_CODE = "That code is wrong or was already used. Wait for the next one.";

  // Email, password and (for an owner) the authenticator code. Without code, an owner who got
  // the first two right comes back as { pending }: the first step of /login.
  async function credentials(req, { email, password: given, code }) {
    email = String(email ?? "").trim().toLowerCase();
    if (limited(req, email)) return { error: TOO_MANY, status: 429 };
    if (!email) {
      if (bootOk() && same(given, password)) return { user: BOOT_USER };
      fail(req, email, null);
      return { error: people.loginsOn() ? "Wrong email or password." : "Wrong password.", status: 401 };
    }
    const p = people.byEmail(email);
    const ok = await checkHash(given, p?.password);
    if (p && lockedUntil(p.id)) return { error: TOO_MANY, status: 429 };
    if (!ok || !p) {
      fail(req, email, p);
      return { error: "Wrong email or password.", status: 401 };
    }
    if (p.role === "owner") {
      if (!p.totp) return { error: "This owner has no authenticator yet: use the invite link.", status: 401 };
      if (code === undefined) return { pending: p };
      if (!people.checkTotp(p, code)) {
        fail(req, email, p);
        return { error: WRONG_CODE, status: 401 };
      }
    }
    succeed(req, email, p);
    return { user: userOf(p) };
  }

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
    // A repeated field (a list of checkboxes) becomes an array.
    const out = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = k in out ? [out[k]].flat().concat(v) : v;
    return out;
  };
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors, ...headers });
    res.end(JSON.stringify(body));
    return true;
  };
  // The login, invite, /people and /account pages: never framed, and no Referer to another
  // site (an invite link is in the URL). Not no-referrer: then a browser sends "Origin: null"
  // with the page's own forms, which sameOrigin refuses.
  const html = (res, code, body, { headers = {}, wide = false } = {}) => {
    res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Referrer-Policy": "same-origin", ...headers });
    res.end(page(body, wide));
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

    // Only an owner connects an agent. A logged-in owner just approves.
    const signedIn = sessionUser(req);
    const owner = signedIn?.owner ? signedIn : null;
    const notOwner = "Your account can watch and comment, but not connect an agent. Ask an owner.";
    let error = signedIn && !owner ? notOwner : "";
    if (post && !error) {
      if (p.action !== "approve") return fail("access_denied", "the user said no");
      let user = owner;
      if (!user) {
        const r = await credentials(req, { email: p.email, password: p.password, code: p.code ?? "" });
        if (r.error) error = r.error;
        else if (!r.user.owner) error = notOwner;
        else { user = r.user; setSession(req, res, user); }
      }
      if (user) {
        const code = sign({ t: "code", c: short(client.id), r: p.redirect_uri, ch: p.code_challenge, res: p.resource || resourceOf(req), sc: p.scope, p: user.boot ? BOOT : user.id, g: user.gen, j: b64u(randomBytes(12)), exp: now() + CODE_SECONDS });
        return redirect(res, back(p.redirect_uri, { code, state: p.state, iss }));
      }
    }
    const hidden = AUTH_PARAMS.filter((k) => p[k] != null).map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join("");
    const where = new URL(p.redirect_uri).host;
    const fields = owner ? "" : people.loginsOn()
      ? `<label>Email<input type="email" name="email" value="${esc(p.email ?? "")}" autofocus autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><label>Authenticator code<input name="code" inputmode="numeric" autocomplete="one-time-code"></label>`
      : `<label>Password<input type="password" name="password" autofocus autocomplete="current-password"></label>`;
    const blocked = signedIn && !owner;
    return html(res, error ? 401 : 200, `
      <h1>Connect ${esc(client.name)}?</h1>
      <p>It asks to use the scene-loop tools at <b>${esc(iss)}</b>${owner && !owner.boot ? ` as <b>${esc(owner.name)}</b>` : ""}: read and write scenes, stills, comments and renders, in every project here. It will send you back to <b>${esc(where)}</b>.</p>
      <form method="post" action="/authorize">${hidden}
        ${blocked ? "" : fields}
        ${error ? `<p class="err">${esc(error)}</p>` : ""}
        ${blocked ? "" : `<div class="row"><button name="action" value="approve">Allow</button><button name="action" value="deny" class="ghost">Cancel</button></div>`}
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
    // Tokens name the person and their counter, so removing them or "log out everywhere"
    // ends them too.
    const issue = (clientId, aud, scope, pid, gen) =>
      json(res, 200, {
        access_token: sign({ t: "access", c: clientId, aud, p: pid, g: gen, exp: now() + ACCESS_SECONDS }),
        token_type: "Bearer",
        expires_in: ACCESS_SECONDS,
        refresh_token: sign({ t: "refresh", c: clientId, aud, sc: scope, p: pid, g: gen, j: b64u(randomBytes(6)), exp: now() + REFRESH_DAYS * 86400 }),
        ...(scope ? { scope } : {}),
      });
    const gone = "the person who approved this no longer has access";

    if (b.grant_type === "authorization_code") {
      const c = verify(b.code, "code");
      if (!c) return oauthError(res, "invalid_grant", "code is invalid or expired");
      if (b.client_id && short(b.client_id) !== c.c) return oauthError(res, "invalid_grant", "code was issued to another client");
      if (b.redirect_uri !== c.r) return oauthError(res, "invalid_grant", "redirect_uri does not match");
      if (typeof b.code_verifier !== "string" || b64u(sha256(b.code_verifier)) !== c.ch) return oauthError(res, "invalid_grant", "PKCE check failed");
      if (b.resource && b.resource.replace(/\/+$/, "") !== c.res.replace(/\/+$/, "")) return oauthError(res, "invalid_target", "resource does not match the authorization");
      if (!holder(c.p, c.g, { ownerOnly: true })) return oauthError(res, "invalid_grant", gone);
      if (!useCode(c.j, c.exp)) return oauthError(res, "invalid_grant", "code was already used");
      return issue(c.c, c.res, c.sc, c.p, c.g);
    }
    if (b.grant_type === "refresh_token") {
      const r = verify(b.refresh_token, "refresh");
      if (!r || (b.client_id && short(b.client_id) !== r.c)) return oauthError(res, "invalid_grant", "refresh_token is invalid or expired");
      if (!holder(r.p, r.g, { ownerOnly: true })) return oauthError(res, "invalid_grant", gone);
      return issue(r.c, r.aud, r.sc, r.p, r.g);
    }
    return oauthError(res, "unsupported_grant_type", "authorization_code or refresh_token");
  }
  const usedCodes = new Map(); // jti -> exp
  const useCode = (jti, exp) => {
    for (const [k, e] of usedCodes) if (e < now()) usedCodes.delete(k);
    if (usedCodes.has(jti)) return false;
    usedCodes.set(jti, exp);
    return true;
  };

  // ---------- /login ----------
  // Email and password; an owner then gives the authenticator code on a second form, which
  // carries a five-minute signed note of who got past the first.
  const safeNext = (n) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/");
  async function login(req, res) {
    if (req.method === "GET") {
      const next = new URL(req.url, "http://x").searchParams.get("next");
      if (sessionUser(req)) return redirect(res, safeNext(next));
      return html(res, 200, loginForm(next));
    }
    const b = await parseBody(req);
    if (b.step === "code") {
      const m = verify(b.mfa, "mfa");
      const p = m && people.get(m.p);
      if (!p || p.gen !== m.g) return html(res, 401, loginForm(b.next, "That took too long. Start again."));
      if (limited(req, p.email) || lockedUntil(p.id)) return html(res, 429, codeForm(b.next, b.mfa, TOO_MANY));
      if (!people.checkTotp(p, b.code)) {
        fail(req, p.email, p);
        return html(res, 401, codeForm(b.next, b.mfa, WRONG_CODE));
      }
      succeed(req, p.email, p);
      return finish(req, res, userOf(p), b.next);
    }
    const r = await credentials(req, { email: b.email, password: b.password });
    if (r.error) return html(res, r.status, loginForm(b.next, r.error, b.email));
    if (r.pending) return html(res, 200, codeForm(b.next, sign({ t: "mfa", p: r.pending.id, g: r.pending.gen, exp: now() + 300 })));
    return finish(req, res, r.user, b.next);
  }
  // A commenter on one project lands on it.
  function finish(req, res, user, next) {
    setSession(req, res, user);
    if (!user.boot) people.noteLogin(user.id);
    const home = user.projects?.size === 1 ? `/?project=${encodeURIComponent([...user.projects][0])}` : "/";
    return redirect(res, safeNext(next) !== "/" ? safeNext(next) : home);
  }
  const loginForm = (next, error, email = "") => {
    const named = people.loginsOn();
    return `
    <h1>scene-loop</h1>
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(safeNext(next))}">
      ${named ? `<label>Email<input type="email" name="email" value="${esc(email)}" ${email ? "" : "autofocus"} autocomplete="username"></label>` : ""}
      <label>Password<input type="password" name="password" ${!named || email ? "autofocus" : ""} autocomplete="current-password"></label>
      ${named && bootOk() ? `<p class="small">Until the first owner has finished their invite, the server password works with the email left empty.</p>` : ""}
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <div class="row"><button>Log in</button></div>
    </form>
    ${named ? `<p class="small">Forgot your password? Ask whoever invited you for a new link.</p>` : ""}`;
  };
  const codeForm = (next, mfa, error) => `
    <h1>scene-loop</h1>
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${esc(safeNext(next))}"><input type="hidden" name="step" value="code"><input type="hidden" name="mfa" value="${esc(mfa)}">
      <label>Code from your authenticator app<input name="code" inputmode="numeric" autocomplete="one-time-code" autofocus></label>
      ${error ? `<p class="err">${esc(error)}</p>` : ""}
      <div class="row"><button>Log in</button></div>
    </form>`;

  // ---------- /invite/<token> ----------
  // Sets the password (and an owner's authenticator) and logs the person in. The TOTP secret
  // travels in a signed field between the form and its answer, and is saved only with a code
  // that shows the app has it.
  async function invite(req, res, raw) {
    if (limited(req, "")) return html(res, 429, `<h1>scene-loop</h1><p class="err">${TOO_MANY}</p>`);
    const p = people.byInvite(raw);
    if (!p) {
      fail(req, "", null);
      return html(res, 404, `<h1>This link doesn't work</h1><p>It has been used, or it ran out after seven days. Ask whoever sent it for a new one.</p>`);
    }
    let setup = null, error = "";
    if (req.method === "POST") {
      const b = await parseBody(req);
      error = passwordProblem(b.password, b.again) ?? "";
      if (p.role === "owner") {
        setup = verify(b.setup, "totp");
        if (!setup || setup.p !== p.id) { setup = null; error ||= "That took too long. Add the new key below to the app."; }
        else if (!error && totpStep(setup.s, b.code) === null) { fail(req, p.email, p); error = "That code doesn't match. Check the key in the app and use the newest code."; }
      }
      if (!error) {
        try {
          return finish(req, res, userOf(await people.acceptInvite(raw, b.password, setup?.s)), "/");
        } catch (e) {
          error = e.message;
        }
      }
    }
    const secret = setup?.s ?? newTotpSecret();
    const signed = sign({ t: "totp", s: secret, p: p.id, exp: now() + 1800 });
    return html(res, error ? 400 : 200, `
      <h1>Welcome, ${esc(p.name)}</h1>
      <p>You log in to scene-loop with <b>${esc(p.email)}</b>. Choose a password; this link then stops working.</p>
      <form method="post">
        <label>Password (12 characters or more)<input type="password" name="password" autocomplete="new-password" minlength="12" autofocus></label>
        <label>The same again<input type="password" name="again" autocomplete="new-password" minlength="12"></label>
        ${p.role === "owner" ? `
        <input type="hidden" name="setup" value="${esc(signed)}">
        <p>As an owner you also give a code from an authenticator app every time you log in. Add this key to the app (1Password, Google Authenticator, Apple Passwords and the like), or <a href="${esc(otpauthUrl(secret, p.email))}">open it in the app</a> on this device:</p>
        <p class="key" id="totpKey">${esc(secret.match(/.{1,4}/g).join(" "))}</p>
        <label>The code the app shows<input name="code" inputmode="numeric" autocomplete="one-time-code"></label>` : ""}
        ${error ? `<p class="err">${esc(error)}</p>` : ""}
        <div class="row"><button>Set password and log in</button></div>
      </form>`);
  }

  const logout = (req, res) => {
    res.setHeader("Set-Cookie", [`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, `${SECURE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`]);
    return redirect(res, "/login");
  };

  // ---------- the gate ----------
  const PUBLIC = new Set(["/login", "/logout", "/authorize", "/token", "/register"]);
  // Agents and OAuth clients post here without a browser's Origin rules; a bearer token is
  // what counts.
  const CROSS_OK = (path) => path.startsWith("/.well-known/") || ["/token", "/register", "/mcp"].includes(path);
  async function gate(req, res) {
    const path = new URL(req.url, "http://x").pathname;
    // A form or fetch from another site must not count, whatever cookie it carries. This holds
    // with --no-login too, where any page the owner visits could otherwise post here.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !CROSS_OK(path) && !sameOrigin(req)) return json(res, 403, { error: "cross-site request refused" });
    if (!loginsOn()) {
      // No login: the page is open (localhost, or --no-login on a private network). With a
      // token set, /mcp still wants one, so an agent needs more than the URL.
      if (tokensOn() && path === "/mcp") {
        if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return true; }
        const t = bearer(req);
        const who = t && tokenUser(req, t, { oauth: false });
        if (!who) return challenge(req, res, t ? "the token is invalid" : undefined);
        req.auth = who;
        req.user = who.user;
        return false;
      }
      // Open mode is for localhost. A proxy in front means someone else can reach it.
      if (!noLogin && !tokensOn() && ["x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip"].some((h) => req.headers[h])) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("scene-loop is reached through a proxy but has no login. Invite an owner (--invite-owner), or start it with --no-login if that is on purpose.\n");
        return true;
      }
      if (path === "/login" || path === "/logout") return redirect(res, "/");
      req.user = BOOT_USER;
      return false;
    }
    if (req.method === "OPTIONS" && (path.startsWith("/.well-known/") || PUBLIC.has(path) || path === "/mcp")) {
      res.writeHead(204, cors);
      res.end();
      return true;
    }
    if (req.method === "GET" && /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/.test(path)) return json(res, 200, resourceMetadata(req));
    if (req.method === "GET" && /^\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/mcp)?$/.test(path)) return json(res, 200, serverMetadata(req));
    try {
      if (path === "/login" && ["GET", "POST"].includes(req.method)) return await login(req, res);
      if (path === "/logout") return logout(req, res);
      const inv = path.match(/^\/invite\/([\w-]{20,})$/);
      if (inv && ["GET", "POST"].includes(req.method)) return await invite(req, res, inv[1]);
      if (path === "/register" && req.method === "POST") return await register(req, res);
      if (path === "/authorize" && ["GET", "POST"].includes(req.method)) return await authorize(req, res);
      if (path === "/token" && req.method === "POST") return await tokenEndpoint(req, res);
    } catch (e) {
      return json(res, 400, { error: "invalid_request", error_description: e.message });
    }

    const t = bearer(req);
    if (t) {
      const who = tokenUser(req, t);
      if (!who) return challenge(req, res, "the token is invalid or expired");
      req.auth = who;
      req.user = who.user;
      return false;
    }
    const user = path !== "/mcp" && sessionUser(req);
    if (user) {
      req.auth = { kind: "session", user, person: user.boot ? null : user.name, personId: user.id };
      req.user = user;
      return false;
    }
    if (path === "/mcp") return challenge(req, res);
    if (req.method === "GET" && (path === "/" || (req.headers.accept ?? "").includes("text/html"))) return redirect(res, `/login?next=${encodeURIComponent(req.url)}`);
    return json(res, 401, { error: "log in first" });
  }

  return { enabled: loginsOn, generated, secretForNew, gate, baseUrl, html, parseBody, setSession, userOf, lockedUntil, unlock: (id) => locks.delete(id) };
}

const page = (body, wide) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>scene-loop</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f3f0;color:#16171a;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{background:#fff;border:1px solid #e2e0db;border-radius:10px;padding:28px 32px;width:min(420px,90vw);box-sizing:border-box}
main.wide{width:min(1100px,94vw);margin:32px 0;align-self:start}
h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:28px 0 8px}p{color:#3d3f44}label{display:grid;gap:6px;margin:16px 0;font-weight:600}
input,select{font:inherit;padding:9px 11px;border:1px solid #e2e0db;border-radius:8px}input[type=checkbox]{padding:0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.row label{margin:0}
button{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:0;background:#2456b8;color:#fff;cursor:pointer}
button.ghost{background:transparent;color:#16171a;border:1px solid #e2e0db}button.danger{background:transparent;color:#b42318;border:1px solid #f0c8c3}button.small{padding:5px 10px;font-size:13px}
.err{color:#c2410c}.small{font-size:13px;color:#6b6d72}.key{font:600 17px ui-monospace,Menlo,monospace;letter-spacing:.04em;background:#f4f3f0;padding:10px 12px;border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;padding:10px 8px;border-top:1px solid #eceae5}th{font-size:12px;color:#6b6d72;font-weight:600;border-top:0}
td form{margin:0 0 6px}.chk{display:inline-flex;gap:5px;align-items:center;margin:0 12px 4px 0;font-weight:400}
.copy{width:100%;box-sizing:border-box;font:13px ui-monospace,Menlo,monospace;background:#f8f7f4}
.notice{background:#eef4ff;border:1px solid #cdddfb;border-radius:8px;padding:12px 14px;margin:12px 0}.notice p{margin:4px 0}
nav.top{display:flex;gap:16px;margin:0 0 14px;font-size:14px}nav.top a{color:#2456b8;text-decoration:none}
</style></head><body><main${wide ? ' class="wide"' : ""}>${body}</main></body></html>`;
