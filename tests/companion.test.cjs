'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const vm = require('node:vm');
const {createServer} = require('../companion/server.cjs');
const {validateScope, B2BClient} = require('../companion/b2b.cjs');
const {loadApp} = require('./harness');
const FX = require('./fixtures');
const scope={dateKey:'1405/06/29',statusFilter:'همه',hall:'سالن تعمیرات'};
test('scope validation rejects unknown filters, malformed dates and arbitrary URLs',()=>{
  assert.deepEqual(validateScope(scope),scope);
  for(const patch of [{dateKey:'1405/07/31'},{dateKey:'2026/09/20'},{hall:'unexpected'},{statusFilter:'https://other.example'}]) {
    assert.throws(()=>validateScope({...scope,...patch}),{code:'INVALID_SCOPE'});
  }
});
test('localhost server protects sync, serves only dashboard, and retains error codes',async t=>{
  let calls=0;
  const client={sync:async s=>{calls++;return {scope:s,base64:'UEs=',receivedAt:1};},login:async()=>{throw Object.assign(new Error('login needed'),{code:'LOGIN_REQUIRED'});}};
  const server=createServer({client,port:5198});
  await new Promise(resolve=>server.listen(5198,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://localhost:5198', base='http://127.0.0.1:5198';
  const token=(await (await fetch(base+'/api/b2b/session')).json()).token;
  const post=(route,headers={},body=scope)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Hedax-Token':token,...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/b2b/sync',{Origin:'https://evil.example'})).status,403);
  assert.equal((await post('/api/b2b/sync',{'X-Hedax-Token':'wrong'})).status,403);
  assert.equal((await post('/api/b2b/sync',{}, {...scope,hall:'bad'})).status,400);
  assert.equal(calls,0);
  assert.equal((await post('/api/b2b/sync')).status,200); assert.equal(calls,1);
  assert.equal((await post('/api/b2b/login')).status,401);
  for(const route of ['/.git/config','/.local/b2b-profile/Preferences','/README.md','/api/unknown']) assert.equal((await fetch(base+route)).status,404);
  assert.equal((await fetch(base+'/')).status,200);
  const badHostStatus=await new Promise((resolve,reject)=>{
    require('node:http').get(base+'/api/b2b/session',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);
  });
  assert.equal(badHostStatus,403);
});
test('concurrent automation is rejected without launching a second browser',async()=>{
  const client=new B2BClient(); client.busy=true;
  await assert.rejects(client.sync(scope),{code:'BUSY'});
  await assert.rejects(client.login(),{code:'BUSY'});
});
test('browser launch restrictions produce an actionable error without exposing profile paths',async()=>{
  const client=new B2BClient({profileDir:require('node:path').join(require('node:os').tmpdir(),'hedax-test-empty-profile'),chromium:{launchPersistentContext:async()=>{throw new Error('spawn EPERM private path');}}});
  await assert.rejects(client.open(),err=>err.code==='BROWSER_START_FAILED' && !err.message.includes('private path'));
});
test('automatic import validates scope and content, deduplicates, and preserves last data on storage failure',async()=>{
  const app=loadApp(), ctx=app.__context;
  ctx.atob=s=>Buffer.from(s,'base64').toString('binary');
  vm.runInContext('renderFileDots=()=>{}; renderActiveTab=()=>{};',ctx);
  const importer=vm.runInContext('importB2BReport',ctx);
  let disk=[];
  app.NobatStore.all=async()=>disk;
  app.NobatStore.put=async r=>{disk.push(r);};
  const payload={scope,receivedAt:1234567890000,fileName:'synthetic.xlsx',base64:FX.sampleWorkbook().toString('base64')};
  assert.equal((await importer(payload,scope)).duplicate,false);
  assert.equal(disk.length,1);
  assert.equal(app.STATE.nobat.reports[0].source,'b2b');
  assert.equal((await importer(payload,scope)).duplicate,true);
  assert.equal(disk.length,1);
  const previous=app.STATE.nobat.reports[0];
  await assert.rejects(importer({...payload,scope:{...scope,hall:'سرویس سریع'}},scope));
  await assert.rejects(importer({...payload,base64:Buffer.from('not excel').toString('base64')},scope));
  assert.equal(app.STATE.nobat.reports[0],previous);
  app.NobatStore.put=async()=>{throw new Error('quota exceeded');};
  const nextScope={...scope,dateKey:'1405/06/30'};
  await assert.rejects(importer({...payload,scope:nextScope},nextScope),/quota/);
  assert.equal(app.STATE.nobat.reports.length,1);
  assert.equal(app.STATE.nobat.reports[0],previous);
});
