'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {loadApp}=require('./harness'),FX=require('./fixtures');
const {validateOperation,WAREHOUSE,fileKind}=require('../companion/operations.cjs');
function app(){const a=loadApp();a.ops=vm.runInContext('({computeReceptionStats,receptionServiceKind,receptionDate,operationsScope,operationDue,SourceSnapshots,importOperationReport})',a.__context);return a;}
const day='1405/06/30',now=new Date('2026-09-21T07:00:00Z');
const rec=(cardNo,admissionDate=day,extra={})=>({cardNo,admissionDate,createdAt:'1405/06/29 08:00',status:'در حال تعمیر',receptionist:'پذیرشگر آزمایشی الف',...extra});
test('daily counts use admission date, deduplicate cards within year, and separate missing dates and cancellations',()=>{
 const a=app();const rows=[rec('001'),rec('001'),rec('002',day,{receptionist:'پذیرشگر آزمایشی ب',status:'انصرافی'}),rec('003','1405/06/29'),rec('004',''),rec('',''),rec('001','1404/06/30')];
 const s=a.ops.computeReceptionStats(rows,day);
 assert.equal(s.daily.length,2);assert.equal(s.duplicateRows,1);assert.equal(s.missingCards,1);assert.equal(s.missingDates,1);assert.equal(s.cancelled,1);assert.equal(s.staff.length,2);assert.equal(s.staff.reduce((v,r)=>v+r.count,0),2);assert.equal(s.rows.length,5);
});
test('stopped list distinguishes actual release, historical release, cancelled and unknown status',()=>{
 const a=app(),s=a.ops.computeReceptionStats([rec('1','1405/06/28'),rec('2','1405/06/28',{clearedDate:day,status:'ترخیص شده'}),rec('3','1405/06/28',{clearedDate:'1405/06/31',status:'ترخیص شده'}),rec('4','1405/06/28',{status:''}),rec('5','1405/06/28',{status:'انصرافی'}),rec('6','1405/06/28',{clearedDate:'1405/06/27'}),rec('7')],day);
 assert.deepEqual(Array.from(s.stopped,r=>r.cardNo),['1','3']);assert.equal(s.uncertain,1);assert.equal(s.conflicts,1);assert.equal(s.age[0].count,2);
 assert.equal(a.ops.receptionDate('1405/07/31').valid,false);
});
test('service counts require completed evidence; requested text remains explicitly separate',()=>{
 const a=app(),kind=a.ops.receptionServiceKind;
 assert.equal(kind([rec('1',day,{customerNotes:'تعمیر برق و تعویض روغن',status:'ترخیص شده'})]).kind,'unknown');
 assert.equal(kind([rec('1',day,{customerNotes:'تعمیر برق و تعویض روغن'})],'requested').kind,'both');
 assert.equal(kind([rec('1',day,{performedServices:'تعویض روغن موتور'})]).kind,'service');
 assert.equal(kind([rec('1',day,{serviceKind:'تعمیر برق',workCompleted:'بله'})]).kind,'repair');
 assert.equal(kind([rec('1',day,{performedServices:'تعمیر انجام نشد'})]).kind,'unknown');
 const s=a.ops.computeReceptionStats([rec('1',day,{performedServices:'تعمیر برق و تعویض روغن'}),rec('2')],day);
 assert.equal(s.kindCounts.both,1);assert.equal(s.kindCounts.unknown,1);assert.equal(Object.values(s.kindCounts).reduce((x,y)=>x+y,0),2);
});
test('Tehran 10 AM gate, monthly refresh and fiscal year rollover match server scope',()=>{
 const a=app(),before=new Date('2026-09-21T06:29:00Z'),at=new Date('2026-09-21T06:30:00Z');
 for(const id of ['alef','b','p','t']){const scope=a.ops.operationsScope(id,now);assert.equal(JSON.stringify(validateOperation(scope,now)),JSON.stringify(scope));}
 assert.equal(a.ops.operationDue('p',null,before,true).due,false);assert.equal(a.ops.operationDue('p',null,at).due,true);
 assert.throws(()=>validateOperation(a.ops.operationsScope('p',before),before),{code:'REPORT_NOT_READY'});
 const source={meta:{origin:'b2b',receivedAt:now.valueOf()}};
 assert.equal(a.ops.operationDue('p',source,now).due,false);assert.equal(a.ops.operationDue('b',source,now).due,false);
 assert.equal(a.ops.operationDue('t',source,now).due,true);assert.equal(a.ops.operationDue('p',source,new Date('2026-09-23T07:00:00Z')).due,true);
 assert.equal(a.ops.operationDue('b',{meta:{origin:'manual',receivedAt:now.valueOf()}},now).due,true);
 const newYear=a.ops.operationsScope('t',new Date('2027-03-22T07:00:00Z'));assert.equal(newYear.fromDate,'1406/01/01');
 for(const bad of [{sourceId:'evil'},{...a.ops.operationsScope('alef',now),warehouse:'روغن'},{...a.ops.operationsScope('t',now),url:'https://other.example'}])assert.throws(()=>validateOperation(bad,now),{code:'INVALID_SCOPE'});
});
test('xlsx and HTML inventory exports accepted; login and other responses rejected',()=>{
 assert.equal(fileKind(FX.sampleWorkbook()),'xlsx');assert.equal(fileKind(Buffer.from('<html><table><tr><td>part</td></tr></table></html>')),'xls');
 for(const b of ['<html><form><input type=password></form></html>','bad file'])assert.throws(()=>fileKind(Buffer.from(b)),{code:'INVALID_FILE'});
});
test('new report route uses the same origin/token protections and shared browser lock',async t=>{
 const {createServer}=require('../companion/server.cjs'),{B2BClient}=require('../companion/b2b.cjs');
 const scope=app().ops.operationsScope('t'),client=new B2BClient();client.busy=true;
 await assert.rejects(client.report(scope),{code:'BUSY'});
 let calls=0;const server=createServer({port:5197,client:{report:async s=>{calls++;return {scope:s};}}});
 await new Promise(r=>server.listen(5197,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:5197',token=(await(await fetch(base+'/api/b2b/session')).json()).token;
 const post=(data,origin='http://localhost:5197',key=token)=>fetch(base+'/api/b2b/report',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Hedax-Token':key},body:JSON.stringify(data)});
 assert.equal((await post(scope,'https://other.example')).status,403);assert.equal((await post(scope,undefined,'wrong')).status,403);assert.equal((await post({sourceId:'unknown'})).status,400);assert.equal(calls,0);
 assert.equal((await post(scope)).status,200);assert.equal(calls,1);
});
test('admission import maps reordered headers and Arabic names, without substituting creation for admission',async()=>{
 const a=app(),buf=FX.buildWorkbook([{name:'پذیرش',rows:[['نام پذیرشگر','تاريخ پذيرش','شماره کارت پذيرش','تاريخ و زمان ايجاد','تاریخ ترخیص تخمینی'],['آزمایشی',day,'0001','1405/06/29 08:00',day]]}]);
 const r=await a.ingestFile('t',new File([buf],'synthetic.xlsx'));assert.equal(r.ok,true);assert.equal(r.records[0].admissionDate,day);assert.equal(r.records[0].cardNo,'0001');assert.equal(r.records[0].clearedDate,'');
 assert.equal(a.ops.computeReceptionStats(r.records,day).daily.length,1);
});
test('automatic imports replace snapshots, validate scope independent of key order, and keep data on storage/format failure',async()=>{
 const a=app(),ctx=a.__context;ctx.atob=s=>Buffer.from(s,'base64').toString('binary');vm.runInContext('renderFileDots=()=>{};renderActiveTab=()=>{};',ctx);
 const scope=a.ops.operationsScope('t',now),buf=FX.buildWorkbook([{name:'پذیرش',rows:[['شماره کارت پذیرش','تاریخ و زمان ایجاد','تاریخ پذیرش'],['TEST-001','1405/06/30 08:00',day]]}]);
 const payload={scope:{toDate:scope.toDate,fromDate:scope.fromDate,sourceId:'t'},receivedAt:now.valueOf(),fileName:'synthetic.xlsx',base64:buf.toString('base64')};
 let stored; a.ops.SourceSnapshots.put=async x=>{stored=x;};
 assert.equal((await a.ops.importOperationReport(payload,scope)).duplicate,false);assert.equal(stored.records.length,1);
 assert.equal((await a.ops.importOperationReport(payload,scope)).duplicate,true);assert.equal(a.STATE.sources.t.records.length,1);
 const previous=a.STATE.sources.t;a.ops.SourceSnapshots.put=async()=>{throw new Error('quota');};
 await assert.rejects(a.ops.importOperationReport(payload,scope),/quota/);assert.equal(a.STATE.sources.t,previous);
 await assert.rejects(a.ops.importOperationReport({...payload,base64:Buffer.from('invalid').toString('base64')},scope));
 await assert.rejects(a.ops.importOperationReport({...payload,scope:{...scope,toDate:'1405/01/01'}},scope));assert.equal(a.STATE.sources.t,previous);
});
