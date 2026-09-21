const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const FX=require('./fixtures');
const fixture=FX.buildWorkbook([{name:'پذیرش',rows:[['شماره کارت پذیرش','تاریخ و زمان ایجاد','تاریخ پذیرش','نام پذیرشگر','وضعیت پذیرش','شرح محصول','شرح خدمات انجام شده'],['TEST-001','1405/06/30 08:00','1405/06/30','پذیرشگر آزمایشی الف','در حال تعمیر','خودروی آزمایشی','تعمیر برق'],['TEST-002','1405/06/28 08:00','1405/06/28','پذیرشگر آزمایشی ب','در حال تعمیر','خودروی آزمایشی',''],['TEST-003','1405/06/30 08:00','1405/06/30','پذیرشگر آزمایشی الف','در حال تعمیر','خودروی آزمایشی','تعویض روغن موتور']]}]);
const testing=`<script>
localStorage.setItem('hedax-ops-enabled',JSON.stringify({alef:false,b:false,p:false,t:false}));
addEventListener('load',async()=>{
const out=document.createElement('pre');out.id='test-results';out.style='position:fixed;top:0;left:0;z-index:99999;background:white;color:black;max-width:500px;white-space:pre-wrap';document.body.append(out);
const results=[];const check=(name,ok)=>{results.push((ok?'PASS ':'FAIL ')+name);out.textContent=results.join('\\n');if(!ok)throw Error(name);};
try{
await SourceSnapshots.all();await new Promise(r=>setTimeout(r,150));
if(!sessionStorage.getItem('ops-reloaded')){
const bytes=await(await fetch('/fixture.xlsx')).arrayBuffer();
const res=await ingestFile('t',new File([bytes],'synthetic.xlsx'));check('synthetic import',res.ok);
STATE.sources.t=await OperationsSync.saveManual('t',res.records,res.diag,{name:'synthetic.xlsx'});
sessionStorage.setItem('ops-reloaded','1');location.reload();return;
}
check('IndexedDB restored after reload',STATE.sources.t?.records.length===3);
STATE.receptionDay='1405/06/30';switchTab('reception');
check('daily two admissions',computeReceptionStats(STATE.sources.t.records,STATE.receptionDay).daily.length===2);
check('stopped list one car',document.getElementById('recStoppedTable').textContent.includes('TEST-002'));
check('advisor chart rendered',document.getElementById('recByStaff').children.length>0);
check('service chart rendered',document.getElementById('recServiceChart').children.length>0);
check('previous timing table preserved',document.getElementById('recAllTable').textContent.includes('TEST-001'));
for(const tab of ['dashboard','priority','slow','emdad','oil','nobat','reception']){switchTab(tab);check('tab '+tab,document.getElementById('tab-'+tab).classList.contains('active'));}
check('auto controls rendered',document.querySelectorAll('[data-ops-auto]').length>0);
out.dataset.complete='true';
}catch(e){out.textContent+='\\nERROR '+e.message;out.dataset.complete='false';}
});</script>`;
http.createServer((req,res)=>{
if(req.url==='/fixture.xlsx'){res.end(fixture);return;}
if(req.url!=='/'&&req.url!=='/test'){res.writeHead(404);res.end();return;}
let html=fs.readFileSync(path.join(root,'index (4).html'),'utf8');
html=html.replace('</head>','<script>localStorage.setItem("hedax-ops-enabled",JSON.stringify({alef:false,b:false,p:false,t:false}));</script></head>');
if(req.url==='/test')html=html.replace('</body>',testing+'</body>');
res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'});res.end(html);
}).listen(5176,'127.0.0.1',()=>console.log('Operations preview on 5176'));

