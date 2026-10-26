#!/usr/bin/env node
// Check a scene-loop library folder before it is committed: every card, format and source
// must load. Prints what is wrong per file and exits 1 when anything is.
//
//   node bin/check-library.mjs [libraryDir]     (default: the starter library)
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadLibrary, STARTER } from "../lib/cards.mjs";

const dir = resolve(process.argv[2] ?? STARTER);
if (!existsSync(`${dir}/library.json`)) { console.error(`${dir} has no library.json`); process.exit(1); }
const lib = loadLibrary(dir);
const kinds = Object.entries(lib.cards.reduce((n, c) => ({ ...n, [c.kind]: (n[c.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(", ");
console.log(`${lib.title}: ${lib.cards.length} cards (${kinds || "none"}), ${lib.formats.length} formats, ${lib.sources.length} sources, ${lib.stages.length} stages`);
for (const e of lib.errors) console.error(`\n${e.file.replace(dir + "/", "")}\n  ${e.problems.join("\n  ")}`);
process.exit(lib.errors.length ? 1 : 0);
