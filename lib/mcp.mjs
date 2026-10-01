// MCP over Streamable HTTP, hand-rolled: JSON-RPC 2.0 over POST, one JSON response per
// request, no session. The core protocol is stateless since the 2026-07-28 release, and
// this server only needs initialize, tools/list, tools/call and ping, so there is no SDK
// to pull in. GET (server-initiated streams) and DELETE (session end) are not offered.
import { readFileSync } from "node:fs";
import { toolList, callTool, UI_URI } from "./tools.mjs";
import { thumb } from "./stills.mjs";

const PROTOCOL = "2025-06-18"; // what we answer when the client names a version we don't know
const KNOWN = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// ---------- MCP App (ext-apps spec 2026-01-26) ----------
// One ui:// resource: public/app-mcp.html, the review view a host opens for tools whose
// _meta.ui.resourceUri points here. No CSP domains: the view gets stills as image content
// from tool calls (data: URLs), so the host's restrictive default CSP is enough.
const APP_MIME = "text/html;profile=mcp-app";
const APP_FILE = new URL("../public/app-mcp.html", import.meta.url);
const appResource = { uri: UI_URI, name: "scene-loop review", description: "A scene's stills, versions and comments; pin a comment on a frame.", mimeType: APP_MIME };
const appMeta = { ui: { prefersBorder: true } };

const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

// Tool results: the JSON as text, then one image per still (downscaled JPEG).
async function toContent(result) {
  const plain = result && typeof result === "object" && !Array.isArray(result);
  const { images = [], ...rest } = plain ? result : {};
  const content = [{ type: "text", text: JSON.stringify(plain ? rest : result, null, 1) }];
  for (const im of images) {
    try {
      const f = await thumb(im.file);
      if (im.label) content.push({ type: "text", text: im.label });
      content.push({ type: "image", data: readFileSync(f).toString("base64"), mimeType: "image/jpeg" });
    } catch (e) {
      content.push({ type: "text", text: `(image ${im.url ?? im.file} not available: ${e.message})` });
    }
  }
  return content;
}

export function createMcp({ registry, serverInfo, instructions }) {
  async function handle(msg, ctx) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid Request");
    const { id, method, params = {} } = msg;
    const isNotification = id === undefined;
    try {
      let result;
      switch (method) {
        case "initialize": {
          const asked = params.protocolVersion;
          result = {
            protocolVersion: KNOWN.includes(asked) ? asked : PROTOCOL,
            capabilities: { tools: { listChanged: false }, resources: {}, extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [APP_MIME] } } },
            serverInfo,
            instructions,
          };
          break;
        }
        case "notifications/initialized":
        case "notifications/cancelled":
        case "notifications/roots/list_changed":
          return null;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: toolList("mcp") };
          break;
        case "resources/list":
          result = { resources: [{ ...appResource, _meta: appMeta }] };
          break;
        case "resources/templates/list":
          result = { resourceTemplates: [] };
          break;
        case "resources/read":
          if (params.uri !== UI_URI) return rpcError(id, -32002, `Resource not found: ${params.uri}`);
          result = { contents: [{ uri: UI_URI, mimeType: APP_MIME, text: readFileSync(APP_FILE, "utf8"), _meta: appMeta }] };
          break;
        case "tools/call": {
          if (typeof params.name !== "string") return rpcError(id, -32602, "params.name is required");
          try {
            const r = await callTool(params.name, params.arguments ?? {}, { ...ctx, via: "mcp" });
            result = { content: await toContent(r) };
          } catch (e) {
            result = { content: [{ type: "text", text: e.message }], isError: true };
          }
          break;
        }
        default:
          return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
      }
      return isNotification ? null : { jsonrpc: "2.0", id, result };
    } catch (e) {
      return rpcError(id, -32603, e.message);
    }
  }

  // Node http handler for /mcp. Returns true when it answered.
  return async function mcpRoute(req, res, { origin }) {
    const json = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    // Open on localhost, a browser page from elsewhere must not be able to drive it. With a
    // login, the bearer token (req.auth, set by lib/auth.mjs) is what counts.
    const o = req.headers.origin;
    if (o && !req.auth && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o)) return json(403, rpcError(null, -32000, "Origin not allowed"));
    // CORS for those localhost pages: browser-based hosts (the ext-apps basic host, the
    // inspector) call /mcp from another port.
    if (o) {
      res.setHeader("Access-Control-Allow-Origin", o);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS", "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "Content-Type", "Access-Control-Max-Age": "600" });
      return res.end();
    }
    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST" });
      return res.end("This MCP server is stateless: POST JSON-RPC to /mcp.");
    }
    if (req.method === "DELETE") {
      res.writeHead(405, { Allow: "POST" });
      return res.end();
    }
    if (req.method !== "POST") return json(405, rpcError(null, -32000, "POST only"));
    let body;
    try {
      body = await new Promise((resolve, reject) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => resolve(b));
        req.on("error", reject);
      });
      body = body ? JSON.parse(body) : null;
    } catch (e) {
      return json(400, rpcError(null, -32700, `Parse error: ${e.message}`));
    }
    const ctx = { registry, origin };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(m, ctx)))).filter(Boolean);
      return out.length ? json(200, out) : json(202);
    }
    const out = await handle(body, ctx);
    return out ? json(200, out) : json(202);
  };
}
