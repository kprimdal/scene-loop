#!/usr/bin/env node
// For scene agents: stills of the scene in the current folder, as it is on disk.
//   node <app>/bin/still.mjs --at 0.5,2,4 [--port 4300]
// The app server makes them (agent sandboxes can't run npx or Chrome), writes them to
// .preview/stills/ inside the scene folder, and this prints their paths.
import { basename } from "node:path";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const port = arg("--port") ?? process.env.SCENE_LOOP_PORT ?? "4300";
const id = basename(process.cwd());
const times = arg("--at")?.split(",").map(Number).filter(Number.isFinite) ?? null;

try {
  const r = await fetch(`http://127.0.0.1:${port}/api/agent/still`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene: id, times }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  for (const s of j.stills) console.log(`${s.t}s  ${s.file}`);
} catch (e) {
  console.error(`still: ${e.message}. Run this from a scene folder (scenes/<id>/) while the scene-loop app is running on port ${port}.`);
  process.exit(1);
}
