// The owner's page for people (/people) and everyone's own page (/account). Plain HTML forms
// posted back to the same page, so they work without the app's JavaScript. The gate has
// already checked the login and that a write comes from this site.
//
//   /people   owners: add someone to projects (which makes their invite link), see who has
//             access and how far they got, change their projects or role, send a new link,
//             log them out everywhere, unlock them, give them agent tokens, remove them.
//   /account  the logged-in person: change the password, log out everywhere, own agent
//             tokens (owners).
import { esc } from "./auth.mjs";
import { checkPassword, passwordProblem, ROLES } from "./people.mjs";

const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "");

export function createAdmin({ people, auth, registry, onRemoved = () => {} }) {
  const nav = (user) => `<nav class="top"><a href="/">Projects</a>${user.owner ? `<a href="/people">People</a>` : ""}${user.boot ? "" : `<a href="/account">Account</a>`}${auth.enabled() ? `<form method="post" action="/logout" style="display:inline;margin:0"><button class="link">Log out</button></form>` : ""}</nav>`;
  const projectNames = () => registry.names();
  const inviteUrl = (req, raw) => `${auth.baseUrl(req)}/invite/${raw}`;
  const linkNotice = (req, p, raw) => `
    <div class="notice"><p><b>Send this link to ${esc(p.name)}</b> (${esc(p.email)}) yourself. It works once, for seven days, and sets ${p.role === "owner" ? "a password and an authenticator app" : "a password"}.</p>
    <input class="copy" readonly value="${esc(inviteUrl(req, raw))}" onclick="this.select()"></div>`;
  const tokenNotice = (p, raw) => `
    <div class="notice"><p><b>A new agent token for ${esc(p.name)}.</b> It is shown only now. In Claude Code:</p>
    <input class="copy" readonly value="${esc(raw)}" onclick="this.select()">
    <p class="small">claude mcp add --transport http scene-loop &lt;this server&gt;/mcp --header "Authorization: Bearer ${esc(raw)}"</p></div>`;

  const status = (p) => {
    const lock = auth.lockedUntil(p.email);
    const parts = [];
    if (!p.email) parts.push("Agent only, no login");
    else if (p.password && (p.role !== "owner" || p.totp)) parts.push(p.lastLogin ? `Active, last login ${when(p.lastLogin)}` : "Active");
    else if (p.invite?.exp * 1000 > Date.now()) parts.push(`Invited, link valid until ${when(p.invite.exp * 1000)}`);
    else parts.push("No login yet: send a new link");
    if (p.password && p.invite?.exp * 1000 > Date.now()) parts.push(`New link sent, valid until ${when(p.invite.exp * 1000)}`);
    if (lock) parts.push(`<b class="err">Locked until ${when(lock)}</b>`);
    return parts.join("<br>");
  };
  const checks = (selected, name = "projects") =>
    projectNames().map((n) => `<label class="chk"><input type="checkbox" name="${name}" value="${esc(n)}"${selected.has(n) ? " checked" : ""}>${esc(n)}</label>`).join("") || `<span class="small">No projects yet.</span>`;
  const form = (id, action, label, cls = "ghost small", extra = "", confirm = "") =>
    `<form method="post"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="${action}">${extra}<button class="${cls}"${confirm ? ` onclick="return confirm(${esc(JSON.stringify(confirm))})"` : ""}>${label}</button></form>`;
  const tokenRows = (p) =>
    (p.tokens ?? []).map((t) => `<div class="row small">${esc(t.label)} · ${when(t.createdAt)} ${form(p.id, "revoke-token", "Revoke", "danger small", `<input type="hidden" name="token" value="${esc(t.id)}">`, `Revoke ${t.label}? Agents using it stop working.`)}</div>`).join("") +
    `<form method="post" class="row"><input type="hidden" name="id" value="${esc(p.id)}"><input type="hidden" name="action" value="new-token"><input name="label" placeholder="Label, e.g. Claude Code" size="16"><button class="ghost small">New agent token</button></form>`;

  function peoplePage(req, user, notice = "", error = "") {
    const list = people.list();
    const rows = list.map((p) => {
      const me = p.id === user.id;
      const projects = p.role === "owner" ? `<span class="small">Every project</span>`
        : `<form method="post"><input type="hidden" name="id" value="${esc(p.id)}"><input type="hidden" name="action" value="projects">${checks(new Set(Object.keys(p.access ?? {})))}<button class="ghost small">Save</button></form>`;
      return `<tr>
        <td><b>${esc(p.name)}</b>${me ? ' <span class="small">(you)</span>' : ""}<br><span class="small">${esc(p.email ?? "")}</span></td>
        <td>${p.role}</td>
        <td>${projects}</td>
        <td class="small">${status(p)}</td>
        <td>
          ${p.email ? form(p.id, "invite", p.password ? "New link" : "Invite link") : ""}
          ${p.email && p.password && !me ? form(p.id, "logout", "Log out everywhere") : ""}
          ${auth.lockedUntil(p.email) ? form(p.id, "unlock", "Unlock") : ""}
          ${!me && p.email ? form(p.id, "role", p.role === "owner" ? "Make commenter" : "Make owner", "ghost small", `<input type="hidden" name="role" value="${p.role === "owner" ? "commenter" : "owner"}">`, p.role === "owner" ? "" : `Make ${p.name} an owner? Owners see every project, manage people and use the agent tools.`) : ""}
          ${me ? "" : form(p.id, "remove", "Remove", "danger small", "", `Remove ${p.name}? They lose access at once.`)}
          ${p.role === "owner" ? `<div style="margin-top:8px">${tokenRows(p)}</div>` : ""}
        </td></tr>`;
    }).join("");
    const firstRun = !auth.enabled();
    const body = `
      ${nav(user)}
      <h1>People</h1>
      ${firstRun ? `<p class="notice">Nobody can log in yet, so this page is open. The first person with an email turns the login on, for you too: invite yourself as an owner first and open your link before you close this page.</p>` : ""}
      ${notice}${error ? `<p class="err">${esc(error)}</p>` : ""}
      <table><tr><th>Person</th><th>Role</th><th>Projects</th><th>Status</th><th></th></tr>${rows || `<tr><td colspan="5" class="small">Nobody yet.</td></tr>`}</table>
      <h2>Add someone</h2>
      <form method="post" id="addForm"><input type="hidden" name="action" value="add">
        <div class="row">
          <label>Name<input name="name" required maxlength="60" placeholder="Anna"></label>
          <label>Email<input type="email" name="email" placeholder="anna@example.com"></label>
          <label>Role<select name="role">${ROLES.map((r) => `<option value="${r}"${r === (firstRun ? "owner" : "commenter") ? " selected" : ""}>${r}</option>`).join("")}</select></label>
        </div>
        <p style="margin:4px 0 8px"><b>Projects</b> <span class="small">(a commenter sees only these; an owner sees all)</span></p>
        <div>${checks(new Set())}</div>
        <div class="row" style="margin-top:14px"><button>Add and make the invite link</button></div>
        <p class="small">An owner without an email is an agent identity: it holds tokens and has no login.</p>
      </form>`;
    return (res) => auth.html(res, error ? 400 : 200, body, { wide: true });
  }

  const accountPage = (req, user, notice = "", error = "") => {
    const p = user.boot ? null : people.get(user.id);
    if (!p) return (res) => auth.html(res, 200, `${nav(user)}<h1>Account</h1><p>You are in with the server's own password or an open page, which has no account. Owners add people on <a href="/people">People</a>.</p>`);
    const body = `
      ${nav(user)}
      <h1>${esc(p.name)}</h1>
      <p>${esc(p.email)} · ${p.role}${p.role === "owner" ? "" : ` on ${Object.keys(p.access ?? {}).map(esc).join(", ") || "no projects"}`}</p>
      ${notice}${error ? `<p class="err">${esc(error)}</p>` : ""}
      <h2>Change password</h2>
      <form method="post"><input type="hidden" name="action" value="password">
        <label>Current password<input type="password" name="current" autocomplete="current-password"></label>
        <label>New password (12 characters or more)<input type="password" name="password" autocomplete="new-password" minlength="12"></label>
        <label>The same again<input type="password" name="again" autocomplete="new-password" minlength="12"></label>
        <div class="row"><button>Change password</button></div>
        <p class="small">This logs you out on every other device.</p>
      </form>
      <h2>Devices</h2>
      <form method="post"><input type="hidden" name="action" value="logout"><button class="ghost">Log out everywhere</button></form>
      ${p.role === "owner" ? `<h2>Agent tokens</h2><p class="small">For Claude Code and other MCP clients: their writes show as "model (${esc(p.name)})".</p>${tokenRows(p)}` : ""}`;
    return (res) => auth.html(res, error ? 400 : 200, body);
  };

  const list = (v) => [v ?? []].flat().filter(Boolean);
  async function postPeople(req, res, user) {
    const b = await auth.parseBody(req);
    const target = b.id ? people.get(b.id) : null;
    if (b.action !== "add" && !target) return peoplePage(req, user, "", "No such person.")(res);
    try {
      switch (b.action) {
        case "add": {
          const role = ROLES.includes(b.role) ? b.role : "commenter";
          if (!auth.enabled() && role !== "owner" && b.email) throw new Error("Invite yourself as an owner first: the first person with an email turns the login on.");
          const unknown = list(b.projects).filter((n) => !projectNames().includes(n));
          if (unknown.length) throw new Error(`No project ${unknown.join(", ")}.`);
          if (role !== "owner" && !list(b.projects).length) throw new Error("Tick at least one project for a commenter.");
          const { person, invite } = people.add({ name: b.name, email: b.email || null, role, projects: list(b.projects) }, auth.secretForNew);
          return peoplePage(req, user, invite ? linkNotice(req, person, invite) : `<p class="notice">${esc(person.name)} added. Give them an agent token below.</p>`)(res);
        }
        case "projects": {
          const unknown = list(b.projects).filter((n) => !projectNames().includes(n));
          if (unknown.length) throw new Error(`No project ${unknown.join(", ")}.`);
          people.update(target.id, { projects: list(b.projects) });
          onRemoved();
          return peoplePage(req, user, `<p class="notice">${esc(target.name)} now sees ${list(b.projects).map(esc).join(", ") || "no projects"}.</p>`)(res);
        }
        case "role":
          if (target.id === user.id) throw new Error("Ask another owner to change your own role.");
          people.update(target.id, { role: b.role });
          onRemoved();
          return peoplePage(req, user, `<p class="notice">${esc(target.name)} is now ${esc(b.role)}${b.role === "owner" ? ". Send them a new link: an owner sets up an authenticator app before the first login." : "."}</p>`)(res);
        case "invite":
          return peoplePage(req, user, linkNotice(req, people.get(target.id), people.invite(target.id)))(res);
        case "logout":
          people.logOutEverywhere(target.id);
          onRemoved();
          return peoplePage(req, user, `<p class="notice">${esc(target.name)} is logged out everywhere.</p>`)(res);
        case "unlock":
          auth.unlock(target.email);
          return peoplePage(req, user, `<p class="notice">${esc(target.name)} can try to log in again.</p>`)(res);
        case "remove":
          if (target.id === user.id) throw new Error("You can't remove yourself.");
          people.remove(target.id);
          onRemoved();
          return peoplePage(req, user, `<p class="notice">${esc(target.name)} is removed and has no access any more.</p>`)(res);
        case "new-token":
          if (target.role !== "owner") throw new Error("Only owners have agent access.");
          return peoplePage(req, user, tokenNotice(target, people.addToken(target.id, b.label)))(res);
        case "revoke-token":
          people.removeToken(target.id, b.token);
          return peoplePage(req, user, `<p class="notice">Token revoked.</p>`)(res);
        default:
          throw new Error("Unknown action.");
      }
    } catch (e) {
      return peoplePage(req, user, "", e.message)(res);
    }
  }

  async function postAccount(req, res, user) {
    const p = user.boot ? null : people.get(user.id);
    if (!p) return accountPage(req, user)(res);
    const b = await auth.parseBody(req);
    try {
      if (b.action === "password") {
        if (!(await checkPassword(b.current, p.password))) throw new Error("The current password is wrong.");
        const problem = passwordProblem(b.password, b.again);
        if (problem) throw new Error(problem);
        const done = await people.setPassword(p.id, b.password);
        auth.setSession(req, res, auth.userOf(done)); // this device stays logged in
        onRemoved();
        return accountPage(req, auth.userOf(done), `<p class="notice">Password changed. Other devices are logged out.</p>`)(res);
      }
      if (b.action === "logout") {
        people.logOutEverywhere(p.id);
        onRemoved();
        res.writeHead(302, { Location: "/login" });
        return res.end();
      }
      if (b.action === "new-token" && p.role === "owner") return accountPage(req, user, tokenNotice(p, people.addToken(p.id, b.label)))(res);
      if (b.action === "revoke-token") {
        people.removeToken(p.id, b.token);
        return accountPage(req, user, `<p class="notice">Token revoked.</p>`)(res);
      }
      throw new Error("Unknown action.");
    } catch (e) {
      return accountPage(req, user, "", e.message)(res);
    }
  }

  // true when it answered.
  return async function admin(req, res, path, user) {
    if (path !== "/people" && path !== "/account") return false;
    // A browser session (or the open page with no login), never a bearer token: an agent must
    // not be able to add an owner or mint itself tokens.
    if (req.auth && req.auth.kind !== "session") return auth.html(res, 403, `<h1>Not here</h1><p>People and Account take a login in the browser.</p>`), true;
    if (path === "/people") {
      if (!user.owner) return auth.html(res, 403, `${nav(user)}<h1>People</h1><p>Only an owner manages people.</p>`), true;
      if (req.method === "POST") await postPeople(req, res, user);
      else peoplePage(req, user)(res);
      return true;
    }
    if (path === "/account") {
      if (req.method === "POST") await postAccount(req, res, user);
      else accountPage(req, user)(res);
      return true;
    }
    return false;
  };
}
