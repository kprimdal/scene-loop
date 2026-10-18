// The people file: passwords, authenticator codes, invites, tokens, the rules that keep an
// owner able to log in, and the one-time move from the older env settings. No server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { base32, unbase32, totp, totpStep, hashPassword, checkPassword, passwordProblem, createPeople } from "../lib/people.mjs";

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-people-"));
  return { file: join(dir, ".people.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("TOTP matches RFC 6238 and allows one step of drift", () => {
  const secret = base32(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(unbase32(secret).toString(), "12345678901234567890");
  // RFC 6238 appendix B, SHA-1, the last six of the eight digits
  assert.equal(totp(secret, 1), "287082");
  assert.equal(totp(secret, Math.floor(1111111109 / 30)), "081804");
  assert.equal(totp(secret, Math.floor(1234567890 / 30)), "005924");
  const t = 1234567890, step = Math.floor(t / 30);
  assert.equal(totpStep(secret, "005924", t), step);
  assert.equal(totpStep(secret, totp(secret, step - 1), t), step - 1);
  assert.equal(totpStep(secret, totp(secret, step + 1), t), step + 1);
  assert.equal(totpStep(secret, totp(secret, step + 2), t), null);
  assert.equal(totpStep(secret, "12345", t), null);
  assert.equal(totpStep(secret, "abcdef", t), null);
});

test("passwords are scrypt hashes; an unknown person still costs the same work", async () => {
  const h = await hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await checkPassword("correct horse battery", h), true);
  assert.equal(await checkPassword("wrong", h), false);
  assert.equal(await checkPassword("anything", null), false);
  assert.match(passwordProblem("short"), /12 characters/);
  assert.match(passwordProblem("long enough pw", "other one pw"), /not the same/);
  assert.equal(passwordProblem("long enough pw", "long enough pw"), null);
});

test("people: add, invite once, tokens, and the last owner stays", async () => {
  const { file, done } = scratch();
  try {
    const people = createPeople(file);
    assert.equal(people.exists(), false);
    assert.equal(people.loginsOn(), false);
    const { person: owner, invite } = people.add({ name: "Owner", email: "Owner@Example.com", role: "owner" });
    assert.equal(owner.email, "owner@example.com");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(people.secret());
    assert.equal(people.loginsOn(), true);
    assert.equal(people.hasActiveOwner(), false);
    assert.equal(people.byInvite(invite).id, owner.id);
    assert.equal(people.byInvite("x".repeat(43)), null);
    await assert.rejects(people.acceptInvite(invite, "long enough password"), /authenticator/);
    const secret = base32(Buffer.alloc(20, 7));
    await people.acceptInvite(invite, "long enough password", secret);
    assert.equal(people.hasActiveOwner(), true);
    assert.equal(people.byInvite(invite), null, "an invite works once");
    await assert.rejects(people.acceptInvite(invite, "long enough password", secret), /used/);

    const { person: anna } = people.add({ name: "Anna", email: "anna@example.com", projects: ["film", "film"] });
    assert.deepEqual(anna.access, { film: "commenter" });
    assert.deepEqual([...people.projectsOf(anna)], ["film"]);
    assert.equal(people.projectsOf(people.get(owner.id)), null, "an owner sees every project");
    assert.throws(() => people.add({ name: "anna", email: "other@example.com" }), /already someone/);
    assert.throws(() => people.add({ name: "Ben", email: "ANNA@example.com" }), /already on the list/);
    assert.throws(() => people.add({ name: "Ben" }), /needs an email/);
    assert.throws(() => people.add({ name: "<b>", email: "b@example.com" }), /name/);
    assert.throws(() => people.add({ name: "Ben", email: "not-an-email" }), /email/);

    const gen = people.get(anna.id).gen;
    people.update(anna.id, { projects: ["film", "other"] });
    assert.equal(people.get(anna.id).gen, gen, "more projects keep the sessions");
    people.update(anna.id, { projects: ["other"] });
    assert.equal(people.get(anna.id).gen, gen + 1, "fewer projects end them");

    const raw = people.addToken(owner.id, "Claude Code");
    assert.equal(people.byToken(raw).id, owner.id);
    assert.equal(people.byToken(raw + "x"), null);
    assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(raw), "tokens are stored hashed");
    people.removeToken(owner.id, people.get(owner.id).tokens[0].id);
    assert.equal(people.byToken(raw), null);

    assert.throws(() => people.update(owner.id, { role: "commenter" }), /nobody who can log in/);
    assert.throws(() => people.remove(owner.id), /last owner/);
    people.remove(anna.id);
    assert.equal(people.get(anna.id), null);

    // A TOTP code works once.
    const p = people.get(owner.id);
    const code = totp(secret, Math.floor(Date.now() / 30000));
    assert.equal(people.checkTotp(p, code), true);
    assert.equal(people.checkTotp(p, code), false);
  } finally {
    done();
  }
});

test("a change made by another process is picked up", () => {
  const { file, done } = scratch();
  try {
    const a = createPeople(file), b = createPeople(file);
    a.add({ name: "Anna", email: "anna@example.com", projects: ["film"] });
    assert.equal(b.byEmail("anna@example.com").name, "Anna");
    const d = JSON.parse(readFileSync(file, "utf8"));
    d.people = [];
    writeFileSync(file, JSON.stringify(d));
    assert.equal(a.list().length, 0);
  } finally {
    done();
  }
});

test("the older env settings move in once, merged by name", () => {
  const { file, done } = scratch();
  try {
    const people = createPeople(file);
    const moved = people.importLegacy({
      tokens: "Anna=anna-token-0123456789abcdef, Agent=agent-token-0123456789abcdef",
      sharePeople: "anna@example.com=Anna,ben@example.com=Ben",
      shareProjects: "film",
    });
    assert.deepEqual(moved, [
      { name: "Anna", email: "anna@example.com", role: "owner", tokens: 1 },
      { name: "Agent", email: null, role: "owner", tokens: 1 },
      { name: "Ben", email: "ben@example.com", role: "commenter", tokens: 0 },
    ]);
    assert.equal(people.byToken("anna-token-0123456789abcdef").name, "Anna");
    assert.deepEqual(people.byName("Ben").access, { film: "commenter" });
    assert.equal(people.byName("Ben").password, null, "nobody has a password until their invite");
    assert.throws(() => createPeople(file + "2").importLegacy({ tokens: "Anna=short" }), /16 characters/);
  } finally {
    done();
  }
});

test("client metadata may only come from public addresses", async () => {
  const { publicAddress } = await import("../lib/auth.mjs");
  for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1", "::ffff:8.8.8.8"]) assert.equal(publicAddress(a), true, a);
  for (const a of ["10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "198.18.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "fd7a:115c:a1e0::1", "fe80::1", "64:ff9b::a00:1", "2001:db8::1", "not-an-ip"])
    assert.equal(publicAddress(a), false, a);
});
