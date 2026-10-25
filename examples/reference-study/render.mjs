// Run from this repository: node examples/reference-study/render.mjs /tmp/sl-reference-study /tmp/reference-attempt.mp4
import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWhole } from '../../lib/assemble.mjs';
import { renderClip } from '../../lib/render.mjs';

const [projectArg, outputArg] = process.argv.slice(2);
if (!projectArg || !outputArg) throw new Error('Pass the scratch project directory and output MP4 path.');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const outside = (path) => { const r = relative(repo, path); return r === '..' || r.startsWith('..' + sep); };
const project = resolve(projectArg), output = resolve(outputArg);
if (!outside(project) || !outside(output)) throw new Error('Keep scratch projects and generated media outside the repository.');
const sb = JSON.parse(readFileSync(resolve(project, 'storyboard.json'), 'utf8'));
const html = Object.fromEntries(sb.scenes.map(s => [s.id, readFileSync(resolve(project, 'scenes', s.id, 'scene.html'), 'utf8')]));
const build = buildWhole(project, sb, html, 'reference-study');
const result = await renderClip(build, output, { duration: sb.duration, fps: sb.fps, width: sb.width, height: sb.height });
console.log(JSON.stringify(result, null, 2));
// The renderer keeps a shared Chrome idle timer. This standalone command has completed all work.
process.exit(0);
