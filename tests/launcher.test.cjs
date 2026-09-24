'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {ensureStarted,sessionState,restartVerified}=require('../companion/start.cjs');
const {BUILD}=require('../companion/config.cjs');

// Only injected child/process checks run; this suite never launches a server.
function temporaryRoot(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hedax-launcher-synthetic-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
const neverStart=()=>assert.fail('No child should be started');
const noWait=async()=>assert.fail('No polling delay should be needed');

test('readiness requires this build and Chrome; a recognized old session is outdated',()=>{
  const current={version:1,token:'synthetic-token',build:BUILD,browser:'chrome'};
  assert.equal(sessionState(200,current),'ready');
  for(const value of [{version:1,token:'synthetic-old'}, {...current,build:'old'}, {...current,browser:'msedge'}])assert.equal(sessionState(200,value),'outdated');
  for(const value of [null,{}, {...current,token:''}, {...current,token:1}, {...current,version:2}])assert.equal(sessionState(200,value),'occupied');
  assert.equal(sessionState(404,current),'occupied');
});

test('an existing companion is reused without spawning or creating a log',async t=>{
  const root=temporaryRoot(t);let checked=0;
  const result=await ensureStarted({root,port:5190,start:neverStart,pause:noWait,check:async port=>{assert.equal(port,5190);checked++;return 'ready';}});
  assert.deepEqual(result,{existing:true});assert.equal(checked,1);
  assert.equal(fs.existsSync(path.join(root,'.local')),false);
});

test('a port occupied by another application is refused before spawning',async t=>{
  const root=temporaryRoot(t);
  await assert.rejects(ensureStarted({root,port:5190,start:neverStart,restart:async()=>assert.fail('A foreign service must never be stopped'),pause:noWait,check:async()=> 'occupied'}),/5190.*another program/);
  assert.equal(fs.existsSync(path.join(root,'.local')),false);
});

test('an outdated companion is verified once and the port becomes free before the new server starts',async t=>{
  const root=temporaryRoot(t),states=['outdated','outdated','offline','ready'],events=[];
  const result=await ensureStarted({root,port:5190,
    check:async()=>{const state=states.shift();events.push(state);return state;},
    restart:async args=>{assert.deepEqual(args,{root,port:5190});events.push('verified restart');},
    pause:async ms=>{assert.equal(ms,250);events.push('wait');},
    start:()=>{events.push('spawn');return {on(){},unref(){}};}
  });
  assert.deepEqual(result,{existing:false});
  assert.deepEqual(events,['outdated','verified restart','outdated','wait','offline','spawn','ready']);
});

test('failed process verification never starts another server or creates its log',async t=>{
  const root=temporaryRoot(t);let restarts=0;
  await assert.rejects(ensureStarted({root,start:neverStart,check:async()=> 'outdated',pause:noWait,
    restart:async()=>{restarts++;throw Error('Process identity did not match');}
  }),/identity did not match/);
  assert.equal(restarts,1);assert.equal(fs.existsSync(path.join(root,'.local')),false);
});

test('waiting for the old process to stop is bounded and never spawns a duplicate',async t=>{
  const root=temporaryRoot(t);let checked=0,paused=0,restarts=0;
  await assert.rejects(ensureStarted({root,start:neverStart,
    check:async()=>{checked++;return 'outdated';},restart:async()=>{restarts++;},
    pause:async ms=>{assert.equal(ms,250);paused++;}
  }),/did not close.*No new companion/);
  assert.equal(restarts,1);assert.equal(checked,21);assert.equal(paused,20);
  assert.equal(fs.existsSync(path.join(root,'.local')),false);
});

test('a foreign listener appearing during restart is refused without spawning',async t=>{
  const root=temporaryRoot(t),states=['outdated','occupied'];let restarts=0;
  await assert.rejects(ensureStarted({root,start:neverStart,check:async()=>states.shift(),pause:noWait,
    restart:async()=>{restarts++;}
  }),/occupied by another program/);
  assert.equal(restarts,1);assert.equal(fs.existsSync(path.join(root,'.local')),false);
});

test('a compatible companion started by another launcher is reused during restart wait',async t=>{
  const root=temporaryRoot(t),states=['outdated','ready'];
  const result=await ensureStarted({root,start:neverStart,check:async()=>states.shift(),pause:noWait,restart:async()=>{}});
  assert.deepEqual(result,{existing:true});
  assert.equal(fs.existsSync(path.join(root,'.local')),false);
});

test('Windows restart invokes only the verification script hidden with bounded execution',async t=>{
  const root=temporaryRoot(t);let runs=0;
  await restartVerified({root,port:5190,platform:'win32',run:(exe,args,options,done)=>{
    runs++;assert.equal(path.basename(exe),'powershell.exe');
    assert.deepEqual(args,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'companion','restart.ps1')]);
    assert.equal(options.windowsHide,true);assert.equal(options.timeout,15000);
    assert.equal(options.env.HEDAX_RESTART_ROOT,path.resolve(root));assert.equal(options.env.HEDAX_RESTART_PORT,'5190');
    assert.equal(options.cwd,root);done(null);
  }});
  assert.equal(runs,1);
});

test('restart verification failure hides process details and unsupported hosts cannot stop anything',async t=>{
  const root=temporaryRoot(t);let runs=0;
  await assert.rejects(restartVerified({root,platform:'win32',run:(_exe,_args,_options,done)=>{
    runs++;done(Error('SYNTHETIC PRIVATE COMMAND LINE'));
  }}),error=>error.message.includes('could not be verified')&&!error.message.includes('PRIVATE'));
  await assert.rejects(restartVerified({root,platform:'linux',run:()=>assert.fail('No process invocation outside Windows')}),/must be closed/);
  assert.equal(runs,1);
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
