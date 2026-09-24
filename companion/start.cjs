'use strict';
// User-run launcher: closing the launcher window must not stop report downloads.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {BUILD}=require('./config.cjs');
const ROOT=path.resolve(__dirname,'..');
function sessionState(status,value){
  if(status!==200||!value||value.version!==1||typeof value.token!=='string'||!value.token)return 'occupied';
  return value.build===BUILD&&value.browser==='chrome'?'ready':'outdated';
}
function probe(port=5173) {
  return new Promise(resolve=>{
    const req=http.get({host:'127.0.0.1',port,path:'/api/b2b/session',timeout:1000},res=>{
      let body='';res.on('data',chunk=>{if(body.length<4096)body+=chunk;});
      res.on('end',()=>{try{resolve(sessionState(res.statusCode,JSON.parse(body)));}catch{resolve('occupied');}});
      res.on('error',()=>resolve('occupied'));
    });
    req.on('timeout',()=>req.destroy());req.on('error',()=>resolve('offline'));
  });
}
function restartVerified({root=ROOT,port=5173,run=execFile,platform=process.platform}={}){
  if(platform!=='win32')return Promise.reject(new Error('The old HEDAX companion must be closed before this version can start.'));
  return new Promise((resolve,reject)=>{
    const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    run(executable,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'companion','restart.ps1')],{
      cwd:root,windowsHide:true,timeout:15000,maxBuffer:4096,
      env:{...process.env,HEDAX_RESTART_ROOT:path.resolve(root),HEDAX_RESTART_PORT:String(port)}
    },error=>error?reject(new Error('The old companion could not be verified and closed. Close HEDAX and run start-hedax.cmd again.')):resolve());
  });
}
async function ensureStarted({port=5173,root=ROOT,start=spawn,check=probe,restart=restartVerified,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const initial=await check(port);
  if(initial==='ready')return {existing:true};
  if(initial==='occupied')throw new Error('Port '+port+' is used by another program. Close that preview and retry.');
  if(initial==='outdated'){
    await restart({root,port});
    let stopped=false;
    for(let attempt=0;attempt<20;attempt++){
      const state=await check(port);
      if(state==='offline'){stopped=true;break;}
      if(state==='ready')return {existing:true};
      if(state==='occupied')throw new Error('The local port is occupied by another program.');
      await pause(250);
    }
    if(!stopped)throw new Error('The old HEDAX companion did not close. No new companion was started.');
  }
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
    if(state==='outdated')throw new Error('An outdated HEDAX companion is still running. No additional companion was started.');
    await pause(500);
  }
  throw new Error('HEDAX did not become ready. Check .local/companion.log in the project folder.');
}
if(require.main===module)ensureStarted().then(()=>console.log('HEDAX: http://localhost:5173/')).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={probe,sessionState,restartVerified,ensureStarted};
