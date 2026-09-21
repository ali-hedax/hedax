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
  const expected=id==='alef'?{sourceId:id,dateKey:t.date,warehouse:WAREHOUSE}:id==='b'?{sourceId:id,dateKey:t.date,year:t.year}:{sourceId:id,fromDate:t.year+'/01/01',toDate:t.date};
  if(Object.keys(input).length!==Object.keys(expected).length||Object.entries(expected).some(([k,v])=>input[k]!==v))throw fail('INVALID_SCOPE','محدوده باید از ابتدای سال جاری تا امروز باشد؛ برای موجودی، تاریخ امروز لازم است.');
  if(id==='p'&&t.hour<10)throw fail('REPORT_NOT_READY','گزارش امداد ویژه از ساعت ۱۰ صبح تهران قابل دریافت است.');
  return expected;
}
function fileKind(bytes) {
  if(bytes.length>=4&&bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===3&&bytes[3]===4)return 'xlsx';
  const head=bytes.subarray(0,8192).toString('utf8');
  if(/<(?:!doctype\s+html|html|table)\b/i.test(head)&&!/<(?:input|form)\b/i.test(head))return 'xls';
  throw fail('INVALID_FILE','پاسخ سامانه فایل گزارش معتبر نیست.');
}
async function field(page,name,value) {
  const el=page.getByRole('textbox',{name,exact:true});await el.fill(value);await el.press('Tab');
  if(digits(await el.inputValue()).trim()!==value)throw fail('FILTER_MISMATCH','تاریخ یا فیلتر گزارش تأیید نشد.');
}
async function blank(page,role,names) {
  for(const name of names){const el=page.getByRole(role,{name,exact:true});if((await el.inputValue()).trim())throw fail('FILTER_MISMATCH','فیلتر اضافی گزارش باید خالی باشد: '+name);}
}
async function receive(page,button,scope) {
  const pending=page.waitForEvent('download',{timeout:120000});pending.catch(()=>{});
  await button.click();const download=await pending;
  try {
    if(await download.failure())throw fail('DOWNLOAD_FAILED','دریافت گزارش کامل نشد.');
    const filename=await download.path(),stat=await fs.stat(filename);
    if(stat.size>50*1024*1024)throw fail('INVALID_FILE','حجم گزارش بیش از حد مجاز است.');
    const bytes=await fs.readFile(filename),kind=fileKind(bytes);
    return {scope,receivedAt:Date.now(),fileName:'b2b-'+scope.sourceId+'.'+kind,base64:bytes.toString('base64')};
  } finally {await download.delete().catch(()=>{});}
}
async function runOperation(client,input,select) {
  const scope=validateOperation(input),id=scope.sourceId;
  if(client.busy)throw fail('BUSY','دریافت دیگری در حال اجراست؛ کمی بعد دوباره تلاش کنید.');
  client.busy=true;
  try {
    const page=await client.open();await page.goto('https://b2b.isaco.ir'+ROUTES[id],{waitUntil:'domcontentloaded',timeout:45000});
    const anchor=id==='alef'?page.getByRole('listbox',{name:'انبار',exact:true}):id==='b'?page.getByRole('button',{name:'تکمیل اطلاعات',exact:true}):page.getByRole('textbox',{name:'از تاریخ پذیرش',exact:true});
    try{await anchor.waitFor({state:'visible',timeout:20000});}catch{throw fail('LOGIN_REQUIRED','در پنجره B2B وارد شوید؛ سپس به‌روزرسانی را بزنید.');}
    if(new URL(page.url()).pathname!==ROUTES[id])throw fail('PAGE_CHANGED','صفحهٔ گزارش مورد انتظار باز نشد.');
    let button;
    if(id==='alef') {
      await select(page,'انبار',WAREHOUSE);
      await blank(page,'listbox',['نوع قطعات']);await blank(page,'textbox',['کد تدارکاتی']);
      button=page.getByRole('button',{name:/^\s*\S*\s*موجودی انبار$/});
    } else if(id==='b') {
      if(digits(await page.locator('#year').inputValue())!==scope.year)throw fail('FILTER_MISMATCH','سال فعال B2B با سال گزارش یکسان نیست.');
      await blank(page,'listbox',['نوع گردش','گروه قطعه','گروه خودرو']);await blank(page,'textbox',['کد اختصاصی']);
      if(await page.getByRole('checkbox',{name:'کالاخاص',exact:true}).isChecked())throw fail('FILTER_MISMATCH','فیلتر کالای خاص باید غیرفعال باشد.');
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
    return await receive(page,button,scope);
  } catch(e) {
    if(e.code)throw e;
    throw fail('B2B_UNAVAILABLE','دریافت گزارش کامل نشد؛ ورود، اتصال و فیلترهای صفحه را بررسی کنید.');
  } finally {client.busy=false;}
}
module.exports={ROUTES,WAREHOUSE,today,validateOperation,fileKind,runOperation};
