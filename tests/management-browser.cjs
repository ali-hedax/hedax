'use strict';
// All data generated here is synthetic. This preview never contacts B2B.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {loadApp}=require('./harness'),FX=require('./fixtures'),a=loadApp();
const day='1405/06/30',books={};
const records={
 alef:[{code:'T1',desc:'روغن موتور آزمایشی',stock:4,sellPrice:2000000},{code:'T2',desc:'قطعه برقی آزمایشی',stock:0,sellPrice:4000000},{code:'T3',desc:'فیلتر هوا آزمایشی',stock:8,sellPrice:1000000}],
 b:[{code:'B1',desc:'روغن موتور آزمایشی',turnover:'کند گردش',onHand:4,inTransit:0,reorderPoint:8,dailyRate:2,needQty:4,s1:10,s2:14,s3:9},{code:'B2',desc:'قطعه برقی آزمایشی',turnover:'تند گردش',onHand:0,inTransit:1,reorderPoint:10,dailyRate:4,needQty:9,s1:5,s2:9},{code:'B3',desc:'فیلتر هوا آزمایشی',turnover:'راکد',onHand:8,inTransit:0,reorderPoint:2,dailyRate:0,s1:2}],
 p:[{code:'B2',techCode:'T2',desc:'قطعه برقی آزمایشی',date:'1405/01/15'},{code:'B2',techCode:'T2',desc:'قطعه برقی آزمایشی',date:'1405/02/20'}],
 t:[{cardNo:'TEST-001',admissionDate:day,createdAt:day+' 08:00',receptionist:'پذیرشگر آزمایشی الف',status:'در حال تعمیر',performedServices:'تعمیر برق'},{cardNo:'TEST-002',admissionDate:'1405/06/28',createdAt:'1405/06/28 08:00',receptionist:'پذیرشگر آزمایشی ب',status:'در حال تعمیر'},{cardNo:'TEST-003',admissionDate:day,createdAt:day+' 09:00',receptionist:'پذیرشگر آزمایشی ب',status:'ترخیص شده',clearedDate:day,clearedTime:'11:00',performedServices:'تعویض روغن موتور'}],
};
for(const [id,rows] of Object.entries(records)){const def=a.SOURCE_DEFS[id];books[id]=FX.buildWorkbook([{name:def.title,rows:[def.fields.map(f=>f.synonyms[0]),...rows.map(r=>def.fields.map(f=>r[f.key]??(f.numeric?0:'')))]}]);}
books.n=FX.sampleWorkbook();
const code=`<script>
addEventListener('load',async()=>{
const banner=document.createElement('div');banner.className='card';banner.textContent='پیش‌نمایش آزمایشی — تمام اطلاعات این صفحه ساختگی است';document.querySelector('.main-content').prepend(banner);
const out=document.createElement('pre');out.id='management-test-results';out.style='white-space:pre-wrap';document.querySelector('.main-content').append(out);const checks=[];
const check=(name,ok)=>{checks.push((ok?'PASS ':'FAIL ')+name);out.textContent=checks.join('\\n');if(!ok)throw Error(name);};
try{
await SourceSnapshots.all();await new Promise(r=>setTimeout(r,150));
if(!sessionStorage.getItem('management-reloaded-v2')){
for(const id of ['alef','b','p','t']){const bytes=await(await fetch('/fixture/'+id)).arrayBuffer(),file=new File([bytes],'synthetic-'+id+'.xlsx');const res=await ingestFile(id,file);check('import '+id,res.ok);await OperationsSync.saveManual(id,res.records,res.diag,file);}
const ns={dateKey:'1405/06/30',statusFilter:'همه',hall:'سالن تعمیرات'},nb=new Uint8Array(await(await fetch('/fixture/n')).arrayBuffer());await importB2BReport({scope:ns,receivedAt:Date.now(),fileName:'synthetic-n.xlsx',base64:btoa(Array.from(nb,c=>String.fromCharCode(c)).join(''))},ns);
sessionStorage.setItem('management-reloaded-v2','1');location.reload();return;}
check('all four sources restored',Object.values(STATE.sources).filter(Boolean).length>=4);
STATE.managementDay='1405/06/30';STATE.receptionDay='1405/06/30';recomputeDerived();switchTab('dashboard');
check('management metrics visible',document.getElementById('managementOverview').textContent.includes('مانده از روزهای قبل'));
check('stock chart retained',document.getElementById('turnoverChart').children.length>0);
for(const id of ['mgReceptionTrend','mgStaff','mgStopped','mgServices','mgOrders','mgSlow','mgOil','mgNobat','emdadTrendMini'])check('populated '+id,document.getElementById(id).querySelector('svg,.hbar-chart')!==null);
check('summary export exists',document.querySelector('#mgSummaryTable .btn-export-table')!==null);
const realDownload=triggerBlobDownload;let exported;triggerBlobDownload=(blob,name)=>{exported={blob,name};};document.querySelector('#mgSummaryTable .btn-export-table').click();await new Promise(r=>setTimeout(r,100));triggerBlobDownload=realDownload;check('managerial Excel generated',exported?.name.endsWith('.xlsx')&&exported.blob.size>0);const exportedSheets=await parseXlsxNative(await exported.blob.arrayBuffer());check('export contains adviser breakdown',exportedSheets[0].rows.some(row=>row.some(cell=>String(cell).includes('پذیرشگر:'))));
check('data controls collapsed',!document.getElementById('managementData').open);
for(const [tab,id] of [['priority','priorityTable'],['slow','slowTable'],['emdad','emdadTable'],['oil','oilTable'],['reception','receptionTable']]){switchTab(tab);check('populated detailed '+tab,document.getElementById(id).querySelectorAll('tbody tr').length>0);check('B2B controls below analysis '+tab,!!(document.getElementById(id).compareDocumentPosition(document.querySelector('#tab-'+tab+' .ops-panel'))&Node.DOCUMENT_POSITION_FOLLOWING));}
switchTab('dashboard');document.getElementById('managementDay').value='1405/06/28';document.getElementById('managementDay').dispatchEvent(new Event('change'));check('date changes admission metrics',managementMetrics(STATE.sources,STATE.derived,STATE.managementDay).reception.daily.length===1);
document.getElementById('managementLatest').click();check('latest file date works',STATE.managementDay==='1405/06/30');
const keep={...STATE.sources};STATE.sources={t:keep.t};recomputeDerived();renderDashboard();check('reception-only dashboard still renders chart',!!document.querySelector('#mgStaff .hbar-chart'));check('missing stock not zero',document.querySelector('#managementOverview .kpi-value').textContent.trim()!=='—');
STATE.sources=keep;recomputeDerived();renderDashboard();out.dataset.complete='true';
}catch(e){out.textContent+='\\nERROR '+e.stack;out.dataset.complete='false';}
});</script>`;
http.createServer((req,res)=>{
 const id=req.url?.startsWith('/fixture/')?req.url.slice(9):null;if(id&&books[id]){res.end(books[id]);return;}
 if(req.url!=='/'&&req.url!=='/test'){res.writeHead(404);res.end();return;}
 let html=fs.readFileSync(path.join(__dirname,'../index (4).html'),'utf8');
 html=html.replace('</head>','<script>localStorage.setItem("hedax-ops-enabled",JSON.stringify({alef:false,b:false,p:false,t:false}));</script></head>');
 html=html.replace('</body>',code+'</body>');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);
}).listen(Number(process.env.HEDAX_TEST_PORT||5178),'127.0.0.1',()=>console.log('Synthetic management preview ready'));
