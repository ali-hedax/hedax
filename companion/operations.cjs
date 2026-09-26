'use strict';
const fs = require('node:fs/promises');
const ROUTES = Object.freeze({alef:'/RepStkStock',b:'/Dplns',p:'/RepEmdadVijeh',t:'/viewRepairCard'});
const WAREHOUSE='انبار قطعات ولوازم یدکی';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const digits=s=>String(s).replace(/[۰-۹]/g,c=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c));
function today(now=new Date()) {
  const parts=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=k=>parts.find(p=>p.type===k).value;
  return {date:get('year')+'/'+get('month')+'/'+get('day'),year:get('year'),hour:+get('hour')};
}
function validateOperation(input,now=new Date()) {
  const t=today(now),id=input&&input.sourceId;
  if(!Object.hasOwn(ROUTES,id))throw fail('INVALID_SCOPE','نوع گزارش معتبر نیست.');
  if(id==='t'&&input.part===true){
    const days=[];
    for(let i=0;i<367;i++){const d=today(new Date(now.valueOf()-i*86400000));if(d.year!==t.year)break;days.push(d.date);}
    const first=days.indexOf(input.fromDate),last=days.indexOf(input.toDate);
    if(Object.keys(input).length!==4||first<0||last<0||first<last||first-last>6)throw fail('INVALID_SCOPE','هر بخش پذیرش باید حداکثر هفت روز و در سال جاری تا امروز باشد.');
    return {sourceId:'t',fromDate:input.fromDate,toDate:input.toDate,part:true};
  }
  const expected=id==='alef'?{sourceId:id,dateKey:t.date,warehouse:WAREHOUSE}:id==='b'?{sourceId:id,dateKey:t.date,year:t.year}:{sourceId:id,fromDate:t.year+'/01/01',toDate:t.date};
  if(Object.keys(input).length!==Object.keys(expected).length||Object.entries(expected).some(([k,v])=>input[k]!==v))throw fail('INVALID_SCOPE','محدوده باید از ابتدای سال جاری تا امروز باشد؛ برای موجودی، تاریخ امروز لازم است.');
  if(id==='p'&&t.hour<10)throw fail('REPORT_NOT_READY','گزارش امداد ویژه از ساعت ۱۰ صبح تهران قابل دریافت است.');
  return expected;
}
// The real format of the bytes lives in archive.cjs so the saved copy, the served
// extension and this gate can never disagree with each other.
const archive=require('./archive.cjs');
const {captureExport}=require('./export.cjs');
const {detectFormat}=archive;
function fileKind(bytes) {
  const format=detectFormat(bytes);
  if(format==='zip')return 'xlsx';
  // SpreadsheetML and the HTML inventory table are both served as .xls by B2B and
  // both open in Excel; the true format travels separately in the payload.
  if(format==='spreadsheetml'||format==='html')return 'xls';
  throw fail('INVALID_FILE','پاسخ سامانه فایل گزارش معتبر نیست.');
}
async function field(page,name,value) {
  const el=page.getByRole('textbox',{name,exact:true});await el.fill(value);await el.press('Tab');
  if(digits(await el.inputValue()).trim()!==value)throw fail('FILTER_MISMATCH','تاریخ یا فیلتر گزارش تأیید نشد.');
}
async function blank(page,role,names) {
  for(const name of names){const el=page.getByRole(role,{name,exact:true});if((await el.inputValue()).trim())throw fail('FILTER_MISMATCH','فیلتر اضافی گزارش باید خالی باشد: '+name);}
}
async function receive(page,button,scope,root,session) {
  // Each step reports separately, so a failure names the step instead of the file.
  const stages={download:'pending',read:'pending',format:'pending',archive:'skipped'};
  const captured=await captureExport({context:page.context(),page,click:()=>button.click(),timeout:120000,fail,readFile:f=>fs.readFile(f),session});
  const {download,bytes,via,suggested,cookieCount}=captured;
  try {
    stages.download=via==='session'?'recovered-from-session':'ok';
    if(bytes.length>50*1024*1024)throw fail('INVALID_FILE','حجم گزارش بیش از حد مجاز است.');
    stages.read='ok';
    const kind=fileKind(bytes),format=detectFormat(bytes);
    stages.format=format;
    const kept=await archive.keep({root,download:via==='download'?download:null,sourceId:scope.sourceId,scope,bytes});
    stages.archive=kept.saved?'ok':kept.reason;
    return {scope,receivedAt:Date.now(),fileName:'b2b-'+scope.sourceId+'.'+kind,base64:bytes.toString('base64'),
      diagnostics:{bytes:bytes.length,format,via,sessionCookies:cookieCount,suggestedFilename:archive.safePart(suggested,''),archived:kept.saved?kept.name:null,stages}};
  } finally {await download.delete().catch(()=>{});}
}
async function runOperation(client,input,select) {
  const scope=validateOperation(input),id=scope.sourceId;
  if(client.busy)throw fail('BUSY','دریافت دیگری در حال اجراست؛ کمی بعد دوباره تلاش کنید.');
  client.busy=true;
  let phase='باز کردن مرورگر';
  try {
    const page=await client.open();phase='باز کردن صفحهٔ گزارش';await page.goto('https://b2b.isaco.ir'+ROUTES[id],{waitUntil:'domcontentloaded',timeout:45000});
    const anchor=id==='alef'?page.getByRole('listbox',{name:'انبار',exact:true}):id==='b'?page.getByRole('button',{name:'تکمیل اطلاعات',exact:true}):page.getByRole('textbox',{name:'از تاریخ پذیرش',exact:true});
    try{await anchor.waitFor({state:'visible',timeout:20000});}catch{
      if(new URL(page.url()).pathname!==ROUTES[id])throw fail('LOGIN_REQUIRED',require('./b2b.cjs').LOGIN_WAIT_MESSAGE);
      throw fail('PAGE_CHANGED','کنترل گزارش در صفحهٔ B2B پیدا نشد؛ صفحه را در پنجرهٔ همراه بررسی کنید.');
    }
    if(new URL(page.url()).pathname!==ROUTES[id])throw fail('PAGE_CHANGED','صفحهٔ گزارش مورد انتظار باز نشد.');
    let button;
    phase='تنظیم و تأیید فیلترها';
    if(id==='alef') {
      await select(page,'انبار',WAREHOUSE);
      await blank(page,'listbox',['نوع قطعات']);await blank(page,'textbox',['کد تدارکاتی']);
      button=page.getByRole('button',{name:/^\s*\S*\s*موجودی انبار$/});
    } else if(id==='b') {
      if(digits(await page.locator('#year').inputValue())!==scope.year)throw fail('FILTER_MISMATCH','سال فعال B2B با سال گزارش یکسان نیست.');
      await blank(page,'listbox',['نوع گردش','گروه قطعه','گروه خودرو']);await blank(page,'textbox',['کد اختصاصی']);
      if(await page.getByRole('checkbox',{name:/^کالا\s*خاص است؟/}).isChecked())throw fail('FILTER_MISMATCH','فیلتر کالای خاص باید غیرفعال باشد.');
      phase='تکمیل اطلاعات DPLAN';
      await anchor.click();
      await page.getByText(/[0-9۰-۹]+\s*-\s*[0-9۰-۹]+\s+از\s+[0-9۰-۹]+/).waitFor({state:'visible',timeout:60000});
      button=page.getByRole('button',{name:/^\s*\S*\s*برنامه ریزی موجودی نمایندگی$/});
    } else {
      await field(page,'از تاریخ پذیرش',scope.fromDate);await field(page,'تا تاریخ پذیرش',scope.toDate);
      if(id==='p') {
        await blank(page,'listbox',['وضعیت امداد']);
        await blank(page,'textbox',['شماره کارت','شماره شاسی','شماره امداد ویژه','کد اختصاصی','تاریخ رسید','تاریخ ثبت امداد ویژه']);
        button=page.getByRole('button',{name:/تهیه گزارش$/});
      } else {
        await blank(page,'listbox',['وضعیت پذیرش','نوع خودرو']);
        await blank(page,'textbox',['از تاریخ ترخیص','تا تاریخ ترخیص','شماره پذیرش','شماره شاسی','شماره هرم']);
        button=page.getByRole('button',{name:'خروجی اکسل',exact:true});
      }
    }
    phase='انتخاب خروجی اکسل';
    await button.waitFor({state:'visible',timeout:20000});
    phase='دریافت فایل اکسل';
    return await receive(page,button,scope,client.root,client);
  } catch(e) {
    if(e.code)throw e;
    throw fail('B2B_UNAVAILABLE','دریافت گزارش در مرحلهٔ «'+phase+'» کامل نشد. صفحهٔ بازشده در پنجرهٔ B2B را بررسی کنید.');
  } finally {client.busy=false;}
}
module.exports={ROUTES,WAREHOUSE,today,validateOperation,fileKind,runOperation,receive};
