// The people who may use this scene-loop, in one file next to the projects (<root>/.people.json,
// mode 0600). No database: the file is the truth, read again whenever it changes on disk, so
// `node server.mjs <root> --invite-owner ...` can add someone while the server runs.
//
//   person   { id, name, email, role, access, password, totp, gen, tokens, invite, addedAt }
//   role     "owner": every project, /people, the agent tools and /mcp.
//            "commenter": watches, reads the script and comments, on the projects in access.
//   access   { <project>: "commenter" }, ignored for owners.
//   password scrypt, set by the person through their invite link; null until then.
//   totp     an authenticator-app secret (base32). Owners must have one to log in.
//   gen      bumped to end every session and OAuth token the person has ("log out everywhere").
//   tokens   [{ id, label, hash, createdAt }]: their agents' /mcp bearer tokens, stored as sha256.
//   invite   { hash, exp }: a one-time link that sets the password (and, for owners, the TOTP).
//
// Next to the people: secret (the session key when SCENE_LOOP_SECRET is not set) and revoked
// (session ids that logged out, with their expiry). The file never goes into a video's version
// history (lib/history.mjs) and is never served.
//
// A person without an email has no login: an agent identity that only holds tokens.
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export const ROLES = ["owner", "commenter"];
const INVITE_DAYS = 7;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const NAME = /^[^\u0000-\u001f<>"]{1,60}$/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>".]{2,}$/;

// ---------- passwords ----------
const scryptAsync = (pw, salt) => new Promise((ok, fail) => scrypt(pw, salt, 32, SCRYPT, (e, k) => (e ? fail(e) : ok(k))));
export async function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(await scryptAsync(pw, salt))}`;
}
const DUMMY = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// Checks a password against a stored hash. Without a hash it still does the work, so an unknown
// email takes as long as a wrong password.
export async function checkPassword(pw, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || DUMMY).split("$");
  if (kind !== "scrypt") return false;
  const k = await new Promise((ok, fail) => scrypt(String(pw ?? ""), Buffer.from(salt, "base64url"), 32, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem }, (e, k) => (e ? fail(e) : ok(k))));
  return Boolean(stored) && timingSafeEqual(k, Buffer.from(hash, "base64url"));
}
export const passwordProblem = (pw, again) =>
  typeof pw !== "string" || pw.length < 12 ? "The password needs 12 characters or more." : pw.length > 200 ? "That password is too long." : again !== undefined && pw !== again ? "The two passwords are not the same." : null;

// ---------- TOTP (RFC 6238: SHA-1, 30 s, 6 digits) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? out + B32[(value << (5 - bits)) & 31] : out;
}
export function unbase32(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of String(s).toUpperCase().replace(/[\s=]/g, "")) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32(randomBytes(20));
export function totp(secret, step, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", unbase32(secret)).update(msg).digest();
  const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}
// The step the code belongs to (now, or one step either side for a clock that drifts), or null.
export function totpStep(secret, code, t = Date.now() / 1000) {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(t / 30);
  for (const s of [step, step - 1, step + 1]) if (timingSafeEqual(Buffer.from(totp(secret, s)), Buffer.from(c))) return s;
  return null;
}
export const otpauthUrl = (secret, account, issuer = "scene-loop") =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---------- the store ----------
export function createPeople(file) {
  let data = null, stamp = null;
  const listeners = new Set();
  const usedSteps = new Map(); // person id -> last TOTP step used, so a code works once

  function load() {
    if (!existsSync(file)) {
      if (data) { data = null; stamp = null; listeners.forEach((f) => f()); }
      return;
    }
    // stamp alone misses two writes in one clock tick; a rename (ours) makes a new inode.
    const st = statSync(file);
    const m = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (m === stamp) return;
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(d.people)) throw new Error(`${file} has no people list`);
    data = d;
    stamp = m;
    listeners.forEach((f) => f());
  }
  const read = () => (load(), data);
  // Every change reads the file first, so a write never undoes another process's change.
  function change(fn, secretForNew) {
    load();
    const d = data ?? { version: 1, secret: secretForNew || b64u(randomBytes(32)), people: [] };
    const result = fn(d);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
    data = d;
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    listeners.forEach((f) => f());
    return result;
  }
  const people = () => read()?.people ?? [];
  const find = (d, id) => {
    const p = d.people.find((x) => x.id === id);
    if (!p) throw new Error("No such person.");
    return p;
  };
  const clean = (name, email, d, self) => {
    name = String(name ?? "").trim();
    email = email ? String(email).trim().toLowerCase() : null;
    if (!NAME.test(name)) throw new Error("A name is 1 to 60 characters, without < > or quotes.");
    if (email && !EMAIL.test(email)) throw new Error(`"${email}" is not an email address.`);
    if (d.people.some((p) => p !== self && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already someone called ${name}.`);
    if (email && d.people.some((p) => p !== self && p.email === email)) throw new Error(`${email} is already on the list.`);
    return { name, email };
  };
  const accessOf = (projects) => Object.fromEntries([...new Set([projects ?? []].flat().map(String).filter(Boolean))].map((p) => [p, "commenter"]));
  const newInvite = (p) => {
    const raw = b64u(randomBytes(32));
    p.invite = { hash: sha256hex(raw), exp: now() + INVITE_DAYS * 86400 };
    return raw;
  };

  const api = {
    file,
    exists: () => Boolean(read()),
    secret: () => read()?.secret ?? null,
    list: () => people(),
    get: (id) => people().find((p) => p.id === id) ?? null,
    byEmail: (email) => (email ? people().find((p) => p.email === String(email).trim().toLowerCase()) ?? null : null),
    byName: (name) => people().find((p) => p.name.toLowerCase() === String(name).toLowerCase()) ?? null,
    // Someone can log in here, so the page needs a login whatever --no-login says.
    loginsOn: () => people().some((p) => p.email),
    hasActiveOwner: () => people().some((p) => p.role === "owner" && p.email && p.password && p.totp),
    // null: every project (an owner); otherwise the project names the person may see.
    projectsOf: (p) => (p.role === "owner" ? null : new Set(Object.keys(p.access ?? {}))),
    onChange: (fn) => listeners.add(fn),
    reload: () => { try { load(); } catch (e) { console.error(`${file}: ${e.message}`); } },

    add({ name, email, role = "commenter", projects = [] }, secretForNew) {
      if (!ROLES.includes(role)) throw new Error(`role is one of ${ROLES.join(", ")}`);
      return change((d) => {
        const c = clean(name, email, d);
        if (role !== "owner" && !c.email) throw new Error("A commenter needs an email address to log in with.");
        const p = { id: `p_${randomUUID().slice(0, 8)}`, ...c, role, access: role === "owner" ? {} : accessOf(projects), password: null, totp: null, gen: 1, tokens: [], invite: null, addedAt: new Date().toISOString() };
        const invite = p.email ? newInvite(p) : null;
        d.people.push(p);
        return { person: p, invite };
      }, secretForNew);
    },
    update(id, { name, email, role, projects }) {
      return change((d) => {
        const p = find(d, id);
        const c = clean(name ?? p.name, email === undefined ? p.email : email, d, p);
        Object.assign(p, c);
        if (role !== undefined) {
          if (!ROLES.includes(role)) throw new Error(`role is one of ${ROLES.join(", ")}`);
          if (p.role === "owner" && role !== "owner" && !d.people.some((x) => x !== p && x.role === "owner" && x.password)) throw new Error("That would leave nobody who can log in as an owner.");
          if (role !== p.role) { p.role = role; p.gen++; }
        }
        if (projects !== undefined) {
          const next = accessOf(projects);
          // Taking a project away ends the person's sessions, so open pages close at once.
          if (Object.keys(p.access ?? {}).some((k) => !(k in next))) p.gen++;
          p.access = next;
        }
        return p;
      });
    },
    remove(id) {
      return change((d) => {
        const p = find(d, id);
        if (p.role === "owner" && p.password && !d.people.some((x) => x !== p && x.role === "owner" && x.password)) throw new Error("That is the last owner who can log in.");
        d.people = d.people.filter((x) => x !== p);
        return { ok: true };
      });
    },
    // A new one-time link. It replaces any earlier one; accepting it sets a new password.
    invite: (id) => change((d) => newInvite(find(d, id))),
    byInvite(raw) {
      const h = sha256hex(raw);
      const p = people().find((x) => x.invite && x.invite.exp > now() && timingSafeEqual(Buffer.from(x.invite.hash), Buffer.from(h)));
      return p ?? null;
    },
    async acceptInvite(raw, password, totpSecret) {
      const p0 = api.byInvite(raw);
      if (!p0) throw new Error("This link has been used or has run out. Ask for a new one.");
      const hash = await hashPassword(password);
      return change((d) => {
        const p = find(d, p0.id);
        if (!p.invite || p.invite.hash !== sha256hex(raw)) throw new Error("This link has been used or has run out. Ask for a new one.");
        p.password = hash;
        if (p.role === "owner") {
          if (!totpSecret) throw new Error("An owner needs an authenticator code.");
          p.totp = totpSecret;
        }
        p.invite = null;
        p.gen++;
        return p;
      });
    },
    async setPassword(id, password) {
      const hash = await hashPassword(password);
      return change((d) => { const p = find(d, id); p.password = hash; p.gen++; return p; });
    },
    logOutEverywhere: (id) => change((d) => { find(d, id).gen++; return { ok: true }; }),
    // A TOTP code for this person, once per step.
    checkTotp(p, code) {
      if (!p?.totp) return false;
      const s = totpStep(p.totp, code);
      if (s === null || (usedSteps.get(p.id) ?? -1) >= s) return false;
      usedSteps.set(p.id, s);
      return true;
    },
    // Sessions ended by logging out, until they would have run out anyway.
    isRevoked: (n) => Boolean(read()?.revoked?.[n]),
    revokeSession: (n, exp, secretForNew) =>
      change((d) => {
        d.revoked = Object.fromEntries(Object.entries(d.revoked ?? {}).filter(([, e]) => e > now()));
        d.revoked[n] = exp;
      }, secretForNew),
    noteLogin: (id) => change((d) => { find(d, id).lastLogin = new Date().toISOString(); }),

    addToken(id, label) {
      const raw = `sl_${b64u(randomBytes(24))}`;
      change((d) => {
        const p = find(d, id);
        p.tokens.push({ id: `t_${randomUUID().slice(0, 8)}`, label: String(label || "agent").slice(0, 60), hash: sha256hex(raw), createdAt: new Date().toISOString() });
      });
      return raw;
    },
    removeToken: (id, tid) => change((d) => { const p = find(d, id); p.tokens = p.tokens.filter((t) => t.id !== tid); return { ok: true }; }),
    // The person a bearer token belongs to, or null.
    byToken(raw) {
      const h = Buffer.from(sha256hex(raw));
      for (const p of people()) for (const t of p.tokens ?? []) if (timingSafeEqual(Buffer.from(t.hash), h)) return p;
      return null;
    },

    // One-time move from the old settings, when there is no people file yet:
    //   SCENE_LOOP_TOKENS          Name=token   -> an owner holding that token
    //   SCENE_LOOP_SHARE_PEOPLE    email=Name   -> a commenter on SCENE_LOOP_SHARE_PROJECTS
    // The same name in both is one person: the owner, with the email. Nobody gets a password;
    // each logs in once an owner sends them an invite link from /people.
    importLegacy({ tokens, sharePeople, shareProjects }, secretForNew) {
      const list = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      const byName = new Map();
      const get = (name) => {
        const k = name.toLowerCase();
        if (!byName.has(k)) byName.set(k, { name, email: null, role: "commenter", tokens: [] });
        return byName.get(k);
      };
      for (const pair of list(tokens)) {
        const i = pair.indexOf("=");
        const name = pair.slice(0, i).trim(), t = pair.slice(i + 1).trim();
        if (i < 1 || t.length < 16) throw new Error(`SCENE_LOOP_TOKENS: "${pair.slice(0, 20)}…" is not Name=token (16 characters or more)`);
        const p = get(name);
        p.role = "owner";
        p.tokens.push(t);
      }
      for (const pair of list(sharePeople)) {
        const [email, name] = pair.split("=").map((x) => x?.trim());
        if (!email?.includes("@") || !name) throw new Error(`SCENE_LOOP_SHARE_PEOPLE: "${pair}" is not email=Name`);
        get(name).email = email.toLowerCase();
      }
      const projects = list(shareProjects);
      return change((d) => {
        for (const x of byName.values()) {
          const c = clean(x.name, x.email, d);
          d.people.push({
            id: `p_${randomUUID().slice(0, 8)}`, ...c, role: x.role, access: x.role === "owner" ? {} : accessOf(projects),
            password: null, totp: null, gen: 1, invite: null, addedAt: new Date().toISOString(), importedFrom: "env",
            tokens: x.tokens.map((t, i) => ({ id: `t_${randomUUID().slice(0, 8)}`, label: i ? `imported ${i + 1}` : "imported", hash: sha256hex(t), createdAt: new Date().toISOString() })),
          });
        }
        return d.people.map(({ name, email, role, tokens }) => ({ name, email, role, tokens: tokens.length }));
      }, secretForNew);
    },
  };
  return api;
}
