// Agent adapters. Both drive the locally installed CLI on the user's own subscription
// login, never an API key. Each run is one turn in a resumable session and streams
// normalised events: { kind: "text" | "tool" | "status", text }.
//
// Scope: Claude runs in don't-ask mode with user settings skipped (a user's global
// settings may allow Edit/Write everywhere) and edit rules limited to writeDir. Codex runs in
// its workspace-write sandbox with cwd = writeDir. The server also reverts anything
// written outside the scene folder, as a backstop.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Auth and harness variables that would make a child claude use an API key, a proxy,
// or think it is nested inside another Claude Code session.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PID|CLAUDE_EFFORT)$/.test(k)) delete env[k];
  }
  return env;
}

const abs = (p) => "/" + p; // Claude permission rules use //absolute/path

function claudeArgs({ prompt, sessionId, isNew, readDir, writeDir, bashAllow }) {
  return [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project",
    "--permission-mode", "dontAsk",
    "--allowedTools",
    `Read(${abs(readDir)}/**)`, "Glob", "Grep",
    `Edit(${abs(writeDir)}/**)`, `Write(${abs(writeDir)}/**)`,
    ...bashAllow.map((b) => `Bash(${b}:*)`),
    ...(isNew ? ["--session-id", sessionId] : ["--resume", sessionId]),
  ];
}

function codexArgs({ prompt, sessionId, isNew, images }) {
  // network_access lets the still helper reach the app server on localhost
  const common = ["--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true", ...images.flatMap((i) => ["-i", i])];
  // -i takes several values, so "--" keeps it from eating the session id and prompt
  return isNew ? ["exec", ...common, "--", prompt] : ["exec", "resume", ...common, "--", sessionId, prompt];
}

function short(s, n = 140) {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function parseClaude(e, out) {
  if (e.type === "system" && e.subtype === "init") return [{ kind: "status", text: `claude · ${e.model}` }];
  if (e.type === "assistant") {
    return e.message.content.flatMap((c) => {
      if (c.type === "text" && c.text.trim()) return [{ kind: "text", text: c.text }];
      if (c.type === "tool_use") return [{ kind: "tool", text: `${c.name} ${short(c.input?.file_path ?? c.input?.command ?? c.input?.pattern ?? "")}` }];
      return [];
    });
  }
  if (e.type === "result") {
    out.ok = !e.is_error;
    out.final = e.result;
    out.usage = { costUsdNotional: e.total_cost_usd, turns: e.num_turns };
  }
  return [];
}

function parseCodex(e, out) {
  if (e.type === "thread.started") out.sessionId = e.thread_id;
  if (e.type === "item.completed") {
    const it = e.item;
    if (it.type === "agent_message") return [{ kind: "text", text: it.text }];
    if (it.type === "command_execution") return [{ kind: "tool", text: `$ ${short(it.command.replace(/^\/bin\/zsh -lc /, ""))} → ${it.exit_code}` }];
    if (it.type === "file_change") return [{ kind: "tool", text: `edit ${it.changes.map((c) => c.path.split("/").slice(-2).join("/")).join(", ")}` }];
  }
  if (e.type === "turn.completed") {
    out.ok = true;
    out.usage = e.usage;
  }
  if (e.type === "turn.failed" || e.type === "error") {
    out.ok = false;
    return [{ kind: "status", text: `codex error: ${short(e.error?.message ?? e.message, 300)}` }];
  }
  return [];
}

// Runs one turn. Resolves with { ok, sessionId, final, ms, usage, cancelled }.
export function runTurn({ agent, cwd, prompt, sessionId, readDir, writeDir, images = [], bashAllow = [], onEvent }) {
  const isNew = !sessionId;
  const out = { ok: false, sessionId: sessionId ?? (agent === "claude" ? randomUUID() : null), final: "", usage: null };
  const [cmd, args, parse] =
    agent === "claude"
      ? ["claude", claudeArgs({ prompt, sessionId: out.sessionId, isNew, readDir, writeDir, bashAllow }), parseClaude]
      : ["codex", codexArgs({ prompt, sessionId, isNew, images }), parseCodex];
  const started = Date.now();
  const child = spawn(cmd, args, { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  let errTail = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      try {
        for (const ev of parse(JSON.parse(line), out)) onEvent?.(ev);
      } catch {}
    }
  });
  child.stderr.on("data", (d) => (errTail = (errTail + d).slice(-2000)));
  const done = new Promise((resolve) => {
    child.on("close", (code) => {
      out.ms = Date.now() - started;
      if (code !== 0 && !out.cancelled) {
        out.ok = false;
        onEvent?.({ kind: "status", text: `${agent} exited ${code}: ${short(errTail.split("\n").filter((l) => !/oauth|rmcp/i.test(l)).join(" "), 400)}` });
      }
      resolve(out);
    });
  });
  return {
    done,
    cancel() {
      out.cancelled = true;
      child.kill("SIGTERM");
    },
  };
}
