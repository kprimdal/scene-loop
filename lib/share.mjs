// Sharing a project with people outside the private network, behind Cloudflare Access.
//
// The server opens a second listener on loopback (SCENE_LOOP_SHARE_PORT) for a Cloudflare
// Tunnel to point at. Cloudflare Access logs people in (an email one-time PIN) and signs every
// request with a JWT; this module checks that JWT against the team's keys and turns its email
// into a reviewer name. Everything on that listener is limited to the shared projects and to
// watching and commenting: no /mcp, no agent tools, no renders, restores or deletes. The
// restriction comes from the socket the request arrived on, never from a header.
//
//   SCENE_LOOP_SHARE_PORT      4302
//   SCENE_LOOP_SHARE_PROJECTS  project names, comma-separated
//   SCENE_LOOP_SHARE_PEOPLE    email=Name pairs, comma-separated; nobody else gets in
//   SCENE_LOOP_ACCESS_TEAM     the Zero Trust team name (<team>.cloudflareaccess.com)
//   SCENE_LOOP_ACCESS_AUD      the Access application's audience tag
import { createPublicKey, verify as verifySignature } from "node:crypto";

const list = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const json64 = (s) => JSON.parse(Buffer.from(s, "base64url"));

export function createShare({ port, projects, people, team, aud, certsUrl }) {
  const allowed = new Set(list(projects));
  const names = new Map(
    list(people).map((pair) => {
      const [email, name] = pair.split("=").map((x) => x?.trim());
      if (!email?.includes("@") || !name) throw new Error(`SCENE_LOOP_SHARE_PEOPLE: "${pair}" is not email=Name`);
      return [email.toLowerCase(), name];
    }),
  );
  if (!allowed.size) throw new Error("SCENE_LOOP_SHARE_PORT is set but SCENE_LOOP_SHARE_PROJECTS names no project.");
  if (!names.size) throw new Error("SCENE_LOOP_SHARE_PORT is set but SCENE_LOOP_SHARE_PEOPLE lets nobody in.");
  if (!team || !aud) throw new Error("SCENE_LOOP_SHARE_PORT needs SCENE_LOOP_ACCESS_TEAM and SCENE_LOOP_ACCESS_AUD: the share listener only takes requests Cloudflare Access has signed.");
  const issuer = `https://${team}.cloudflareaccess.com`;
  certsUrl ??= `${issuer}/cdn-cgi/access/certs`;

  // Access rotates its signing keys; an unknown kid fetches them again, at most once a minute.
  let keys = new Map();
  let fetchedAt = 0;
  async function keyFor(kid) {
    if (!keys.has(kid) && Date.now() - fetchedAt > 60_000) {
      fetchedAt = Date.now();
      const r = await fetch(certsUrl, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`Access certs answered ${r.status}`);
      keys = new Map((await r.json()).keys.map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })]));
    }
    return keys.get(kid);
  }

  async function claims(jwt) {
    const [h, p, sig] = String(jwt ?? "").split(".");
    if (!h || !p || !sig) return null;
    try {
      const header = json64(h);
      if (header.alg !== "RS256") return null;
      const key = await keyFor(header.kid);
      if (!key || !verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig, "base64url"))) return null;
      const c = json64(p);
      const now = Date.now() / 1000;
      if (c.iss !== issuer || ![c.aud].flat().includes(aud) || !(c.exp > now) || (c.nbf && c.nbf > now + 60)) return null;
      return c;
    } catch {
      return null;
    }
  }

  // The person a request comes from, or null. The JWT arrives as a header from the tunnel.
  async function who(req) {
    const c = await claims(req.headers["cf-access-jwt-assertion"]);
    const email = typeof c?.email === "string" ? c.email.toLowerCase() : null;
    return email && names.has(email) ? { email, name: names.get(email) } : null;
  }

  return { port, projects: allowed, allows: (project) => allowed.has(project), who };
}
