'use strict';
// User-run launcher: closing the launcher window must not stop report downloads.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
function probe(port=5173) {
  return new Promise(resolve=>{
    const req=http.get({host:'127.0.0.1',port,path:'/api/b2b/session',timeout:1000},res=>{
      let body='';res.on('data',chunk=>{if(body.length<4096)body+=chunk;});
      res.on('end',()=>{try{const value=JSON.parse(body);resolve(res.statusCode===200&&value.version===1&&typeof value.token==='string'?'ready':'occupied');}catch{resolve('occupied');}});
      res.on('error',()=>resolve('occupied'));
    });
    req.on('timeout',()=>req.destroy());req.on('error',()=>resolve('offline'));
  });
}
async function ensureStarted({port=5173,root=ROOT,start=spawn,check=probe,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const initial=await check(port);
  if(initial==='ready')return {existing:true};
  if(initial==='occupied')throw new Error('Port '+port+' is used by another program. Close that preview and retry.');
  const logDir=path.join(root,'.local');fs.mkdirSync(logDir,{recursive:true});
  const log=fs.openSync(path.join(logDir,'companion.log'),'a');let child,error;
  try{
    child=start(process.execPath,[path.join(root,'companion','server.cjs')],{
      cwd:root,env:{...process.env,HEDAX_PORT:String(port)},detached:true,windowsHide:true,stdio:['ignore',log,log]
    });
    child.on('error',()=>{error=true;});child.unref();
  }finally{fs.closeSync(log);}
  for(let attempt=0;attempt<24;attempt++){
    if(error)throw new Error('HEDAX could not start. Run start-hedax.cmd directly from Windows.');
    const state=await check(port);
    if(state==='ready')return {existing:false};
    if(state==='occupied')throw new Error('The local port is occupied by another program.');
    await pause(500);
  }
  throw new Error('HEDAX did not become ready. Check .local/companion.log in the project folder.');
}
if(require.main===module)ensureStarted().then(()=>console.log('HEDAX: http://localhost:5173/')).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={probe,ensureStarted};
