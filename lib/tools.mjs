// The one tool layer. Every tool is defined here once (name, description, JSON schema,
// handler) and offered on three channels: the MCP endpoint (/mcp), the page's WebMCP
// registration and window.sceneLoop (through POST /api/tools/<name>). Only show_scene,
// which drives the page's player, lives in public/app.js.
//
// A handler gets (args, ctx). Tools marked video: true work on one video: `project` and
// `video` are added to their schema, taken off args, and ctx.video is the open video.
// Tools marked project: true work on a project: `project` is added and ctx.project is its
// name. Both are optional when there is only one. ctx.via is the channel ("mcp", "webmcp",
// "page-js", "api"); ctx.origin the server URL.
// A result may carry images: [{ file, url, label }]. The MCP layer turns those into image
// content; the HTTP layer drops the file paths.
//
// MCP App: a tool with `ui` names the ui:// resource (public/app-mcp.html, served by lib/mcp.mjs) a host with
// MCP Apps support opens with its result. `channels: ["mcp"]` keeps a tool off the page channel.

import { CLIP_TOOLS } from "./clips.mjs";

const sceneArg = { scene: { type: "string", description: "Scene id, e.g. s03-good-at" } };
const modelArg = { model: { type: "string", description: "Your model name, e.g. Claude Opus 5.5 or GPT-6.1 Sol. Shown on the version." } };
const narrationArg = { type: "string", description: "The scene's script: what the voice says. Follow the project instructions (get_rules) on pronunciation and where names go in a sentence. Changing narration makes an agreed script stale until the reviewer agrees it again." };
const obj = (properties = {}, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const abs = (ctx, url) => (url ? ctx.origin + url : null);
export const UI_URI = "ui://scene-loop/review.html";

export const TOOLS = [
  {
    name: "list_projects",
    description: "The projects this scene-loop instance serves, each with its title, tags and videos (name, title, scene count, duration, latest render). Pass the names as `project` and `video` to the other tools (each optional when there is only one).",
    inputSchema: obj(),
    handler: (a, ctx) => ctx.registry.list(),
  },
  {
    name: "create_project",
    description: "Create a project folder with a starter project.md (the instructions: voice and pronunciation, tone, brand). Add videos to it with create_video. Only works when the server was started on a projects root.",
    inputSchema: obj({ name: { type: "string", description: "Folder name: letters, digits, . _ -" }, title: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, ["name"]),
    handler: (a, ctx) => ctx.registry.create(a.name, { title: a.title, tags: a.tags }),
  },
  {
    name: "create_video", project: true,
    description: "Add a video to a project, from the template (one starter scene).",
    inputSchema: obj({ name: { type: "string", description: "Folder name: letters, digits, . _ -" }, title: { type: "string" } }, ["name"]),
    handler: (a, ctx) => ctx.registry.createVideo(ctx.project, a.name, { title: a.title }),
  },
  {
    name: "get_project_instructions", project: true,
    description: "The project's instructions (project.md): how names are pronounced and where they may sit in a sentence, voice, tone, brand. They hold for every video in the project. Read them before you write a script or send text to a voice service.",
    inputSchema: obj(),
    handler: (a, ctx) => ctx.registry.instructions(ctx.project),
  },
  {
    name: "set_project_instructions", project: true,
    description: "Replace the project's instructions (project.md, markdown with a frontmatter of title and tags). Saved as a project version. Only when the reviewer asks for it.",
    inputSchema: obj({ markdown: { type: "string" }, note: { type: "string", description: "One line: what changed" }, ...modelArg }, ["markdown", "model"]),
    handler: ({ markdown, ...a }, ctx) => ctx.registry.setInstructions(ctx.project, markdown, a),
  },
  {
    name: "get_rules", video: true,
    description: "Start here. The project's instructions first (pronunciation, voice, tone: follow them in every script and voiceover), then the video's agent rules, design spec (frame.md), theme.css and the scene contract. Scenes are plain HTML; do not load HyperFrames or other video skills.",
    inputSchema: obj(),
    handler: (a, ctx) => {
      const ins = ctx.registry.instructions(ctx.video.project);
      const scriptStatus = ctx.video.scriptStatus();
      return { text: scriptStatus.sentence, scriptStatus, project: ctx.video.project, video: ctx.video.video, instructions: ins.markdown ?? "(no project.md: the project has no instructions yet)", ...ctx.video.rules() };
    },
  },
  {
    name: "list_scenes", video: true, ui: UI_URI,
    description: "The video's scenes in order: id, title, start, duration, narration (the script: what the voice says), narration audio and length when present, picture notes, latest version, pending comments.",
    inputSchema: obj(),
    handler: async (a, ctx) => {
      const scriptStatus = ctx.video.scriptStatus();
      return { text: scriptStatus.sentence, scriptStatus, scenes: await ctx.video.listScenes() };
    },
  },
  {
    name: "get_pending_comments", video: true, ui: UI_URI,
    description: "Every comment the reviewer has pinned and not yet had applied, across all scenes, each with a still of the frame (the commented area boxed in red). Apply them with write_scene_html and pass their ids in resolves.",
    inputSchema: obj(),
    handler: async (a, ctx) => {
      const list = await ctx.video.pending();
      return {
        project: ctx.video.project,
        video: ctx.video.video,
        pending: list.map(({ file, still, ...c }) => ({ ...c, still: abs(ctx, still) })),
        images: list.filter((c) => c.file).map((c) => ({ file: c.file, url: abs(ctx, c.still), label: `${c.scene} v${c.version} at ${c.t}s, comment ${c.id}: ${c.text}` })),
      };
    },
  },
  {
    // MCP only: the page has its own show_scene that drives its player.
    name: "show_scene", video: true, ui: UI_URI, channels: ["mcp"],
    description: "Show the reviewer one scene: its stills, versions and comments. In a chat that supports MCP Apps this opens the review view, where the reviewer can pin comments on a frame. Without scene: the first scene with pending comments, else the first scene. Version defaults to the latest.",
    inputSchema: obj({ scene: sceneArg.scene, version: { type: "number" } }),
    handler: async ({ scene, version }, ctx) => {
      const { scenes } = await ctx.video.view();
      const sc = scene ? scenes.find((s) => s.id === scene) : scenes.find((s) => s.comments.some((c) => c.status === "pending")) ?? scenes[0];
      if (!sc) throw new Error(scene ? `No scene ${scene}` : "The video has no scenes");
      if (version && !sc.versions.some((x) => x.v === version)) throw new Error(`${sc.id} has no v${version}`);
      const r = await ctx.video.stills(sc.id, null, version);
      return {
        project: ctx.video.project,
        video: ctx.video.video,
        page: `${ctx.origin}/?project=${encodeURIComponent(ctx.video.project)}&video=${encodeURIComponent(ctx.video.video)}`,
        scenes: scenes.map((s) => ({ id: s.id, title: s.title })),
        scene: { id: sc.id, title: sc.title, duration: sc.duration, narration: sc.narration, picture: sc.picture },
        version: r.version,
        versions: sc.versions.map((x) => ({ v: x.v, agent: x.agent, model: x.model, via: x.via, at: x.at ?? x.date, note: x.note, from: x.from })),
        comments: sc.comments.map(({ id, version, t, region, text, status }) => ({ id, version, t, region, text, status })),
        stills: r.stills.map((s) => ({ t: s.t, url: abs(ctx, s.url) })),
        images: r.stills.map((s) => ({ file: s.file, url: abs(ctx, s.url), label: `${sc.id} v${r.version} at ${s.t}s` })),
      };
    },
  },
  {
    name: "get_scene_html", video: true,
    description: "A scene's scene.html (latest on disk, or a given version).",
    inputSchema: obj({ ...sceneArg, version: { type: "number" } }, ["scene"]),
    handler: ({ scene, version }, ctx) => ctx.video.sceneHtml(scene, version),
  },
  {
    name: "write_scene_html", video: true,
    description: "Replace a scene's scene.html. Saved as the scene's next version, with stills. Keep the root data-composition-id and data-duration. Pass the ids of the comments this change resolves. Check the result with get_stills.",
    inputSchema: obj({ ...sceneArg, html: { type: "string" }, note: { type: "string", description: "One line: what changed" }, resolves: { type: "array", items: { type: "string" } }, ...modelArg }, ["scene", "html", "model"]),
    handler: ({ scene, ...a }, ctx) => ctx.video.writeSceneHtml(scene, a, ctx.via),
  },
  {
    name: "get_stills", video: true,
    description: "Stills of a scene. Without times: the five stills of the latest version (a hand edit on disk becomes a version first). With times (scene seconds): a fresh snapshot of what is on disk. Returns the frames as images plus their URLs.",
    inputSchema: obj({ ...sceneArg, times: { type: "array", items: { type: "number" } } }, ["scene"]),
    handler: async ({ scene, times }, ctx) => {
      const r = await ctx.video.stills(scene, times);
      return { scene: r.scene, version: r.version, stills: r.stills.map((s) => ({ t: s.t, url: abs(ctx, s.url) })), images: r.stills.map((s) => ({ file: s.file, url: abs(ctx, s.url), label: `${scene}${r.version ? ` v${r.version}` : ""} at ${s.t}s` })) };
    },
  },
  {
    name: "add_comment", video: true,
    description: "Pin a comment on a scene version at a time, optionally on a region ({x,y,w,h} as fractions of the frame). Version defaults to the latest.",
    inputSchema: obj({ ...sceneArg, version: { type: "number" }, t: { type: "number" }, text: { type: "string" }, region: { type: "object" } }, ["scene", "t", "text"]),
    handler: ({ scene, ...a }, ctx) => ctx.video.addComment(scene, a),
  },
  {
    name: "restore_version", video: true,
    description: "Bring an old version of a scene back as its next version. Only when the reviewer asks.",
    inputSchema: obj({ ...sceneArg, version: { type: "number" } }, ["scene", "version"]),
    handler: ({ scene, version }, ctx) => ctx.video.restore(scene, version),
  },
  {
    name: "get_video_files", video: true,
    description: "The video's raw storyboard.json, theme.css and frame.md.",
    inputSchema: obj(),
    handler: (a, ctx) => ctx.video.files(),
  },
  {
    name: "set_video", video: true,
    description: "Change the video's settings: title, language, width, height, background, accent, soundtrack (a path under assets/ or null).",
    inputSchema: obj({ title: { type: "string" }, language: { type: "string" }, width: { type: "number" }, height: { type: "number" }, background: { type: "string" }, accent: { type: "string" }, soundtrack: { type: ["string", "null"] }, note: { type: "string" }, ...modelArg }, ["model"]),
    handler: (a, ctx) => ctx.video.setMeta(a),
  },
  {
    name: "create_scene", video: true,
    description: "Add a scene, at the end or after a given scene. Gets a starter scene.html (a title fading in) unless you pass html. Starts are recomputed from durations.",
    inputSchema: obj({ title: { type: "string" }, duration: { type: "number" }, narration: narrationArg, picture: { type: "string", description: "What is on screen" }, after: { type: "string" }, id: { type: "string" }, html: { type: "string" }, transitionIn: { type: ["object", "null"] }, ...modelArg }, ["title", "duration", "model"]),
    handler: (a, ctx) => ctx.video.createScene({ ...a, via: ctx.via }),
  },
  {
    name: "update_scene", video: true,
    description: "Change a scene's title, duration, narration (its script), picture notes or transitionIn (the crossfade into this scene: {duration} in seconds, default 0.6, or {type: \"cut\"}). Changing narration makes an agreed script stale until the reviewer agrees it again. If you change duration, also update data-duration in its html.",
    inputSchema: obj({ ...sceneArg, title: { type: "string" }, duration: { type: "number" }, narration: narrationArg, picture: { type: "string" }, transitionIn: { type: ["object", "null"] }, note: { type: "string", description: "One line: what changed" }, ...modelArg }, ["scene", "model"]),
    handler: ({ scene, ...a }, ctx) => ctx.video.updateScene(scene, a),
  },
  {
    name: "set_narration_audio", video: true,
    description: "Store one narration audio file for a scene, named after its scene id. Narration audio comes last, after the script is agreed; use one file per scene. Pass either an absolute server path or base64 file content. Replaces any existing narration file for that scene.",
    inputSchema: {
      ...obj({ ...sceneArg, path: { type: "string", description: "Absolute path to an audio file on the server" }, base64: { type: "string", description: "Base64-encoded audio file content" }, ext: { type: "string", enum: ["mp3", "wav", "m4a"], description: "Required for base64; otherwise inferred from path" }, note: { type: "string" }, ...modelArg }, ["scene", "model"]),
      oneOf: [{ required: ["path"] }, { required: ["base64", "ext"] }],
    },
    handler: ({ scene, ...a }, ctx) => ctx.video.setNarrationAudio(scene, a),
  },
  {
    name: "remove_narration_audio", video: true,
    description: "Remove the one narration audio file named after a scene id.",
    inputSchema: obj({ ...sceneArg }, ["scene"]),
    handler: ({ scene }, ctx) => ctx.video.removeNarrationAudio(scene),
  },
  {
    name: "fit_scenes_to_narration", video: true,
    description: "Fit scene durations to their narration audio on the video's frame grid. Uses picture lead before speech (default 0.35 seconds) and tail after speech (default 0.6 seconds); scenes without audio keep their duration. Update data-duration in each changed scene's html afterward.",
    inputSchema: obj({ lead: { type: "number" }, tail: { type: "number" }, scenes: { type: "array", items: { type: "string" }, description: "Optional scene ids; without this, fit every scene that has audio" }, ...modelArg }, ["model"]),
    handler: (a, ctx) => ctx.video.fitScenesToNarration(a),
  },
  {
    name: "build_soundtrack", video: true,
    description: "Build assets/narration.m4a from the one narration audio file per scene and set it as the video soundtrack. Narration audio comes last, after the script is agreed; normally run fit_scenes_to_narration first.",
    inputSchema: obj({ lead: { type: "number" }, loudness: { type: "number", description: "Target integrated loudness in LUFS (default -16)" }, ...modelArg }, ["model"]),
    handler: (a, ctx) => ctx.video.buildSoundtrack(a),
  },
  {
    name: "reorder_scenes", video: true,
    description: "Set the scene order. List every scene id once.",
    inputSchema: obj({ order: { type: "array", items: { type: "string" } }, ...modelArg }, ["order", "model"]),
    handler: ({ order, ...a }, ctx) => ctx.video.reorder(order, a),
  },
  {
    name: "remove_scene", video: true,
    description: "Take a scene out of the video. Its files and versions are kept.",
    inputSchema: obj({ ...sceneArg, ...modelArg }, ["scene", "model"]),
    handler: ({ scene, ...a }, ctx) => ctx.video.removeScene(scene, a),
  },
  {
    name: "set_theme_css", video: true,
    description: "Replace the video's theme.css, which is applied after every scene's own styles. Use it for video-wide changes like the font or colours. In the assembled video each scene's #root becomes a .scene element, so target .scene, e.g. .scene { font-family: Georgia, serif !important; }.",
    inputSchema: obj({ css: { type: "string" }, note: { type: "string" }, ...modelArg }, ["css", "model"]),
    handler: ({ css, ...a }, ctx) => ctx.video.setTheme(css, a),
  },
  {
    name: "set_design_spec", video: true,
    description: "Replace frame.md, the design spec every scene agent reads (palette, type, motion rules, brand voice).",
    inputSchema: obj({ markdown: { type: "string" }, note: { type: "string" }, ...modelArg }, ["markdown", "model"]),
    handler: ({ markdown, ...a }, ctx) => ctx.video.setDesign(markdown, a),
  },
  {
    name: "render", video: true,
    description: "Render the whole video to MP4 as a background job, every scene at its latest version. Returns a job id; poll get_render for progress and the file.",
    inputSchema: obj({}),
    handler: async (_a, ctx) => {
      const j = await ctx.video.render();
      return { ...j, url: abs(ctx, j.url) };
    },
  },
  {
    name: "get_render", video: true,
    description: "Status of a render job (state, progress, mp4 URL and path when done). Without a job id: the latest job and the list of finished renders.",
    inputSchema: obj({ job: { type: "string" } }),
    handler: ({ job }, ctx) => {
      const r = ctx.video.getRender(job);
      if (job) return { ...r, url: abs(ctx, r.url) };
      return { latest: r.latest && { ...r.latest, url: abs(ctx, r.latest.url) }, renders: r.renders.map((x) => ({ ...x, url: abs(ctx, x.url) })) };
    },
  },
  ...CLIP_TOOLS,
];

const projectArg = { project: { type: "string", description: "Project name (see list_projects). Optional when the instance has one project." } };
const videoArg = { video: { type: "string", description: "Video name within the project (see list_projects). Optional when the project has one video." } };

// What clients see: the schemas, with `project` (and `video`) added. channel "mcp" also
// gets the MCP App link, in the nested form and the older flat key (hosts read either).
export const toolList = (channel = "page") =>
  TOOLS.filter((t) => !t.channels || t.channels.includes(channel)).map(({ name, description, inputSchema, project, video, ui }) => ({
    name,
    description,
    inputSchema: video ? { ...inputSchema, properties: { ...projectArg, ...videoArg, ...inputSchema.properties } } : project ? { ...inputSchema, properties: { ...projectArg, ...inputSchema.properties } } : inputSchema,
    ...(channel === "mcp" && ui ? { _meta: { ui: { resourceUri: ui }, "ui/resourceUri": ui } } : {}),
  }));

// Run one tool. ctx: { registry, via, origin, defaults?: { project, video } } (the page's
// current project and video, used when the call names none).
export async function callTool(name, args = {}, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  if (!tool.video && !tool.project) return tool.handler(args ?? {}, ctx);
  const d = ctx.defaults ?? {};
  let { project: p, video: v, ...rest } = args ?? {};
  if (!p && !v) ({ project: p, video: v } = d);
  else if (!p && v && d.project && ctx.registry.videoNames(d.project).includes(v)) p = d.project;
  else if (p && !v && p === d.project) v = d.video;
  if (tool.project) return tool.handler(rest, { ...ctx, project: ctx.registry.pickProject(p || null) });
  return tool.handler(rest, { ...ctx, video: await ctx.registry.resolve(p || null, v || null) });
}

// For JSON channels: file paths stay on the server.
export const withoutFiles = (result) => (result && Array.isArray(result.images) ? { ...result, images: result.images.map(({ file, ...i }) => i) } : result);
