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
const narrationArg = { type: "string", description: "The scene's script: what the voice says. Follow the project instructions (get_rules) on pronunciation and where names go in a sentence." };
const obj = (properties = {}, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const abs = (ctx, url) => (url ? ctx.origin + url : null);
export const UI_URI = "ui://scene-loop/review.html";
const AFTER = "After a recording session, in this order: (1) list_takes; (2) transcribe each chosen take's narration audio (audio.path) with ElevenLabs Scribe yourself (scene-loop holds no keys); (3) set_narration_words with the raw Scribe JSON: for a recorded take it adopts what was said (the script follows the take, the line as written is kept as narrationWritten and shown as a diff in the Script view; restarts and filler sounds are cut out where the camera does not show, and flagged as recordAgain where it does: tell the reviewer); (4) re-anchor the data-at and data-sfx anchors its anchorWarnings and sfxWarnings name (write_scene_html), since rephrased lines lose words; (5) fit_scenes_to_narration with scenes: the ones whose audio changed; (6) build_soundtrack (it re-cuts the camera clips to the new durations); (7) get_stills on the changed scenes. Scenes whose audio did not change keep their duration, camera clip and render cache; later scenes only move in time.";

// ---------- the shared library (lib/library.mjs) ----------
const libraryItemArgs = {
  title: { type: "string" },
  tags: { type: "array", items: { type: "string" } },
  source: { type: "string", description: "Where it came from: elevenlabs-music, fal, suno, file, ..." },
  sourceModel: { type: "string", description: "The model that generated it, e.g. music_v1 (your own model name goes in model)" },
  prompt: { type: "string", description: "The prompt it was generated from, word for word" },
  created: { type: "string", description: "Date it was made, YYYY-MM-DD (default today)" },
  license: { type: "string", description: "License or rights note, e.g. \"ElevenLabs Music, Creator subscription, commercial use\"" },
  loop: { type: "boolean", description: "Made to loop seamlessly" },
  bpm: { type: ["number", "null"] },
  note: { type: "string" },
};
const libraryItem = (ctx, it) => ({ ...it, url: abs(ctx, it.url) });
const LIBRARY_TOOLS = [
  {
    name: "list_library",
    description: "The shared asset library every project on this instance draws from (music beds now; sfx and images later): each item's id, title, duration, source, sourceModel, prompt, created, license, loop, bpm, tags, note, a URL to listen to, and usedIn: the videos that have a copy of it (bed: true where it is the video's music). Look here before generating new music: a bed made for one video can carry the next.",
    inputSchema: obj({ kind: { type: "string", enum: ["music"] }, tag: { type: "string", description: "Only items with this tag" } }),
    handler: async (a, ctx) => {
      const r = await ctx.registry.library.list(a);
      return { ...r, items: r.items.map((it) => libraryItem(ctx, it)) };
    },
  },
  {
    name: "add_to_library",
    description: "Put a file in the shared library with what is known about it: from an absolute path on the server (a video's assets/music/x.mp3, a fresh generation, any readable file) or base64 content with ext. The file is copied into the library; the source file is left alone. Record the generation's prompt, source and sourceModel word for word: nothing is derived from the file name. The id defaults to the title as a slug. Then use_library_music puts it under a video.",
    inputSchema: {
      ...obj({ kind: { type: "string", enum: ["music"], default: "music" }, path: { type: "string", description: "Absolute path to the file on the server" }, base64: { type: "string" }, ext: { type: "string", enum: ["mp3", "wav", "m4a", "ogg", "flac"], description: "Required with base64" }, id: { type: "string", description: "Optional id: lowercase letters, digits, -" }, ...libraryItemArgs, ...modelArg }, ["title", "model"]),
      oneOf: [{ required: ["path"] }, { required: ["base64", "ext"] }],
    },
    handler: async ({ model, ...a }, ctx) => libraryItem(ctx, await ctx.registry.library.add(a, { by: model || "chat" })),
  },
  {
    name: "update_library_item",
    description: "Change a library item's metadata (title, tags, source, sourceModel, prompt, created, license, loop, bpm, note). The file itself never changes: a new take of a bed is a new item.",
    inputSchema: obj({ item: { type: "string", description: "Library item id (list_library)" }, ...libraryItemArgs, ...modelArg }, ["item", "model"]),
    handler: async ({ item, model, ...a }, ctx) => libraryItem(ctx, await ctx.registry.library.update(item, a, { by: model || "chat" })),
  },
  {
    name: "remove_from_library",
    description: "Delete an item and its file from the library. Videos that use it keep their own copy, but it is refused while it is any video's music unless force: true. Only when the reviewer asks.",
    inputSchema: obj({ item: { type: "string" }, force: { type: "boolean" }, ...modelArg }, ["item"]),
    handler: ({ item, force }, ctx) => ctx.registry.library.remove(item, { force }),
  },
  {
    name: "use_library_music", video: true,
    description: "Make a library item the video's music bed: copies the file to the video's assets/music/<id>.<ext>, or uses a file with the same content already there (the video owns its copy, so a later library change never changes a render) and sets storyboard.music to it with musicLibrary: <id>. Then build_soundtrack lays it under the voice (storyboard.musicDb dB down, default 15.5, set with set_video musicDb; looped, 1 s fade in, 2 s out). set_video music: null takes the bed out again.",
    inputSchema: obj({ item: { type: "string", description: "Library item id (list_library)" }, ...modelArg }, ["item", "model"]),
    handler: ({ item, model }, ctx) => ctx.registry.library.use(ctx.video.project, ctx.video.video, item, { model }),
  },
];

export const TOOLS = [
  {
    name: "list_projects",
    description: "The projects this scene-loop instance serves, each with its title, tags, disk use (bytes in total and by part: renders, takes, cache, stills, versions, files, trash) and videos (name, title, scene count, duration, latest render, disk use). Pass the names as `project` and `video` to the other tools (each optional when there is only one).",
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
    description: "Add a video to a project, from the template (one starter scene, or none with empty: true).",
    inputSchema: obj({ name: { type: "string", description: "Folder name: letters, digits, . _ -" }, title: { type: "string" }, empty: { type: "boolean", description: "No starter scene; add scenes with create_scene" } }, ["name"]),
    handler: (a, ctx) => ctx.registry.createVideo(ctx.project, a.name, { title: a.title, empty: a.empty }),
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
      return { project: ctx.video.project, video: ctx.video.video, instructions: ins.markdown ?? "(no project.md: the project has no instructions yet)", ...ctx.video.rules() };
    },
  },
  {
    name: "list_scenes", video: true, ui: UI_URI,
    description: "The video's scenes in order: id, title, start, duration, narration (the script: what the voice says), narrationWritten (the line as written before a take's words were adopted, when they differ), narration audio and length, timed words when present, picture notes, latest version, pending comments, missing assets, anchorWarnings (data-at anchors that do not resolve to a heard word), sfx (each data-sfx cue with its resolved scene time t, video time at, sound and any warning) and sfxWarnings (cues that fell back or name no sound), audio.stale: true when the narration text changed after its audio was set: the old take stays in the video until the scene is recorded again (or keep_take, for a spelling fix), and recordAgain: the reasons to record the scene again (a changed line; a restart or filler sound the take has while the camera is on screen). Check anchorWarnings and sfxWarnings after every script change, adoption or new take, and re-anchor those elements.",
    inputSchema: obj(),
    handler: async (a, ctx) => ({ scenes: await ctx.video.listScenes() }),
  },
  {
    name: "get_pending_comments", video: true, ui: UI_URI,
    description: "Every comment a reviewer has pinned and not yet had applied, across all scenes, each with a still of the frame (the commented area boxed in red) and by: the person who wrote it. Apply them with write_scene_html and pass their ids in resolves.",
    inputSchema: obj(),
    handler: async (a, ctx) => {
      const list = await ctx.video.pending();
      return {
        project: ctx.video.project,
        video: ctx.video.video,
        pending: list.map(({ file, still, ...c }) => ({ ...c, still: abs(ctx, still) })),
        images: list.filter((c) => c.file).map((c) => ({ file: c.file, url: abs(ctx, c.still), label: `${c.scene} v${c.version} at ${c.t}s, comment ${c.id}${c.by ? ` by ${c.by}` : ""}: ${c.text}` })),
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
        comments: sc.comments.map(({ id, version, t, region, text, by, status }) => ({ id, version, t, region, text, by, status })),
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
    description: "Stills of a scene. Without times: the five stills of the latest version (a hand edit on disk becomes a version first). With times (scene seconds): a fresh snapshot of what is on disk. Returns the frames as images (960 px JPEGs, or the full-size PNGs with full: true, for pixel alignment) plus the URLs of the full-size PNGs.",
    inputSchema: obj({ ...sceneArg, times: { type: "array", items: { type: "number" } }, full: { type: "boolean", description: "Return the full-size PNGs as the images instead of 960 px JPEGs" } }, ["scene"]),
    handler: async ({ scene, times, full }, ctx) => {
      const r = await ctx.video.stills(scene, times);
      const fonts = r.systemFonts?.length ? { systemFonts: r.systemFonts, fontWarning: `Text drawn in installed fonts (${r.systemFonts.map((f) => f.family).join(", ")}): it looks different on another machine. Load the fonts from assets/fonts with @font-face in theme.css.` } : {};
      return { scene: r.scene, version: r.version, stills: r.stills.map((s) => ({ t: s.t, url: abs(ctx, s.url) })), ...fonts, images: r.stills.map((s) => ({ file: s.file, url: abs(ctx, s.url), label: `${scene}${r.version ? ` v${r.version}` : ""} at ${s.t}s`, ...(full ? { full: true } : {}) })) };
    },
  },
  {
    name: "add_comment", video: true,
    description: "Pin a comment on a scene version at a time, optionally on a region ({x,y,w,h} as fractions of the frame). Version defaults to the latest.",
    inputSchema: obj({ ...sceneArg, version: { type: "number" }, t: { type: "number" }, text: { type: "string" }, region: { type: "object" } }, ["scene", "t", "text"]),
    handler: ({ scene, ...a }, ctx) => ctx.video.addComment(scene, a, ctx.person ?? null, ctx.personId ?? null),
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
    description: "Change the video's settings: title, language, width, height, background, accent, soundtrack (a path under assets/ or null), music (a path under assets/ or null: build_soundtrack lays it under the voice as a bed, looped, 1 s fade in and 2 s out), musicDb (how far under the voice the bed sits, in dB; default 15.5; 20 to 25 is a quiet bed; null restores the default; takes effect on the next build_soundtrack). For a bed from the shared library use use_library_music instead; a plain music path here drops the record of which library item it came from.",
    inputSchema: obj({ title: { type: "string" }, language: { type: "string" }, width: { type: "number" }, height: { type: "number" }, background: { type: "string" }, accent: { type: "string" }, soundtrack: { type: ["string", "null"] }, music: { type: ["string", "null"] }, musicDb: { type: ["number", "null"], description: "dB under the voice for the music bed, 0 to 60 (default 15.5); null for the default" }, note: { type: "string" }, ...modelArg }, ["model"]),
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
    description: "Change a scene's title, duration, narration (its script), picture notes or transitionIn (the crossfade into this scene: {duration} in seconds, default 0.6, or {type: \"cut\"}). A changed duration is written into the html's data-duration as a new scene version. A changed narration on a recorded scene never blocks anything: the old take stays in the video, and the result says recordAgain until it is recorded again or kept with keep_take.",
    inputSchema: obj({ ...sceneArg, title: { type: "string" }, duration: { type: "number" }, narration: narrationArg, picture: { type: "string" }, transitionIn: { type: ["object", "null"] }, narrationWritten: { type: "null", description: "null clears the written line an adoption kept (the Script view's Checked)" }, note: { type: "string", description: "One line: what changed" }, ...modelArg }, ["scene", "model"]),
    handler: ({ scene, ...a }, ctx) => ctx.video.updateScene(scene, a),
  },
  {
    name: "set_narration_audio", video: true,
    description: "Store one narration audio file for a scene, named after its scene id. Narration audio comes last, after the script is final; use one file per scene. Pass either an absolute server path or base64 file content. Replaces any existing narration file for that scene. After audio, use set_narration_words so data-at anchors follow the take, then run fit_scenes_to_narration if its length changed.",
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
    name: "set_narration_words", video: true,
    description: "Store scene-local word timings next to a scene's narration audio. Pass exactly one of ready [{word,start,end}] timings, raw ElevenLabs Scribe JSON, or raw whisper-cli -ojf JSON. adopt (the default when the audio is a take recorded in the Record view or added with add_take): the scene's narration becomes what was said: the script's spelling and punctuation where the words match, the transcript's words where they differ, numbers as the script wrote them (\"40\" said as \"fyrre\"); the line as written is kept as narrationWritten, the take stays current, and every word has its heard time. The result's adopted.changes lists what changed: read them for misheard names and tell the reviewer, who proofreads the diff in the Script view. adopt: false (the default for a voice service's audio of the approved script) keeps the script's words and gives words the take lacks interpolated times (unmatched). For a recorded take it also finds restarts (a phrase broken off and said again, or said twice: the later one stays) and filler sounds (\"øh\", \"ehm\" in the transcript, or a voiced hum no word covers), leaves them out of the text, and cuts them out of the audio and the camera clip (crossfade, jump cut) at the start and end of the speech and wherever the scene does not show the camera clip at that moment; the words are re-timed to the cut audio. Where the camera shows, it is not cut: the scene gets a comment by scene-loop and a recordAgain reason instead. The result's edits lists cut (take seconds), flagged (scene seconds) and keep. data-at anchors and data-sfx cues then re-time themselves to this take; the result's anchorWarnings and sfxWarnings name the ones that no longer land on a heard word: re-anchor them. " + "Then fit_scenes_to_narration and build_soundtrack.",
    inputSchema: {
      ...obj({
        ...sceneArg,
        words: { type: "array", items: obj({ word: { type: "string" }, start: { type: "number" }, end: { type: "number" } }, ["word", "start", "end"]) },
        scribe: { type: "object", description: "Raw ElevenLabs Scribe JSON" },
        whisper: { type: "object", description: "Raw whisper-cli -ojf JSON; DTW token times are required" },
        script: { type: "string", description: "Approved script to align spelling and punctuation to; defaults to this scene's narration" },
        adopt: { type: "boolean", description: "Rewrite the scene's narration to what the take says. Default: true when the audio is a recorded take, else false" },
        cut: { type: "boolean", description: "For a recorded take (default true): cut restarts and filler sounds out of the audio and the camera clip where the camera is not on screen. false only proposes the keep ranges (list_takes shows them as proposed)" },
        ...modelArg,
      }, ["scene", "model"]),
      oneOf: [{ required: ["words"] }, { required: ["scribe"] }, { required: ["whisper"] }],
    },
    handler: ({ scene, ...a }, ctx) => ctx.video.setNarrationWords(scene, a),
  },
  {
    name: "remove_narration_words", video: true,
    description: "Remove a scene's timed narration words. Its data-at anchors then keep their authored CSS animation delays.",
    inputSchema: obj({ ...sceneArg }, ["scene"]),
    handler: ({ scene }, ctx) => ctx.video.removeNarrationWords(scene),
  },
  {
    name: "fit_scenes_to_narration", video: true,
    description: "Fit scene durations to their narration audio on the video's frame grid and store each scene's narration lead for word anchors. Uses picture lead before the audio (default 0.35 seconds) and tail after it (default 0.6 seconds); scenes without audio keep their duration. A new take re-times data-at anchors through its words; run this again when the audio length changed, with scenes: the ones re-recorded. Changed scenes get their data-duration updated as a new version, and their camera clips (assets/cam, from a chosen take) are re-cut to the new length. Scenes whose audio did not change keep their duration, version, camera clip and render cache, even when they move in time.",
    inputSchema: obj({ lead: { type: "number" }, tail: { type: "number" }, scenes: { type: "array", items: { type: "string" }, description: "Optional scene ids; without this, fit every scene that has audio" }, ...modelArg }, ["model"]),
    handler: (a, ctx) => ctx.video.fitScenesToNarration(a),
  },
  {
    name: "build_soundtrack", video: true,
    description: "Build assets/narration.m4a from the one narration audio file per scene, store the narration lead used by word anchors, and set it as the video soundtrack. The scenes' data-sfx cues are mixed in at their resolved times (sfx and sfxWarnings in the result), and storyboard.music as a bed under the voice. Camera clips from takes are re-cut only when their scene's lead or duration changed; the soundtrack is one file, so the scenes' render clips are not touched. Normally run fit_scenes_to_narration first, especially when a new take changed length.",
    inputSchema: obj({ lead: { type: "number" }, loudness: { type: ["number", "string", "boolean"], description: "Target integrated loudness in LUFS (default -16), or \"off\" to keep the recording's own level" }, ...modelArg }, ["model"]),
    handler: (a, ctx) => ctx.video.buildSoundtrack(a),
  },
  {
    name: "list_takes", video: true,
    description: "The narration the reviewer recorded to camera in the Record view, per scene: every take (number, length, the camera and microphone it was recorded with, levels with maxDb, the sample peak: under about -24 dBFS the mic was too far or too low; the speech range found in it; segments: the take ranges the narration is made of when something was cut out; edits: what was cut and what was flagged; proposed: keep ranges not applied yet; stale: true when the script changed after it was read), the chosen one, stale for the chosen one, recordAgain (the reasons to record the scene again: a changed line, a restart or filler on camera), its narration audio (path and length), whether narration words exist for it (words: false means it still needs transcribing), and the camera clip assets/cam/<id>.mp4. The reviewer records first and fixes the script after, and does not read word for word. " + AFTER,
    inputSchema: obj(),
    handler: async (a, ctx) => ({ scenes: (await ctx.video.listTakes()).map((s) => ({ ...s, takes: s.takes.map((t) => ({ ...t, url: abs(ctx, t.url) })), audio: s.audio && { ...s.audio, url: abs(ctx, s.audio.url) }, cam: s.cam && { ...s.cam, url: abs(ctx, s.cam.url) } })) }),
  },
  {
    name: "choose_take", video: true,
    description: "Use another take of a scene (the Record view's Enter does this for the latest). Writes the scene's narration audio from the take's speech range (high-passed, gently denoised, not normalised: build_soundtrack does that) the same way set_narration_audio does, removes narration words timed on the previous take, and cuts assets/cam/<id>.mp4 so its t=0 is the scene's t=0. speechStart and speechEnd (take seconds) correct a speech range that was found wrong. keep: [[from, to], ...] take seconds makes the narration of several ranges instead (a restart or a filler left out: 40 ms crossfades in the audio, jump cuts in the camera clip); on the take already chosen its words are re-timed, no new transcription needed. Review a take's proposed or edits ranges in list_takes before you change them. Then transcribe the new audio with ElevenLabs Scribe, set_narration_words (it adopts what was said), re-anchor what its warnings name, fit_scenes_to_narration with this scene, build_soundtrack.",
    inputSchema: obj({ ...sceneArg, take: { type: "number", description: "Take number from list_takes" }, speechStart: { type: "number" }, speechEnd: { type: "number" }, keep: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 }, description: "Take ranges [from, to] in seconds, in order, that make the narration" }, ...modelArg }, ["scene", "take"]),
    handler: ({ scene, take, ...a }, ctx) => ctx.video.chooseTake(scene, take, a),
  },
  {
    name: "delete_takes", video: true,
    description: "Delete recorded takes that are not in use, to clear out old ones: the numbered takes of a scene, every take of a scene but the chosen one (unused: true), or with no scene and unused: true, every unused take in the video. The chosen take is never deleted (choose another first). The files are deleted, not versioned.",
    inputSchema: obj({ scene: { type: "string", description: "Scene id; leave out with unused: true for every scene" }, takes: { type: "array", items: { type: "number" }, description: "Take numbers from list_takes" }, unused: { type: "boolean", description: "Every take but the chosen one" }, ...modelArg }),
    handler: ({ scene, ...a }, ctx) => ctx.video.deleteTakes(scene, a),
  },
  {
    name: "keep_take", video: true,
    description: "Keep a recorded scene's take as it is instead of recording again: after a small text fix (a typo or a name's spelling in the adopted narration) the audio and the chosen take count as read from the current narration, and the narration words keep their times with the new spelling; a restart or filler flagged on camera is accepted (its comment is closed). When the script has words the take does not, they come back in unmatched with a warning: record the scene again instead. The Script view and the Record view (K) offer the same.",
    inputSchema: obj({ ...sceneArg, force: { type: "boolean", description: "Keep the take even though more than spelling changed (the video keeps saying what the take says)" }, ...modelArg }, ["scene"]),
    handler: ({ scene, ...a }, ctx) => ctx.video.keepTake(scene, a),
  },
  {
    name: "add_take", video: true,
    description: "Add a recording made outside the Record view (an absolute path on the server: mp4, mov, webm, or audio only: m4a, wav, mp3) as the scene's next take. It is analysed like a recorded one; choose_take makes it the narration.",
    inputSchema: obj({ ...sceneArg, path: { type: "string", description: "Absolute path to the recording on the server" }, ...modelArg }, ["scene", "path"]),
    handler: ({ scene, path, model }, ctx) => ctx.video.addTake(scene, { path, model }),
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
  {
    name: "delete_renders", video: true,
    description: "Delete finished renders (the mp4 files under renders/): the named files from get_render, or with keep: n every render but the newest n (keep: 1 leaves the latest). The files are deleted, not versioned.",
    inputSchema: obj({ files: { type: "array", items: { type: "string" }, description: "File names from get_render, e.g. whole-2026-10-22-15-40.mp4" }, keep: { type: "number", description: "Delete every render but the newest n" }, ...modelArg }),
    handler: (a, ctx) => ctx.video.deleteRenders(a),
  },
  ...CLIP_TOOLS,
  ...LIBRARY_TOOLS,
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
  // A person's own MCP token or OAuth login: their agents' writes carry the name, in the
  // version, the activity log and the history, as "claude-opus (Anna)".
  if (ctx.person && tool.inputSchema?.properties?.model) args = { ...args, model: `${args?.model || "chat"} (${ctx.person})` };
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
