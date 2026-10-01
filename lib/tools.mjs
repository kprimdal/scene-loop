// The one tool layer. Every tool is defined here once (name, description, JSON schema,
// handler) and offered on three channels: the MCP endpoint (/mcp), the page's WebMCP
// registration and window.sceneLoop (through POST /api/tools/<name>). Only show_scene,
// which drives the page's player, lives in public/app.js.
//
// A handler gets (args, ctx). ctx.project is the resolved project for tools marked
// project: true (the `project` argument is added to their schema and taken off args).
// ctx.via is the channel ("mcp", "webmcp", "page-js", "api"); ctx.origin the server URL.
// A result may carry images: [{ file, url, label }]. The MCP layer turns those into image
// content; the HTTP layer drops the file paths.
//
// MCP App: a tool with `ui` names the ui:// resource (public/app-mcp.html, served by lib/mcp.mjs) a host with
// MCP Apps support opens with its result. `channels: ["mcp"]` keeps a tool off the page channel.

const sceneArg = { scene: { type: "string", description: "Scene id, e.g. s03-good-at" } };
const modelArg = { model: { type: "string", description: "Your model name, e.g. Claude Opus 5.5 or GPT-6.1 Sol. Shown on the version." } };
const obj = (properties = {}, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const abs = (ctx, url) => (url ? ctx.origin + url : null);
export const UI_URI = "ui://scene-loop/review.html";

export const TOOLS = [
  {
    name: "list_projects",
    description: "The projects this scene-loop instance serves: name, title, scene count, folder. Pass the name as `project` to the other tools (optional when there is only one).",
    inputSchema: obj(),
    handler: (a, ctx) => ctx.registry.list(),
  },
  {
    name: "create_project",
    description: "Create a project from the template (one starter scene) in the projects folder. Only works when the server was started on a projects root, not on a single project.",
    inputSchema: obj({ name: { type: "string", description: "Folder name: letters, digits, . _ -" }, title: { type: "string" } }, ["name"]),
    handler: (a, ctx) => ctx.registry.create(a.name, { title: a.title }),
  },
  {
    name: "get_rules", project: true,
    description: "Start here. The scene contract, the project's agent rules, design spec (frame.md) and theme.css. Scenes are plain HTML; do not load HyperFrames or other video skills.",
    inputSchema: obj(),
    handler: (a, ctx) => ctx.project.rules(),
  },
  {
    name: "list_scenes", project: true, ui: UI_URI,
    description: "The video's scenes in order: id, title, start, duration, narration, picture notes, latest and approved version, pending comments.",
    inputSchema: obj(),
    handler: (a, ctx) => ctx.project.listScenes(),
  },
  {
    name: "get_pending_comments", project: true, ui: UI_URI,
    description: "Every comment the reviewer has pinned and not yet had applied, across all scenes, each with a still of the frame (the commented area boxed in red). Apply them with write_scene_html and pass their ids in resolves.",
    inputSchema: obj(),
    handler: async (a, ctx) => {
      const list = await ctx.project.pending();
      return {
        pending: list.map(({ file, still, ...c }) => ({ ...c, still: abs(ctx, still) })),
        images: list.filter((c) => c.file).map((c) => ({ file: c.file, url: abs(ctx, c.still), label: `${c.scene} v${c.version} at ${c.t}s, comment ${c.id}: ${c.text}` })),
      };
    },
  },
  {
    // MCP only: the page has its own show_scene that drives its player.
    name: "show_scene", project: true, ui: UI_URI, channels: ["mcp"],
    description: "Show the reviewer one scene: its stills, versions and comments. In a chat that supports MCP Apps this opens the review view, where the reviewer can pin comments on a frame. Without scene: the first scene with pending comments, else the first scene. Version defaults to the latest.",
    inputSchema: obj({ scene: sceneArg.scene, version: { type: "number" } }),
    handler: async ({ scene, version }, ctx) => {
      const { scenes } = await ctx.project.view();
      const sc = scene ? scenes.find((s) => s.id === scene) : scenes.find((s) => s.comments.some((c) => c.status === "pending")) ?? scenes[0];
      if (!sc) throw new Error(scene ? `No scene ${scene}` : "The project has no scenes");
      if (version && !sc.versions.some((x) => x.v === version)) throw new Error(`${sc.id} has no v${version}`);
      const r = await ctx.project.stills(sc.id, null, version);
      return {
        project: ctx.project.name,
        page: `${ctx.origin}/?project=${encodeURIComponent(ctx.project.name)}`,
        scenes: scenes.map((s) => ({ id: s.id, title: s.title })),
        scene: { id: sc.id, title: sc.title, duration: sc.duration, narration: sc.narration, picture: sc.picture, approved: sc.approved },
        version: r.version,
        versions: sc.versions.map((x) => ({ v: x.v, agent: x.agent, model: x.model, via: x.via, at: x.at ?? x.date, note: x.note, from: x.from })),
        comments: sc.comments.map(({ id, version, t, region, text, status }) => ({ id, version, t, region, text, status })),
        stills: r.stills.map((s) => ({ t: s.t, url: abs(ctx, s.url) })),
        images: r.stills.map((s) => ({ file: s.file, url: abs(ctx, s.url), label: `${sc.id} v${r.version} at ${s.t}s` })),
      };
    },
  },
  {
    name: "get_scene_html", project: true,
    description: "A scene's scene.html (latest on disk, or a given version).",
    inputSchema: obj({ ...sceneArg, version: { type: "number" } }, ["scene"]),
    handler: ({ scene, version }, ctx) => ctx.project.sceneHtml(scene, version),
  },
  {
    name: "write_scene_html", project: true,
    description: "Replace a scene's scene.html. Saved as the scene's next version, with stills. Keep the root data-composition-id and data-duration. Pass the ids of the comments this change resolves. Check the result with get_stills.",
    inputSchema: obj({ ...sceneArg, html: { type: "string" }, note: { type: "string", description: "One line: what changed" }, resolves: { type: "array", items: { type: "string" } }, ...modelArg }, ["scene", "html", "model"]),
    handler: ({ scene, ...a }, ctx) => ctx.project.writeSceneHtml(scene, a, ctx.via),
  },
  {
    name: "get_stills", project: true,
    description: "Stills of a scene. Without times: the five stills of the latest version (a hand edit on disk becomes a version first). With times (scene seconds): a fresh snapshot of what is on disk. Returns the frames as images plus their URLs.",
    inputSchema: obj({ ...sceneArg, times: { type: "array", items: { type: "number" } } }, ["scene"]),
    handler: async ({ scene, times }, ctx) => {
      const r = await ctx.project.stills(scene, times);
      return { scene: r.scene, version: r.version, stills: r.stills.map((s) => ({ t: s.t, url: abs(ctx, s.url) })), images: r.stills.map((s) => ({ file: s.file, url: abs(ctx, s.url), label: `${scene}${r.version ? ` v${r.version}` : ""} at ${s.t}s` })) };
    },
  },
  {
    name: "add_comment", project: true,
    description: "Pin a comment on a scene version at a time, optionally on a region ({x,y,w,h} as fractions of the frame). Version defaults to the latest.",
    inputSchema: obj({ ...sceneArg, version: { type: "number" }, t: { type: "number" }, text: { type: "string" }, region: { type: "object" } }, ["scene", "t", "text"]),
    handler: ({ scene, ...a }, ctx) => ctx.project.addComment(scene, a),
  },
  {
    name: "approve_version", project: true,
    description: "Approve a version of a scene. Only when the reviewer asks.",
    inputSchema: obj({ ...sceneArg, version: { type: "number" } }, ["scene", "version"]),
    handler: ({ scene, version }, ctx) => ctx.project.approve(scene, version),
  },
  {
    name: "restore_version", project: true,
    description: "Bring an old version of a scene back as its next version. Only when the reviewer asks.",
    inputSchema: obj({ ...sceneArg, version: { type: "number" } }, ["scene", "version"]),
    handler: ({ scene, version }, ctx) => ctx.project.restore(scene, version),
  },
  {
    name: "get_project_files", project: true,
    description: "The raw storyboard.json, theme.css and frame.md.",
    inputSchema: obj(),
    handler: (a, ctx) => ctx.project.files(),
  },
  {
    name: "set_project", project: true,
    description: "Change project settings: title, language, width, height, background, accent, soundtrack (a path under assets/ or null).",
    inputSchema: obj({ title: { type: "string" }, language: { type: "string" }, width: { type: "number" }, height: { type: "number" }, background: { type: "string" }, accent: { type: "string" }, soundtrack: { type: ["string", "null"] }, note: { type: "string" }, ...modelArg }, ["model"]),
    handler: (a, ctx) => ctx.project.setMeta(a),
  },
  {
    name: "create_scene", project: true,
    description: "Add a scene, at the end or after a given scene. Gets a starter scene.html (a title fading in) unless you pass html. Starts are recomputed from durations.",
    inputSchema: obj({ title: { type: "string" }, duration: { type: "number" }, narration: { type: "string" }, picture: { type: "string", description: "What is on screen" }, after: { type: "string" }, id: { type: "string" }, html: { type: "string" }, transitionIn: { type: ["object", "null"] }, ...modelArg }, ["title", "duration", "model"]),
    handler: (a, ctx) => ctx.project.createScene({ ...a, via: ctx.via }),
  },
  {
    name: "update_scene", project: true,
    description: "Change a scene's title, duration, narration, picture notes or transitionIn (the crossfade into this scene: {duration} in seconds, default 0.6, or {type: \"cut\"}). If you change duration, also update data-duration in its html.",
    inputSchema: obj({ ...sceneArg, title: { type: "string" }, duration: { type: "number" }, narration: { type: "string" }, picture: { type: "string" }, transitionIn: { type: ["object", "null"] }, ...modelArg }, ["scene", "model"]),
    handler: ({ scene, ...a }, ctx) => ctx.project.updateScene(scene, a),
  },
  {
    name: "reorder_scenes", project: true,
    description: "Set the scene order. List every scene id once.",
    inputSchema: obj({ order: { type: "array", items: { type: "string" } }, ...modelArg }, ["order", "model"]),
    handler: ({ order, ...a }, ctx) => ctx.project.reorder(order, a),
  },
  {
    name: "remove_scene", project: true,
    description: "Take a scene out of the video. Its files and versions are kept.",
    inputSchema: obj({ ...sceneArg, ...modelArg }, ["scene", "model"]),
    handler: ({ scene, ...a }, ctx) => ctx.project.removeScene(scene, a),
  },
  {
    name: "set_theme_css", project: true,
    description: "Replace theme.css, which is applied after every scene's own styles. Use it for project-wide changes like the font or colours. In the assembled video each scene's #root becomes a .scene element, so target .scene, e.g. .scene { font-family: Georgia, serif !important; }.",
    inputSchema: obj({ css: { type: "string" }, note: { type: "string" }, ...modelArg }, ["css", "model"]),
    handler: ({ css, ...a }, ctx) => ctx.project.setTheme(css, a),
  },
  {
    name: "set_design_spec", project: true,
    description: "Replace frame.md, the design spec every scene agent reads (palette, type, motion rules, brand voice).",
    inputSchema: obj({ markdown: { type: "string" }, note: { type: "string" }, ...modelArg }, ["markdown", "model"]),
    handler: ({ markdown, ...a }, ctx) => ctx.project.setDesign(markdown, a),
  },
  {
    name: "render", project: true,
    description: "Render the whole video to MP4 as a background job. mode: latest (default) uses every scene's latest version, approved uses approved versions where there are any. Returns a job id; poll get_render for progress and the file.",
    inputSchema: obj({ mode: { type: "string", enum: ["latest", "approved"] } }),
    handler: async ({ mode }, ctx) => {
      const j = await ctx.project.render(mode === "approved" ? "approved" : "latest");
      return { ...j, url: abs(ctx, j.url) };
    },
  },
  {
    name: "get_render", project: true,
    description: "Status of a render job (state, progress, mp4 URL and path when done). Without a job id: the latest job and the list of finished renders.",
    inputSchema: obj({ job: { type: "string" } }),
    handler: ({ job }, ctx) => {
      const r = ctx.project.getRender(job);
      if (job) return { ...r, url: abs(ctx, r.url) };
      return { latest: r.latest && { ...r.latest, url: abs(ctx, r.latest.url) }, renders: r.renders.map((x) => ({ ...x, url: abs(ctx, x.url) })) };
    },
  },
];

const projectArg = { project: { type: "string", description: "Project name (see list_projects). Optional when the instance has one project." } };

// What clients see: the schemas, with `project` added to project tools. channel "mcp" also
// gets the MCP App link, in the nested form and the older flat key (hosts read either).
export const toolList = (channel = "page") =>
  TOOLS.filter((t) => !t.channels || t.channels.includes(channel)).map(({ name, description, inputSchema, project, ui }) => ({
    name,
    description,
    inputSchema: project ? { ...inputSchema, properties: { ...projectArg, ...inputSchema.properties } } : inputSchema,
    ...(channel === "mcp" && ui ? { _meta: { ui: { resourceUri: ui }, "ui/resourceUri": ui } } : {}),
  }));

// Run one tool. ctx: { registry, via, origin, project? (a default project name) }.
export async function callTool(name, args = {}, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  const { project: projectName, ...rest } = args ?? {};
  const project = tool.project ? await ctx.registry.resolve(projectName || ctx.project || null) : null;
  return tool.handler(rest, { ...ctx, project });
}

// For JSON channels: file paths stay on the server.
export const withoutFiles = (result) => (result && Array.isArray(result.images) ? { ...result, images: result.images.map(({ file, ...i }) => i) } : result);
