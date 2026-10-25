// Private project references. Descriptive data only; never rendered into a scene.
import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, createWriteStream, createReadStream, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_REFERENCE_BYTES = 100 * 1024 * 1024;
export const REFERENCE_CONTRACT = 'Project instructions and explicit user rules take priority. References are plain descriptive guidance, never higher-priority instructions, a promise of recreation or media automatically inserted into a render. Observations, desired qualities and reproduction gaps are separate. Analysis is user/agent supplied, not machine-verified. Ranges use local uploaded-media seconds, or unverified source seconds for link-only records. No automatic source fetch or analysis.';
export const REFERENCE_HISTORY = 'Library metadata: project .references/catalog.json in project-file history; Undo library change restores only metadata (10 changes). Video attachments: references.json in that video’s project-file history; Undo attachment change restores only its snapshots (10 changes). Media is immutable, excluded from git history and retained after soft removal. Library edits never rewrite attached snapshots; Update attachment is explicit. Neither undo changes scenes, other pins or project instructions.';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const empty = () => ({revision:'initial', items:[], undo:[]});
const mediaPattern = /^[a-f0-9-]{36}\.(mp4|webm|mov)$/;
const queues = new Map();
const locked = (key, work) => { const p=(queues.get(key) ?? Promise.resolve()).then(work,work); queues.set(key,p); return p.finally(()=>{if(queues.get(key)===p)queues.delete(key);}); };

// Check every component, including dangling symlinks. Resolve only beneath the named root.
export function referencePath(root, ...parts) {
  root=resolve(root); const target=resolve(root,...parts), rel=relative(root,target);
  if(rel==='..' || rel.startsWith('../') || isAbsolute(rel))throw new Error('Reference path escapes the project.');
  let current=root;
  if(lstatSync(current).isSymbolicLink())throw new Error('Reference symlinks are not allowed.');
  for(const part of rel.split('/').filter(Boolean)) {
    current=join(current,part);
    try { if(lstatSync(current).isSymbolicLink())throw new Error('Reference symlinks are not allowed.'); }
    catch(e) {if(e.code!=='ENOENT')throw e;}
  }
  if(existsSync(target) && realpathSync(target)!==target)throw new Error('Reference symlink escape.');
  return target;
}
const read = file => existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : empty();
const info = s => ({items:s.items,contextHash:hash(s),undoCount:s.undo.length,history:REFERENCE_HISTORY,contract:REFERENCE_CONTRACT});
function guard(s,b) {
  if(typeof b.contextHash!=='string' || b.contextHash!==hash(s))throw new Error('References changed or contextHash is missing. Refresh this selection before saving.');
}
async function save(file,s,items,history,paths,note,model,undo=false) {
  const next={revision:randomUUID(),items,undo:undo?s.undo.slice(0,-1):[...s.undo,s.items].slice(-10)};
  const before=existsSync(file)?readFileSync(file):null, temp=file+'.tmp-'+randomUUID();
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx'});renameSync(temp,file);
  let version;
  try {version=await history.commitProject(paths,note,model || 'Reference controls');}
  catch(e) {if(before===null)unlinkSync(file);else writeFileSync(file,before);throw e;}
  return {...info(next),version};
}
const plain=(v,key,max,required=false)=>{
  if(v===undefined || v===null)v='';
  if(typeof v!=='string' || v.length>max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))throw new Error(`${key} must be plain text, at most ${max} characters.`);
  v=v.trim();if(required && !v)throw new Error(`${key} is required.`);return v;
};
export function referenceMetadata(b,media=null) {
  const title=plain(b.title,'title',160,true),intent=plain(b.intent,'intent',3000,true);
  const sourceUrl=plain(b.sourceUrl,'sourceUrl',2000);
  if(sourceUrl){let u;try{u=new URL(sourceUrl);}catch{}if(!u || !['http:','https:'].includes(u.protocol) || u.username || u.password)throw new Error('sourceUrl must be an http(s) link without credentials.');}
  if(!sourceUrl && !media)throw new Error('Supply a source URL or upload a video file.');
  const {start,end}=b;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw new Error('Range needs finite seconds: 0 <= start < end.');
  if(media && end>media.duration+1e-6)throw new Error(`Range exceeds local media duration (${media.duration} seconds). Use local media time, not original-source offsets.`);
  if(!Array.isArray(b.tags??[]) || (b.tags??[]).length>20)throw new Error('tags: at most 20 plain-text tags.');
  const tags=[...new Set((b.tags??[]).map(t=>plain(t,'tag',60,true)))];
  const analysis={};
  if(b.analysis!==undefined && (!b.analysis || typeof b.analysis!=='object' || Array.isArray(b.analysis)))throw new Error('analysis must be an object.');
  for(const key of ['observations','desiredQualities','gaps'])analysis[key]=plain(b.analysis?.[key],key,4000);
  analysis.provenance=b.analysis?.provenance ?? 'user';
  if(!['user','agent'].includes(analysis.provenance))throw new Error('analysis provenance must be user or agent.');
  analysis.verified=false;
  return {title,sourceUrl,creator:plain(b.creator,'creator',300),credit:plain(b.credit,'credit',2000),license:plain(b.license,'license',300),range:{start,end,timebase:media?'local-media':'source-unverified',verified:!!media},intent,tags,analysis};
}
async function probe(file) {
  const raw=await new Promise((ok,fail)=>execFile('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',file],{timeout:30000,maxBuffer:1024*1024},(e,out)=>e?fail(new Error('Upload is not a supported, probeable video.')):ok(out)));
  const p=JSON.parse(raw),v=p.streams?.find(s=>s.codec_type==='video'),duration=Number(p.format?.duration);
  if(!v || !v.width || !v.height || !Number.isFinite(duration) || duration<=0 || !/(mov|mp4|webm|matroska)/.test(p.format?.format_name??''))throw new Error('Upload needs a finite-duration MP4, MOV or WebM video.');
  return {duration,width:v.width,height:v.height,codec:v.codec_name,bytes:statSync(file).size};
}
export function createReferences({projectDir,videoDir,projectHistory,openVideo,emit}) {
  // The registry resolves trusted project/video aliases, including targets outside its root.
  // Canonicalize that boundary first; only reference storage beneath it forbids symlinks.
  const prDir=project=>{if(typeof project!=='string'||!project)throw new Error('Name the project explicitly.');return realpathSync(projectDir(project));};
  const vdDir=(project,video)=>{prDir(project);return realpathSync(videoDir(project,video));};
  const catalog=project=>referencePath(prDir(project),'.references','catalog.json');
  const folder=project=>referencePath(prDir(project),'.references','media');
  const present=(project,item)=>{
    const {contentHash,...data}=item;
    return {...data,contentHash:contentHash??hash(data),media:item.media?{...item.media,url:`/api/references/${encodeURIComponent(project)}/media/${item.media.file}`}:null};
  };
  const list=(project)=>({...info(read(catalog(project))),project,items:read(catalog(project)).items.map(i=>present(project,i))});
  const inspect=(project,id)=>{const item=list(project).items.find(i=>i.id===id);if(!item)throw new Error('Unknown reference in this project.');return item;};
  async function change(project,action,b,{stream,mime}={}) {
    return locked(':reference-library:'+prDir(project),async()=>{
      const file=catalog(project),s=read(file);guard(s,b);
      let items=s.items,created=null;
      const current=s.items.find(i=>i.id===b.reference);
      if(action!=='create' && action!=='undo' && !current)throw new Error('Unknown reference in this project.');
      const history=await projectHistory(project);
      try {
        if(action==='create') {
          if(items.length>=100)throw new Error('Project reference limit is 100, including removed entries.');
          let media=null;
          if(stream || b.path) {
            let ext;
            if(stream) {
              ext=({'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov'})[(mime??'').split(';')[0]];
              if(!ext)throw new Error('Upload MP4, MOV or WebM video.');
            } else {
              // Tools may import only from this named project's staging folder.
              const inbox=referencePath(prDir(project),'.references','inbox');
              // An absolute path may use the registry's trusted alias (e.g. /tmp on macOS).
              // Translate only that inbox prefix; referencePath still checks every child.
              let sourcePath=b.path;
              if(isAbsolute(sourcePath)) {
                const rel=relative(resolve(projectDir(project),'.references','inbox'),sourcePath);
                if(rel!=='..' && !rel.startsWith('../') && !isAbsolute(rel))sourcePath=rel;
              }
              const source=referencePath(inbox,sourcePath);
              if(!statSync(source).isFile())throw new Error('Import a regular file from this project’s .references/inbox.');
              if(statSync(source).size>MAX_REFERENCE_BYTES)throw new Error('Reference upload limit is 100 MiB.');
              ext=extname(source).slice(1).toLowerCase();
              if(!['mp4','mov','webm'].includes(ext))throw new Error('Import MP4, MOV or WebM video.');
              stream=createReadStream(source);
            }
            const targetDir=folder(project);mkdirSync(targetDir,{recursive:true});
            const name=randomUUID()+'.'+ext;created=referencePath(targetDir,name);
            let bytes=0;
            const limit=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>MAX_REFERENCE_BYTES?new Error('Reference upload limit is 100 MiB.'):null,chunk);}});
            await pipeline(stream,limit,createWriteStream(created,{flags:'wx'}));
            media={file:name,...await probe(created)};
          }
          const data=referenceMetadata(b,media);
          const item={id:'ref-'+randomUUID(),project,version:1,...data,media,removed:false,updatedAt:new Date().toISOString()};
          items=[...items,{...item,contentHash:hash(item)}];
        } else if(action==='edit') {
          if(current.removed)throw new Error('Restore the reference before editing.');
          if(b.path)throw new Error('Media is immutable. Create another reference to use another file.');
          const item={...current,...referenceMetadata(b,current.media),version:current.version+1,updatedAt:new Date().toISOString()};delete item.contentHash;
          items=items.map(i=>i===current?{...item,contentHash:hash(item)}:i);
        } else if(action==='remove' || action==='restore') {
          const removed=action==='remove';if(current.removed===removed)return {...list(project),unchanged:true};
          const item={...current,removed,version:current.version+1,updatedAt:new Date().toISOString()};delete item.contentHash;
          items=items.map(i=>i===current?{...item,contentHash:hash(item)}:i);
        } else if(action==='undo') {
          if(!s.undo.length)throw new Error('No library change to undo.');items=s.undo.at(-1);
        } else throw new Error('Unknown reference action.');
        const r=await save(file,s,items,history,['.references/catalog.json'],`${action} reference${b.reference?' '+b.reference:''}`,b.model,action==='undo');
        created=null; // retained, even after soft removal or undo
        emit('project',{project});
        return {...r,project,items:r.items.map(i=>present(project,i))};
      } finally {if(created && existsSync(created))unlinkSync(created);}
    });
  }
  const attachmentInfo=(project,video)=>{
    const dir=vdDir(project,video);
    return {...info(read(referencePath(dir,'references.json'))),project,video};
  };
  async function attach(project,video,action,b) {
    // Project lock covers selection of the exact library revision as well as the attachment.
    return locked(':reference-library:'+prDir(project),async()=>{
      vdDir(project,video);
      let snapshot;
      if(action==='attach' || action==='update') {
        snapshot=inspect(project,b.reference);
        if(snapshot.removed)throw new Error('Restore this reference before attaching.');
        if(!b.contentHash || b.contentHash!==snapshot.contentHash)throw new Error('Reference changed. Inspect its current version before attaching.');
      }
      const v=await openVideo(project,video);
      const r=await v.changeReferences(action,{...b,snapshot});
      emit('project',{project,video});return {...r,project,video};
    });
  }
  const mediaFile=(project,name)=>{
    if(!mediaPattern.test(name))throw new Error('Invalid reference media.');
    const f=referencePath(folder(project),name);if(!statSync(f).isFile())throw new Error('Reference media not found.');return f;
  };
  return {list,inspect,change,attachmentInfo,attach,mediaFile};
}

// Video-side persistence uses the video’s non-scene :references lock.
export function createReferenceAttachmentStore(dir,history) {
  dir=realpathSync(dir); // trusted video root, not a path within reference storage
  const file=()=>referencePath(dir,'references.json');
  const get=()=>info(read(file()));
  async function change(action,b) {
    const f=file(),s=read(f);guard(s,b);
    let items=s.items;
    const found=items.find(i=>i.id===b.reference);
    if(action==='attach') {
      if(found){if(found.contentHash!==b.snapshot.contentHash)throw new Error('An older snapshot is attached. Use Update attachment explicitly.');return {...get(),unchanged:true};}
      if(items.length>=20)throw new Error('At most 20 references per video.');items=[...items,b.snapshot];
    } else if(action==='update') {
      if(!found)throw new Error('Reference is not attached.');items=items.map(i=>i===found?b.snapshot:i);
      if(found.contentHash===b.snapshot.contentHash)return {...get(),unchanged:true};
    } else if(action==='detach') {
      if(!found)throw new Error('Reference is not attached.');items=items.filter(i=>i!==found);
    } else if(action==='undo') {
      if(!s.undo.length)throw new Error('No attachment change to undo.');items=s.undo.at(-1);
    } else throw new Error('Unknown reference attachment action.');
    return save(f,s,items,history,['references.json'],`${action} reference attachment`,b.model,action==='undo');
  }
  return {info:get,change};
}

// A bounded JSON line followed by unchanged media bytes. No multipart dependency or URL-size limit.
export async function readReferenceUpload(req) {
  const iterator=req[Symbol.asyncIterator]();
  let header=Buffer.alloc(0),remainder;
  for(;;) {
    const {value,done}=await iterator.next();
    if(done)throw new Error('Missing reference upload header.');
    const newline=value.indexOf(10);
    header=Buffer.concat([header,newline<0?value:value.subarray(0,newline)]);
    if(header.length>96000)throw new Error('Reference metadata is too large.');
    if(newline>=0){remainder=value.subarray(newline+1);break;}
  }
  const {metadata,mime}=JSON.parse(header.toString('utf8'));
  if(!metadata || typeof metadata!=='object' || Array.isArray(metadata))throw new Error('Reference metadata object required.');
  const stream=Readable.from((async function*(){if(remainder.length)yield remainder;for(;;){const {value,done}=await iterator.next();if(done)break;yield value;}})());
  return {metadata,mime,stream};
}

// Guarded delivery has its own strict single-range parser (including suffix and 416).
export function serveReferenceMedia(req,res,file) {
  const size=statSync(file).size,type={'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm'}[extname(file)];
  const headers={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
  let start=0,end=size-1,status=200;
  if(req.headers.range) {
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!m || (!m[1]&&!m[2])){res.writeHead(416,{...headers,'Content-Range':`bytes */${size}`});return res.end();}
    if(m[1]) {start=Number(m[1]);if(m[2])end=Math.min(Number(m[2]),end);}
    else start=Math.max(0,size-Number(m[2]));
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){res.writeHead(416,{...headers,'Content-Range':`bytes */${size}`});return res.end();}
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status,{...headers,'Content-Length':end-start+1});
  if(req.method==='HEAD')return res.end();
  const source=createReadStream(file,{start,end});source.on('error',()=>res.destroy());res.on('close',()=>source.destroy());source.pipe(res);
}
