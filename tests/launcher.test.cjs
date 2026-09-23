'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {ensureStarted}=require('../companion/start.cjs');

// Only injected child/process checks run; this suite never launches a server.
function temporaryRoot(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hedax-launcher-synthetic-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
const neverStart=()=>assert.fail('No child should be started');
const noWait=async()=>assert.fail('No polling delay should be needed');

test('an existing companion is reused without spawning or creating a log',async t=>{
  const root=temporaryRoot(t);let checked=0;
  const result=await ensureStarted({root,port:5190,start:neverStart,pause:noWait,check:async port=>{assert.equal(port,5190);checked++;return 'ready';}});
  assert.deepEqual(result,{existing:true});assert.equal(checked,1);
  assert.equal(fs.existsSync(path.join(root,'.local')),false);
});

test('a port occupied by another application is refused before spawning',async t=>{
  const root=temporaryRoot(t);
  await assert.rejects(ensureStarted({root,port:5190,start:neverStart,pause:noWait,check:async()=> 'occupied'}),/5190.*another program/);
  assert.equal(fs.existsSync(path.join(root,'.local')),false);
});

test('a detached hidden companion is considered started only after readiness; append log handles are closed',async t=>{
  const root=temporaryRoot(t),states=['offline','offline','ready'];
  const logDir=path.join(root,'.local'),logPath=path.join(logDir,'companion.log');
  fs.mkdirSync(logDir);fs.writeFileSync(logPath,'Earlier synthetic startup\n');
  let spawnCount=0,unreferenced=false,logHandle,paused=0;
  const result=await ensureStarted({root,port:5190,
    check:async port=>{assert.equal(port,5190);assert.ok(states.length);return states.shift();},
    pause:async ms=>{assert.equal(ms,500);paused++;},
    start:(executable,args,options)=>{
      spawnCount++;assert.equal(executable,process.execPath);
      assert.deepEqual(args,[path.join(root,'companion','server.cjs')]);
      assert.equal(options.cwd,root);assert.equal(options.env.HEDAX_PORT,'5190');
      assert.equal(options.detached,true);assert.equal(options.windowsHide,true);
      assert.equal(options.stdio[0],'ignore');assert.equal(options.stdio[1],options.stdio[2]);
      logHandle=options.stdio[1];fs.writeSync(logHandle,'New synthetic startup\n');
      return {on(event,listener){assert.equal(event,'error');assert.equal(typeof listener,'function');},unref(){unreferenced=true;}};
    }
  });
  assert.deepEqual(result,{existing:false});assert.equal(spawnCount,1);assert.ok(unreferenced);
  assert.equal(paused,1);assert.equal(states.length,0);
  assert.equal(fs.readFileSync(logPath,'utf8'),'Earlier synthetic startup\nNew synthetic startup\n');
  assert.throws(()=>fs.fstatSync(logHandle),{code:'EBADF'});
});

test('an asynchronous spawn failure is reported without echoing sensitive error details',async t=>{
  const root=temporaryRoot(t);let onError,logHandle,paused=0;
  const secret='SYNTHETIC-SECRET-DO-NOT-ECHO';
  await assert.rejects(ensureStarted({root,
    check:async()=> 'offline',
    start:(_exe,_args,options)=>{logHandle=options.stdio[1];return {on(event,listener){assert.equal(event,'error');onError=listener;},unref(){}};},
    pause:async()=>{paused++;onError(new Error(secret));}
  }),error=>error.message.includes('could not start')&&!error.message.includes(secret));
  assert.equal(paused,1);assert.throws(()=>fs.fstatSync(logHandle),{code:'EBADF'});
  assert.equal(fs.readFileSync(path.join(root,'.local','companion.log'),'utf8'),'');
});

test('startup timeout is bounded and gives the local log location without repeatedly spawning',async t=>{
  const root=temporaryRoot(t);let checked=0,spawnCount=0,paused=0;
  await assert.rejects(ensureStarted({root,
    check:async()=>{checked++;return 'offline';},
    start:()=>{spawnCount++;return {on(){},unref(){}};},
    pause:async ms=>{assert.equal(ms,500);paused++;}
  }),/did not become ready.*\.local\/companion\.log/);
  assert.equal(checked,25);assert.equal(paused,24);assert.equal(spawnCount,1);
});

test('a different application taking the port during startup ends polling without another spawn',async t=>{
  const root=temporaryRoot(t),states=['offline','occupied'];let spawnCount=0;
  await assert.rejects(ensureStarted({root,
    check:async()=>states.shift(),pause:noWait,
    start:()=>{spawnCount++;return {on(){},unref(){}};}
  }),/occupied by another program/);
  assert.equal(spawnCount,1);assert.equal(states.length,0);
});
