// Small storage helpers for cleanup. Sources are never modified. The journal rolls back an
// interrupted multi-file selection at the next open; preparation never writes selected media.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, rmSync, realpathSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, sep } from 'node:path';

export function noisePath(dir, path) {
  const root = realpathSync(dir), target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw new Error('Cleanup path escapes video');
  let at = root;
  for (const part of relative(root, target).split(sep)) {
    at = join(at, part);
    let st;
    try { st = lstatSync(at); } catch(e) { if (e.code !== 'ENOENT') throw e; }
    if (st?.isSymbolicLink()) throw new Error('Cleanup storage cannot contain symlinks');
  }
  return target;
}
export function noiseHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
// Repeated inspection of a long original need not decode/read it again. Nanosecond ctime
// detects same-size replacements even if an external editor restores its mtime.
const hashCache = new Map();
export function mediaHash(file) {
  if (!existsSync(file)) return null;
  const st = statSync(file,{bigint:true});
  const signature = [st.dev,st.ino,st.size,st.mtimeNs,st.ctimeNs].join(':');
  const cached = hashCache.get(file);
  if (cached?.signature === signature) return cached.hash;
  const hash = createHash('sha256'), fd = openSync(file, 'r'), buf = Buffer.alloc(256 * 1024);
  try { for (let n; (n = readSync(fd, buf)) > 0;) hash.update(buf.subarray(0, n)); }
  finally { closeSync(fd); }
  const result = hash.digest('hex');
  if (hashCache.size > 256) hashCache.clear();
  hashCache.set(file,{signature,hash:result});
  return result;
}
export function noiseJson(file, fallback = null) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; }
export function noiseWrite(file, value) {
  mkdirSync(dirname(file), {recursive:true});
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); renameSync(tmp, file); }
  finally { rmSync(tmp, {force:true}); }
}
export function recoverNoise(dir) {
  const journal = noisePath(dir, '.state/noise/transaction.json');
  const tx = noiseJson(journal);
  if (!tx) return;
  for (const e of tx.entries) {
    const target = noisePath(dir, e.target);
    if (e.backup) {
      const temp = noisePath(dir, e.target + '.noise-recovery');
      copyFileSync(noisePath(dir, e.backup), temp); renameSync(temp, target);
    } else rmSync(target, {force:true});
  }
  rmSync(journal);
}
export function selectNoiseFiles(dir, replacements) {
  const journal = noisePath(dir, '.state/noise/transaction.json');
  const backupDir = '.state/noise/recovery/' + randomUUID();
  mkdirSync(noisePath(dir, backupDir), {recursive:true});
  const entries = replacements.map(([target], i) => {
    const backup = existsSync(noisePath(dir, target)) ? `${backupDir}/${i}` : null;
    if (backup) copyFileSync(noisePath(dir, target), noisePath(dir, backup));
    return {target, backup};
  });
  noiseWrite(journal, {entries});
  try {
    for (const [target, source] of replacements) {
      const file = noisePath(dir, target), tmp = noisePath(dir, target + '.noise-select');
      mkdirSync(dirname(file), {recursive:true});
      if (source == null) rmSync(file, {force:true});
      else { copyFileSync(noisePath(dir, source), tmp); renameSync(tmp, file); }
    }
    rmSync(journal);
  } catch (e) { recoverNoise(dir); throw e; }
  finally { if (!existsSync(journal)) rmSync(noisePath(dir, backupDir), {recursive:true, force:true}); }
}
