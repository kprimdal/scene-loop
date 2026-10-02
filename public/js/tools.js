import { S, api } from "./state.js";
import { go, videoUrl } from "./projects.js";
import { player, setMode, loadPlayer } from "./stage.js";
import { setScript } from "./script.js";
import { selectScene } from "./filmstrip.js";

// ---------- tools for a browser agent next to the page ----------
// The tool list comes from the server (lib/tools.mjs), the same one the MCP endpoint
// serves, and every call goes to POST /api/tools/<name> for the current video. Only
// show_scene, which drives this page's player, is defined here. Registered with WebMCP
// when the browser supports it (ChatGPT desktop "Site tools", Chrome origin trial), and
// always exposed as window.sceneLoop for agents that can run page JavaScript.
const serverTools = (await api("/api/tools")).map((t) => ({ ...t, execute: (args, via) => api(`/api/tools/${t.name}`, { body: { args, via } }) }));
const TOOLS = [
  ...serverTools,
  { name: "show_scene", description: "Show a scene in the preview at a time in seconds (scene time), so the reviewer sees it. With another project or video (or from the overview) the page opens that video first.", inputSchema: { type: "object", properties: { project: { type: "string" }, video: { type: "string" }, scene: { type: "string", description: "Scene id" }, t: { type: "number" } }, required: ["scene"] },
    execute: async ({ project, video, scene, t = 0 }) => {
      if (S.overview || (project && project !== S.project) || (video && video !== S.video)) {
        setTimeout(() => go(videoUrl(project ?? S.project, video ?? S.video, { scene })), 50);
        return { opening: { project: project ?? S.project, video: video ?? S.video, scene } };
      }
      if (S.mode !== "scene") setMode("scene"); if (S.script) setScript(false); selectScene(scene); delete S.view[scene]; await loadPlayer(true); player.seek(t); return { shown: scene, t };
    } },
];
window.sceneLoop = Object.fromEntries(TOOLS.map((t) => [t.name, (args = {}) => t.execute(args, "page-js")]));
const help = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
window.sceneLoop.help = help;
const mc = document.modelContext ?? navigator.modelContext;
if (mc?.registerTool) {
  for (const t of TOOLS) {
    try {
      mc.registerTool({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: async (args) => ({ content: [{ type: "text", text: JSON.stringify(await t.execute(args ?? {}, "webmcp")) }] }) });
    } catch (e) {
      console.warn("WebMCP registerTool failed", t.name, e);
    }
  }
}
document.documentElement.dataset.webmcp = mc?.registerTool ? "registered" : "unavailable";
