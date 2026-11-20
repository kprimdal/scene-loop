import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,cpSync,rmSync,writeFileSync,readdirSync,readlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {TEMPLATE_DIR} from '../lib/projects.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const openHandles=(pid,file)=>readdirSync(`/proc/${pid}/fd`).filter(fd=>{try{return readlinkSync(`/proc/${pid}/fd/${fd}`)===file;}catch{return false;}}).length;

// A player that seeks or closes aborts its request. The server must close the file then: on a
// network share an open file cannot be replaced, and the soundtrack stayed "delete pending".
test('an aborted file request does not leave the file open',{timeout:30000,skip:!existsSync('/proc/self/fd')},async t=>{
  const root=mkdtempSync(join(tmpdir(),'sl-serve-file-'));cpSync(TEMPLATE_DIR,join(root,'one','videos','demo'),{recursive:true});
  const file=join(root,'one','videos','demo','assets','big.m4a');mkdirSync(join(root,'one','videos','demo','assets'),{recursive:true});writeFileSync(file,Buffer.alloc(8*1024*1024,1));
  const port=await new Promise(r=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});const base=`http://127.0.0.1:${port}`;
  const server=spawn(process.execPath,['server.mjs',root,'--port',String(port)],{cwd:join(import.meta.dirname,'..'),env:{...process.env,SCENE_LOOP_PASSWORD:'scratch password only',SCENE_LOOP_SECRET:'scratch-serve-file'},stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',d=>logs+=d);
  t.after(async()=>{server.kill();if(server.exitCode===null)await new Promise(r=>server.once('exit',r));rmSync(root,{recursive:true,force:true});});
  while(!logs.includes('Login on')){if(server.exitCode!==null)throw new Error(logs);await delay(20);}
  const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:base},body:new URLSearchParams({password:'scratch password only'})});assert.equal(login.status,302);
  const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  for(const range of [null,'bytes=0-']){
    await new Promise((ok,fail)=>{const req=request(base+'/p/one/demo/assets/big.m4a',{headers:{Cookie:cookie,...(range?{Range:range}:{})}},res=>{assert.equal(res.statusCode,range?206:200);res.once('data',()=>{req.destroy();ok();});});req.on('error',e=>e.code==='ECONNRESET'?ok():fail(e));req.end();});
    let open=1;for(let i=0;i<50&&open;i++){await delay(40);open=openHandles(server.pid,file);}
    assert.equal(open,0,`${range??'whole file'}: the server still holds the file open after the client went away`);
  }
});
