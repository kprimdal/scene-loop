// Headless Chrome over the DevTools protocol, hand-rolled. Chrome is started with
// --remote-debugging-pipe, so there is no port and no WebSocket: JSON messages separated
// by NUL bytes on file descriptors 3 (to Chrome) and 4 (from Chrome). One shared browser
// per server process, launched on first use and closed after a minute without pages.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";

// CHROME_PATH wins. Then chrome-headless-shell, which screenshots about eight times faster
// than full Chrome in headless mode (video-lab 004): on PATH or where puppeteer and
// HyperFrames download it (~/.cache/*/chrome-headless-shell, newest first). Then a normal
// Chrome or Chromium install.
export function findChrome() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) throw new Error(`CHROME_PATH ${process.env.CHROME_PATH} does not exist`);
    return process.env.CHROME_PATH;
  }
  const home = homedir();
  const os = platform();
  const which = (n) => {
    try {
      return execFileSync(os === "win32" ? "where" : "which", [n], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0] || null;
    } catch {
      return null;
    }
  };
  const shell = which("chrome-headless-shell");
  if (shell) return shell;
  const ver = (p) => p.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? [0];
  const cached = [join(home, ".cache/puppeteer/chrome-headless-shell"), join(home, ".cache/hyperframes/chrome/chrome-headless-shell")]
    .filter(existsSync)
    .flatMap((root) => readdirSync(root).flatMap((v) => ["mac-arm64", "mac-x64", "linux64", "win64"].map((pl) => join(root, v, `chrome-headless-shell-${pl}`, `chrome-headless-shell${pl === "win64" ? ".exe" : ""}`))))
    .filter(existsSync)
    .sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0); return 0; });
  if (cached.length) return cached[0];
  const mac = ["Google Chrome for Testing", "Google Chrome", "Chromium"].flatMap((n) => [`/Applications/${n}.app/Contents/MacOS/${n}`, join(home, `Applications/${n}.app/Contents/MacOS/${n}`)]);
  const win = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].map((v) => process.env[v] && join(process.env[v], "Google/Chrome/Application/chrome.exe")).filter(Boolean);
  for (const p of os === "darwin" ? mac : os === "win32" ? win : []) if (existsSync(p)) return p;
  if (os === "linux") for (const n of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]) if (which(n)) return which(n);
  throw new Error("Chrome not found. Install chrome-headless-shell (npx @puppeteer/browsers install chrome-headless-shell@stable) or Google Chrome, or set CHROME_PATH.");
}

const FLAGS = [
  "--headless",
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  "--force-color-profile=srgb",
  "--hide-scrollbars",
  "--mute-audio",
  "--allow-file-access-from-files",
];

// CHROME_FLAGS adds flags, space separated. The Docker image sets --no-sandbox: Chromium's
// sandbox needs user namespaces, which Docker's default seccomp profile refuses.
const EXTRA = (process.env.CHROME_FLAGS ?? "").split(/\s+/).filter(Boolean);

export async function launch({ path = findChrome(), args = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "scene-loop-chrome-"));
  const proc = spawn(path, [...FLAGS, ...EXTRA, `--user-data-dir=${profile}`, ...args, "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const out = proc.stdio[3], inp = proc.stdio[4];
  let nextId = 1, buf = "", stderr = "", closed = null;
  const pending = new Map(); // id -> { resolve, reject, method }
  const listeners = new Set(); // (method, params, sessionId) => void

  proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  inp.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`));
        else p.resolve(msg.result);
      } else if (msg.method) for (const l of listeners) l(msg.method, msg.params, msg.sessionId);
    }
  });
  const exited = new Promise((resolve) =>
    proc.on("exit", (code) => {
      closed = new Error(`Chrome exited (${code}). ${stderr.slice(-500)}`);
      for (const p of pending.values()) p.reject(closed);
      pending.clear();
      rmSync(profile, { recursive: true, force: true });
      resolve();
    }),
  );
  proc.on("error", (e) => (closed = e));
  // A write to a dead Chrome raises 'error' on the pipe; without a handler that crashes the
  // process. The pending calls are rejected on exit, so here it is enough to note it.
  const pipeDown = (e) => { closed ??= new Error(`Chrome pipe closed: ${e.message}`); for (const p of pending.values()) p.reject(closed); pending.clear(); };
  out.on("error", pipeDown);
  inp.on("error", pipeDown);

  // Every call times out: a screenshot that never gets a frame would otherwise hang a render.
  const send = (method, params = {}, sessionId, ms = 60000) => {
    if (closed) return Promise.reject(closed);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0", (e) => e && reject(closed ?? e));
      const timer = setTimeout(() => (pending.delete(id), reject(new Error(`${method}: no answer from Chrome in ${ms / 1000} s`))), ms);
      pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)), method });
    });
  };
  const waitFor = (method, sessionId, ms = 60000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => (listeners.delete(l), reject(new Error(`timed out waiting for ${method}`))), ms);
      const l = (m, params, sid) => {
        if (m === method && sid === sessionId) {
          clearTimeout(timer);
          listeners.delete(l);
          resolve(params);
        }
      };
      listeners.add(l);
    });

  await send("Browser.getVersion"); // fails fast if the pipe isn't working

  // A page (tab) of a fixed size. goto() loads a URL and waits for the load event.
  async function newPage({ width = 1920, height = 1080 } = {}) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const s = (method, params) => send(method, params, sessionId);
    const errors = [];
    const onEvent = (m, p, sid) => {
      if (sid !== sessionId) return;
      if (m === "Runtime.exceptionThrown") errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
      if (m === "Runtime.consoleAPICalled" && p.type === "error") errors.push(p.args.map((a) => a.value ?? a.description).join(" "));
    };
    listeners.add(onEvent);
    await Promise.all([s("Page.enable"), s("Runtime.enable"), s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })]);
    return {
      errors,
      send: s,
      async goto(url, ms = 60000) {
        const loaded = waitFor("Page.loadEventFired", sessionId, ms);
        const r = await s("Page.navigate", { url });
        if (r.errorText) throw new Error(`${url}: ${r.errorText}`);
        await loaded;
      },
      // Evaluates an expression in the page; promises are awaited, the value returned by value.
      async evaluate(expression) {
        const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      async screenshot({ format = "png", quality } = {}) {
        const r = await s("Page.captureScreenshot", { format, ...(quality ? { quality } : {}), optimizeForSpeed: true });
        return Buffer.from(r.data, "base64");
      },
      async close() {
        listeners.delete(onEvent);
        await send("Target.closeTarget", { targetId }).catch(() => {});
      },
    };
  }

  return {
    newPage,
    send,
    get closed() {
      return !!closed;
    },
    async close() {
      if (!closed) {
        send("Browser.close").catch(() => {});
        setTimeout(() => proc.kill("SIGKILL"), 3000).unref();
      }
      await exited;
    },
  };
}

// The shared browser. Each use opens its own page; the browser closes a minute after the
// last page is closed, so a burst of stills doesn't pay the launch every time.
let shared = null, users = 0, idle = null;
export async function withPage(opts, fn) {
  clearTimeout(idle);
  users++;
  try {
    if (!shared || (await shared.catch(() => null))?.closed) shared = launch();
    const browser = await shared;
    const page = await browser.newPage(opts);
    try {
      return await fn(page);
    } finally {
      await page.close();
    }
  } catch (e) {
    if (shared && (await shared.catch(() => null)) === null) shared = null; // the launch itself failed; try again next time
    throw e;
  } finally {
    if (--users === 0) {
      idle = setTimeout(async () => {
        const b = await shared?.catch(() => null);
        shared = null;
        await b?.close();
      }, 60000);
      idle.unref();
    }
  }
}
