'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {loadApp,APP_FILE}=require('./harness');
function load(){const a=loadApp();a.manager=vm.runInContext('({managementMetrics,managementSummaryRows,recomputeDerived})',a.__context);return a;}
test('reception-only data drives managerial metrics without stock files',()=>{
 const a=load(),sources={t:{records:[{cardNo:'TEST-1',admissionDate:'1405/06/30',createdAt:'1405/06/29',receptionist:'آزمایشی الف',status:'در حال تعمیر',performedServices:'تعمیر برق'},{cardNo:'TEST-2',admissionDate:'1405/06/28',status:'در حال تعمیر'}]}};
 const m=a.manager.managementMetrics(sources,null,'1405/06/30');assert.equal(m.reception.daily.length,1);assert.equal(m.reception.stopped.length,1);assert.equal(m.orders,null);assert.equal(m.slowValue,null);
 const rows=a.manager.managementSummaryRows(m,sources);assert.equal(rows.find(x=>x.indicator==='پذیرش ثبت‌شده').value,1);assert.equal(rows.find(x=>x.indicator==='تعمیرات انجام‌شده').value,1);assert.equal(rows.find(x=>x.indicator.includes('اقلام دارای کسری')).value,null);assert.equal(rows.find(x=>x.indicator==='پذیرشگر: '+a.norm('آزمایشی الف')).value,1);
});
test('nobat rows never count as daily admissions and missing service evidence is not zero',()=>{
 const a=load(),sources={n:{records:[{cardNo:'',visitStatus:'در صف پذیرش'}]}};
 const m=a.manager.managementMetrics(sources,null,'1405/06/30');assert.equal(m.nobat.rowsWithoutCard,1);assert.equal(m.reception,null);assert.equal(a.manager.managementSummaryRows(m,sources)[0].value,null);
 sources.t={records:[{cardNo:'TEST',admissionDate:'1405/06/30',customerNotes:'تعمیر برق',status:'ترخیص شده'}]};
 const r=a.manager.managementSummaryRows(a.manager.managementMetrics(sources,null,'1405/06/30'),sources);assert.equal(r.find(x=>x.indicator==='تعمیرات انجام‌شده').value,null);assert.equal(r.find(x=>x.indicator==='نوع خدمت نامشخص').value,1);
});
test('action list respects transit stock and inventory values are not double-counted for joined parts',()=>{
 const a=load();a.STATE.sources={alef:{records:[{code:'T1',desc:'روغن موتور آزمایشی',stock:4,sellPrice:100}]},b:{records:[{code:'B1',desc:'روغن موتور آزمایشی',turnover:'کند گردش',onHand:1,inTransit:1,reorderPoint:5,dailyRate:2},{code:'B2',desc:'روغن موتور آزمایشی',turnover:'راکد',onHand:2,inTransit:8,reorderPoint:5,dailyRate:1},{code:'B3',desc:'قطعه بی قیمت',turnover:'راکد',onHand:0,inTransit:0,reorderPoint:2,dailyRate:1}]}};
 a.manager.recomputeDerived();const m=a.manager.managementMetrics(a.STATE.sources,a.STATE.derived,'1405/06/30');assert.equal(m.orders.length,2);assert.equal(m.orders.find(x=>x.b.code==='B1').shortfall,3);assert.equal(m.oilShort.length,1);assert.equal(m.slowValue,400);assert.equal(m.slowMatched,2);assert.equal(m.slow.length,3);
});
test('overview structure puts analytics first and keeps all detailed tabs and outputs',()=>{
 const html=fs.readFileSync(APP_FILE,'utf8');assert.ok(html.indexOf('id="managementOverview"')<html.indexOf('id="uploadGrid"'));
 assert.match(html,/<details[^>]+id="managementData"/);assert.doesNotMatch(html,/<details[^>]+id="managementData"[^>]*\bopen\b/);
 for(const token of ['priorityBody','slowBody','emdadBody','oilBody','receptionBody','nobatBody','btnExportOrder','priceSvcUrl','recAllTable','mgSummaryTable','turnoverChart','emdadTrendMini'])assert.ok(html.includes(token),token);
});
