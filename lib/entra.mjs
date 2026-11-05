// Sign-in with Microsoft Entra ID (OpenID Connect), for a scene-loop run inside an organisation
// that has Entra. Optional: on when SCENE_LOOP_ENTRA_TENANT, _CLIENT_ID and _CLIENT_SECRET are set.
// No dependency: discovery, the code exchange and the RS256 check on the ID token use node:crypto
// and fetch.
//
// Entra only says who someone is. Whether they may come in, and as what, is still the people
// list (lib/people.mjs): a person is matched by email on their first sign-in and bound to their
// Entra object id (oid) from then on. lib/auth.mjs runs the flow; this module talks to Entra.
//
// The flow is the authorization code flow of a confidential client (the client secret) with
// PKCE on top. The PKCE verifier and the OIDC nonce both come from a random value that lives
// only in a short cookie in the browser that started the sign-in, so a code or a state that
// leaks from the URL is no use in another browser.
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const SKEW = 300; // seconds of clock drift allowed on exp and nbf

export function entraSettings(env = process.env) {
  const tenant = env.SCENE_LOOP_ENTRA_TENANT?.trim();
  const clientId = env.SCENE_LOOP_ENTRA_CLIENT_ID?.trim();
  const clientSecret = env.SCENE_LOOP_ENTRA_CLIENT_SECRET;
  const set = [tenant, clientId, clientSecret].filter(Boolean).length;
  if (!set) return null;
  if (set < 3) throw new Error("Entra sign-in needs all three of SCENE_LOOP_ENTRA_TENANT, SCENE_LOOP_ENTRA_CLIENT_ID and SCENE_LOOP_ENTRA_CLIENT_SECRET.");
  if (["common", "organizations", "consumers"].includes(tenant.toLowerCase()))
    throw new Error(`SCENE_LOOP_ENTRA_TENANT is your organisation's tenant id, not "${tenant}": scene-loop signs in one organisation's people.`);
  return { tenant, clientId, clientSecret, authority: (env.SCENE_LOOP_ENTRA_AUTHORITY || "https://login.microsoftonline.com").replace(/\/+$/, "") };
}

export function createEntra({ tenant, clientId, clientSecret, authority = "https://login.microsoftonline.com", fetchImpl = fetch }) {
  const discoveryUrl = `${authority}/${tenant}/v2.0/.well-known/openid-configuration`;
  let config = null, configAt = 0;
  let keys = new Map(), keysAt = 0;

  async function getJson(url, init) {
    const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(`Entra answered ${r.status}${body.error ? `: ${body.error}` : ""}`);
      e.entra = body; // error and error_description, for the log
      throw e;
    }
    return body;
  }
  async function discovery() {
    if (config && Date.now() - configAt < 86_400_000) return config;
    const c = await getJson(discoveryUrl);
    for (const k of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"]) if (typeof c[k] !== "string") throw new Error(`Entra discovery has no ${k}`);
    config = c;
    configAt = Date.now();
    return c;
  }
  // The signing keys, fetched again when a token names a key we don't have (Entra rolls them),
  // at most once a minute.
  async function key(kid) {
    if (!keys.has(kid) && Date.now() - keysAt > 60_000) {
      const { jwks_uri } = await discovery();
      const { keys: list } = await getJson(jwks_uri);
      keys = new Map((list ?? []).filter((k) => k.kty === "RSA" && k.kid).map((k) => [k.kid, createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e }, format: "jwk" })]));
      keysAt = Date.now();
    }
    const k = keys.get(kid);
    if (!k) throw new Error("the ID token is signed with a key Entra does not list");
    return k;
  }

  // The PKCE verifier and the nonce, both from the browser's random value.
  const verifierOf = (browserNonce) => b64u(createHash("sha256").update(`pkce:${browserNonce}`).digest());
  const nonceOf = (browserNonce) => b64u(createHash("sha256").update(`nonce:${browserNonce}`).digest()).slice(0, 32);

  async function authorizeUrl({ redirectUri, state, browserNonce, loginHint }) {
    const { authorization_endpoint } = await discovery();
    const u = new URL(authorization_endpoint);
    u.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: "openid profile email",
      state,
      nonce: nonceOf(browserNonce),
      code_challenge: b64u(createHash("sha256").update(verifierOf(browserNonce)).digest()),
      code_challenge_method: "S256",
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
    return u.toString();
  }

  // The code from Entra's redirect, for who signed in: { oid, tid, name, emails }. emails holds the
  // email and preferred_username claims (the UPN), lower case, as candidates for the people list.
  async function redeem({ code, redirectUri, browserNonce }) {
    const { token_endpoint } = await discovery();
    const body = await getJson(token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code: String(code ?? ""), redirect_uri: redirectUri, code_verifier: verifierOf(browserNonce), scope: "openid profile email" }),
    });
    if (typeof body.id_token !== "string") throw new Error("Entra sent no ID token");
    return checkIdToken(body.id_token, nonceOf(browserNonce));
  }

  async function checkIdToken(jwt, nonce) {
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s) throw new Error("the ID token is not a JWT");
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(h, "base64url"));
      claims = JSON.parse(Buffer.from(p, "base64url"));
    } catch {
      throw new Error("the ID token does not parse");
    }
    if (header.alg !== "RS256") throw new Error(`the ID token is signed with ${header.alg}, not RS256`);
    if (!verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), await key(header.kid), Buffer.from(s, "base64url"))) throw new Error("the ID token's signature is wrong");
    const { issuer } = await discovery();
    // Pinned to our app registration, in our tenant, for this sign-in.
    if (claims.iss !== issuer) throw new Error("the ID token is from another issuer");
    if ([claims.aud].flat().indexOf(clientId) < 0) throw new Error("the ID token is for another app");
    if (!(claims.exp > now() - SKEW)) throw new Error("the ID token has run out");
    if (claims.nbf && claims.nbf > now() + SKEW) throw new Error("the ID token is not valid yet");
    if (claims.nonce !== nonce) throw new Error("the ID token belongs to another sign-in");
    if (/^[0-9a-f-]{36}$/i.test(tenant) && claims.tid?.toLowerCase() !== tenant.toLowerCase()) throw new Error("the ID token is from another tenant");
    if (typeof claims.oid !== "string" || !claims.oid) throw new Error("the ID token has no oid");
    const emails = [...new Set([claims.email, claims.preferred_username].filter((e) => typeof e === "string" && e.includes("@")).map((e) => e.trim().toLowerCase()))];
    // A guest (B2B) account carries idp: the tenant or provider that really signed it in. Its email
    // claims come from there and prove nothing about the mailbox, so a guest never binds by email.
    const tid = String(claims.tid ?? "").toLowerCase();
    const guest = typeof claims.idp === "string" && !(tid && claims.idp.toLowerCase().includes(tid));
    return { oid: claims.oid, tid: claims.tid ?? null, name: typeof claims.name === "string" ? claims.name : "", emails, guest };
  }

  return { authorizeUrl, redeem, discovery };
}
