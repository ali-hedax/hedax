'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {loadApp}=require('./harness');

function transport(fetch){
  const app=loadApp();
  app.__context.AbortSignal=AbortSignal;
  app.__context.fetch=fetch;
  return vm.runInContext('B2BRequests',app.__context);
}
const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});

test('an old or incompatible companion cannot open a browser or export a report',async()=>{
  for(const session of [{version:1,token:'synthetic-old'}, {version:1,browser:'msedge',token:'synthetic-old'}, {version:2,browser:'chrome',token:'synthetic-future'}]){
    let sessions=0,posts=0;
    const client=transport(async(url)=>{
      if(url.endsWith('/session')){sessions++;return response(200,session);}
      posts++;return response(200,{message:'should not execute'});
    });
    for(const route of ['login','sync','report'])await assert.rejects(client.request(route,{}),error=>error.code==='COMPANION_OUTDATED'&&error.message.includes('start-hedax.cmd'));
    assert.equal(sessions,3);assert.equal(posts,0);
  }
});

test('supported Chrome protocol is accepted independently of the launcher build label',async()=>{
  let posts=0;
  const client=transport(async url=>{
    if(url.endsWith('/session'))return response(200,{version:1,browser:'chrome',build:'another-compatible-build',token:'synthetic'});
    posts++;return response(200,{message:'synthetic success'});
  });
  const result=await client.request('login',{});
  assert.equal(posts,1);assert.equal(result.message,'synthetic success');
});

test('cached token is refreshed once after restart and the same report request succeeds',async()=>{
  let currentToken='synthetic-before-restart',sessions=0,actions=0;
  const posts=[];
  const client=transport(async(url,options)=>{
    if(url.endsWith('/session')){sessions++;return response(200,{version:1,browser:'chrome',token:currentToken});}
    posts.push({token:options.headers['X-Hedax-Token'],body:options.body,url});
    if(options.headers['X-Hedax-Token']!==currentToken)return response(403,{message:'Request rejected'});
    actions++;return response(200,{message:'synthetic success'});
  });
  await client.request('login',{});
  currentToken='synthetic-after-restart';
  const scope={dateKey:'1405/07/02',statusFilter:'همه',hall:'سالن تعمیرات'};
  const result=await client.request('sync',scope);
  assert.equal(result.message,'synthetic success');
  assert.equal(sessions,2);assert.equal(actions,2);assert.equal(posts.length,3);
  assert.equal(posts[1].token,'synthetic-before-restart');
  assert.equal(posts[2].token,'synthetic-after-restart');
  assert.equal(posts[1].url,posts[2].url);assert.equal(posts[1].body,posts[2].body);
  await client.request('report',{sourceId:'t'});
  assert.equal(sessions,2);assert.equal(posts.at(-1).token,'synthetic-after-restart');
});

test('persistent 403 stops after one refresh instead of looping',async()=>{
  let sessions=0,posts=0;
  const client=transport(async url=>{
    if(url.endsWith('/session')){sessions++;return response(200,{version:1,browser:'chrome',token:'synthetic-'+sessions});}
    posts++;return response(403,{message:'Request rejected'});
  });
  await assert.rejects(client.request('report',{}),/Request rejected/);
  assert.equal(sessions,2);assert.equal(posts,2);
});

test('export, authentication, and busy failures are surfaced without replaying the report',async()=>{
  for(const status of [502,401,409]){
    let sessions=0,posts=0;
    const client=transport(async url=>{
      if(url.endsWith('/session')){sessions++;return response(200,{version:1,browser:'chrome',token:'synthetic'});}
      posts++;return response(status,{code:'SYNTHETIC_FAILURE',message:'synthetic export failed'});
    });
    await assert.rejects(client.request('report',{}),e=>e.code==='SYNTHETIC_FAILURE'&&e.message==='synthetic export failed');
    assert.equal(sessions,1);assert.equal(posts,1);
  }
});

test('timeout and interrupted connections never automatically repeat an export',async()=>{
  for(const failure of [Object.assign(new Error('synthetic timeout'),{name:'TimeoutError'}),new TypeError('synthetic interrupted connection')]){
    let sessions=0,posts=0;
    const client=transport(async url=>{
      if(url.endsWith('/session')){sessions++;return response(200,{version:1,browser:'chrome',token:'synthetic'});}
      posts++;throw failure;
    });
    await assert.rejects(client.request('sync',{}));
    assert.equal(sessions,1);assert.equal(posts,1);
  }
});

test('queued reports remain serial while the first request refreshes its rejected token',async()=>{
  let sessions=0,posts=0,active=0,maxActive=0;
  const order=[];
  const client=transport(async(url,options)=>{
    if(url.endsWith('/session')){sessions++;return response(200,{version:1,browser:'chrome',token:'synthetic-'+sessions});}
    active++;maxActive=Math.max(maxActive,active);posts++;order.push(url);
    await new Promise(resolve=>setTimeout(resolve,5));active--;
    return posts===1?response(403,{message:'Request rejected'}):response(200,{message:options.headers['X-Hedax-Token']});
  });
  const results=await Promise.all([client.request('sync',{}),client.request('report',{})]);
  assert.equal(maxActive,1);assert.equal(sessions,2);assert.equal(posts,3);
  assert.deepEqual(order,['/api/b2b/sync','/api/b2b/sync','/api/b2b/report']);
  assert.equal(results[0].message,'synthetic-2');assert.equal(results[1].message,'synthetic-2');
});
