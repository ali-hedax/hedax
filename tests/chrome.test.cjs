'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {B2BClient}=require('../companion/b2b.cjs');
const {browserConfig}=require('../companion/config.cjs');

test('Chrome uses its own local profile and never the existing Edge profile',()=>{
  const root=path.resolve('synthetic-root');
  assert.deepEqual(browserConfig(root),{channel:'chrome',profileDir:path.join(root,'.local','b2b-profile-chrome')});
  assert.equal(new B2BClient().channel,'chrome');
});

test('Chrome login launches a persistent download-enabled context once and locks concurrent exports',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hedax-chrome-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let launchCount=0,release,front=0,closed;
  const wait=new Promise(r=>release=r),urls=[];
  const page={isClosed:()=>false,setDefaultTimeout:()=>{},goto:async url=>urls.push(url),url:()=>urls.at(-1),bringToFront:async()=>front++};
  const context={pages:()=>[page],on:(event,fn)=>{assert.equal(event,'close');closed=fn;},close:async()=>closed()};
  const client=new B2BClient({...browserConfig(root),chromium:{launchPersistentContext:async(profile,options)=>{
    launchCount++;assert.equal(profile,path.join(root,'.local','b2b-profile-chrome'));
    assert.equal(options.channel,'chrome');assert.equal(options.acceptDownloads,true);assert.equal(options.headless,false);assert.equal(options.chromiumSandbox,true);
    await wait;return context;
  }}});
  const login=client.login();
  await assert.rejects(client.login(),{code:'BUSY'});
  await assert.rejects(client.sync({dateKey:'1405/07/02',statusFilter:'همه',hall:'سالن تعمیرات'}),{code:'BUSY'});
  // Points the user at the Chrome window, never at Edge, and promises the
  // fetch resumes by itself — the exact wording lives in LOGIN_WAIT_MESSAGE.
  release();const loginMessage=(await login).message;
  assert.match(loginMessage,/Chrome/);assert.equal(/Edge/.test(loginMessage),false);
  assert.match(loginMessage,/خودکار ادامه/);
  assert.equal(client.busy,false);assert.equal(await client.open(),page);assert.equal(launchCount,1);assert.equal(front,1);
  assert.deepEqual(urls,['https://b2b.isaco.ir/PlanningReport']);
  await client.close();assert.equal(client.context,null);
});

test('failed Chrome login releases the lock and hides underlying process details',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hedax-chrome-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const client=new B2BClient({...browserConfig(root),chromium:{launchPersistentContext:async()=>{throw Error('sensitive-system-detail');}}});
  await assert.rejects(client.login(),e=>e.code==='BROWSER_START_FAILED'&&e.message.includes('Google Chrome')&&!e.message.includes('sensitive-system-detail'));
  assert.equal(client.busy,false);
});
