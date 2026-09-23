'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const FX=require('./fixtures');

// Freeze Tehran at 1405/07/01, after the 10 AM امداد publication gate.
// No browser, network, credentials or actual dealership records are used.
const NOW='2026-09-23T07:00:00Z';
class Clock extends Date {constructor(...args){super(...(args.length?args:[NOW]));}static now(){return new Date(NOW).valueOf();}}
async function loadAdapter(){
  const filename=path.resolve(__dirname,'../companion/operations.cjs');
  const sandbox={module:{exports:{}},require:createRequire(filename),Date:Clock,URL,Buffer};
  vm.runInNewContext(await fs.readFile(filename,'utf8'),sandbox,{filename});
  return sandbox.module.exports;
}

async function fixture(t,id,options={}){
  const adapter=await loadAdapter();
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hedax-adapter-synthetic-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'synthetic-report.bin');
  const bytes=options.bytes||FX.sampleWorkbook();
  await fs.writeFile(filename,bytes);
  const log=[],controls=[],values=new Map();
  let currentUrl='',completed=false,downloadPending=false,deleted=false;
  const download={
    failure:async()=>options.downloadFailure||null,
    path:async()=>filename,
    delete:async()=>{deleted=true;log.push('download:delete');await fs.unlink(filename);}
  };
  const add=(role,name,value='')=>{
    values.set(name,value);
    const control={role,name,
      async fill(value){log.push('fill:'+name+':'+value);values.set(name,value);},
      async press(key){assert.equal(key,'Tab');log.push('blur:'+name);},
      async inputValue(){return values.get(name);},
      async isChecked(){return Boolean(options.specialGoods);},
      async waitFor(){log.push('visible:'+name);if(options.failAt===name)throw new Error('synthetic timeout');},
      async click(){
        log.push('click:'+name);
        if(name==='تکمیل اطلاعات'){completed=true;return;}
        assert.ok(downloadPending,'download listener must be armed before export click');
        if(id==='b')assert.ok(completed,'DPLAN must finish completing data before export');
      }
    };
    controls.push(control);return control;
  };
  if(id==='alef'){
    add('listbox','انبار');add('listbox','نوع قطعات');add('textbox','کد تدارکاتی');
    add('button',' موجودی انبار');
  }else if(id==='b'){
    add('button','تکمیل اطلاعات');
    for(const name of ['نوع گردش','گروه قطعه','گروه خودرو'])add('listbox',name);
    add('textbox','کد اختصاصی');add('checkbox','کالا خاص است؟ ');
    add('button',' برنامه ریزی موجودی نمایندگی');
  }else{
    add('textbox','از تاریخ پذیرش');add('textbox','تا تاریخ پذیرش');
    if(id==='p'){
      add('listbox','وضعیت امداد');
      for(const name of ['شماره کارت','شماره شاسی','شماره امداد ویژه','کد اختصاصی','تاریخ رسید','تاریخ ثبت امداد ویژه'])add('textbox',name);
      add('button',' تهیه گزارش');
    }else{
      for(const name of ['وضعیت پذیرش','نوع خودرو'])add('listbox',name);
      for(const name of ['از تاریخ ترخیص','تا تاریخ ترخیص','شماره پذیرش','شماره شاسی','شماره هرم'])add('textbox',name);
      add('button','خروجی اکسل');
    }
  }
  if(options.extraFilter)values.set(options.extraFilter,'محدودیت آزمایشی');
  const page={
    async goto(url){log.push('goto:'+url);currentUrl=url;},url:()=>currentUrl,
    getByRole(role,{name,exact}){
      const match=controls.filter(c=>c.role===role&&(typeof name==='string'?c.name===name:name.test(c.name)));
      assert.equal(match.length,1,'Only observed report controls may be used: '+role+' '+name);
      if(typeof name==='string')assert.equal(exact,true,'Named controls must match exactly');
      return match[0];
    },
    locator(selector){assert.equal(selector,'#year');return {inputValue:async()=>options.year||'۱۴۰۵'};},
    getByText(pattern){
      assert.ok(pattern.test('1 - 20 از 7009'),'Must wait for the observed DPLAN populated pager');
      return {async waitFor(){assert.ok(completed);log.push('dplan:ready');if(options.pagerFailure)throw new Error('synthetic pager timeout');}};
    },
    waitForEvent(event){assert.equal(event,'download');downloadPending=true;log.push('download:listen');return Promise.resolve(download);}
  };
  const client={busy:false,open:async()=>page};
  const scope=id==='alef'?{sourceId:id,dateKey:'1405/07/01',warehouse:adapter.WAREHOUSE}:id==='b'?{sourceId:id,dateKey:'1405/07/01',year:'1405'}:{sourceId:id,fromDate:'1405/01/01',toDate:'1405/07/01'};
  const select=async(p,name,value)=>{assert.equal(p,page);assert.equal(name,'انبار');assert.equal(value,adapter.WAREHOUSE);values.set(name,value);log.push('select:'+name);};
  return {adapter,client,scope,log,values,filename,bytes,wasDeleted:()=>deleted,run:()=>adapter.runOperation(client,scope,select)};
}

for(const id of ['p','t'])test(id+' report fetches the full fiscal year through today and cleans up the downloaded file',async t=>{
  const f=await fixture(t,id),result=await f.run();
  assert.equal(f.values.get('از تاریخ پذیرش'),'1405/01/01');
  assert.equal(f.values.get('تا تاریخ پذیرش'),'1405/07/01');
  assert.ok(f.log.includes('blur:از تاریخ پذیرش'));
  assert.ok(f.log.includes('blur:تا تاریخ پذیرش'));
  assert.equal(JSON.stringify(result.scope),JSON.stringify(f.scope));
  assert.equal(result.receivedAt,new Date(NOW).valueOf());
  assert.equal(result.fileName,'b2b-'+id+'.xlsx');
  assert.deepEqual(Buffer.from(result.base64,'base64'),f.bytes);
  assert.ok(f.wasDeleted());await assert.rejects(fs.stat(f.filename),{code:'ENOENT'});
  assert.equal(f.client.busy,false);
});

test('DPLAN accepts the observed checkbox label and completes data before exporting, without operational writes',async t=>{
  const f=await fixture(t,'b');await f.run();
  const actions=f.log.filter(x=>x.startsWith('click:'));
  assert.deepEqual(actions,['click:تکمیل اطلاعات','click: برنامه ریزی موجودی نمایندگی']);
  assert.ok(f.log.indexOf('click:تکمیل اطلاعات')<f.log.indexOf('dplan:ready'));
  assert.ok(f.log.indexOf('dplan:ready')<f.log.indexOf('download:listen'));
  assert.equal(f.client.busy,false);
});

test('DPLAN rejects special-goods filtering before completing data or starting a download',async t=>{
  const f=await fixture(t,'b',{specialGoods:true});
  await assert.rejects(f.run(),{code:'FILTER_MISMATCH'});
  assert.equal(f.log.some(x=>x.startsWith('click:')||x==='download:listen'),false);
  assert.equal(f.client.busy,false);
});

test('DPLAN pager timeout exposes the failing phase and never exports incomplete data',async t=>{
  const f=await fixture(t,'b',{pagerFailure:true});
  await assert.rejects(f.run(),e=>e.code==='B2B_UNAVAILABLE'&&e.message.includes('تکمیل اطلاعات DPLAN'));
  assert.deepEqual(f.log.filter(x=>x.startsWith('click:')),['click:تکمیل اطلاعات']);
  assert.equal(f.client.busy,false);
});

test('inventory selects only the parts warehouse and accepts the real HTML export format',async t=>{
  const f=await fixture(t,'alef',{bytes:Buffer.from('<html><table><tr><td>SYNTHETIC-PART-001</td></tr></table></html>')});
  const result=await f.run();
  assert.equal(f.values.get('انبار'),f.adapter.WAREHOUSE);
  assert.equal(result.fileName,'b2b-alef.xls');
  assert.ok(f.wasDeleted());
});

test('a residual admissions filter prevents exporting a misleading partial report',async t=>{
  const f=await fixture(t,'t',{extraFilter:'نوع خودرو'});
  await assert.rejects(f.run(),{code:'FILTER_MISMATCH'});
  assert.equal(f.log.includes('download:listen'),false);
  assert.equal(f.client.busy,false);
});

test('an unavailable export button reports its phase and releases the shared browser lock',async t=>{
  const f=await fixture(t,'t',{failAt:'خروجی اکسل'});
  await assert.rejects(f.run(),e=>e.code==='B2B_UNAVAILABLE'&&e.message.includes('انتخاب خروجی اکسل'));
  assert.equal(f.log.includes('download:listen'),false);
  assert.equal(f.client.busy,false);
});

test('invalid downloaded login markup is rejected and the temporary file is still deleted',async t=>{
  const f=await fixture(t,'t',{bytes:Buffer.from('<html><form><input type="password"></form></html>')});
  await assert.rejects(f.run(),{code:'INVALID_FILE'});
  assert.ok(f.wasDeleted());await assert.rejects(fs.stat(f.filename),{code:'ENOENT'});
  assert.equal(f.client.busy,false);
});

test('a failed browser download is surfaced and its temporary file is deleted',async t=>{
  const f=await fixture(t,'t',{downloadFailure:'synthetic network failure'});
  await assert.rejects(f.run(),{code:'DOWNLOAD_FAILED'});
  assert.ok(f.wasDeleted());assert.equal(f.client.busy,false);
});
