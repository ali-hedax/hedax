/* End-to-end in a real browser: feed synthetic B2B payloads through the page's
   own import functions, then reload to prove the data came back from IndexedDB.

   This exercises what the Node shims cannot: the real DOMParser (SpreadsheetML
   and the inventory HTML table), real IndexedDB and the real render path.

   Run:  node tests/import-browser.cjs
   Skips (exit 0) when no Chrome is installed.
   All payloads are synthetic — no dealership data and no B2B connection. */
'use strict';

const { openDashboard } = require('./cdp.cjs');
const SSML = require('./fixtures-ssml');
const FX = require('./fixtures');

const PORT = 9335;
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const b64 = (buf) => buf.toString('base64');

/* Rebuilds a Uint8Array inside the page from base64 — no network, no file picker. */
const BYTES = (name, data) => `const ${name}=(()=>{const b=atob("${data}");const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;})();`;

const T_SCOPE = { sourceId: 't', fromDate: '1405/07/02', toDate: '1405/07/03', part: true };
const N_SCOPE = { dateKey: '1405/07/02', statusFilter: 'همه', hall: 'سالن تعمیرات' };

async function main() {
  const page = await openDashboard(PORT);
  if (!page) { console.log('Chrome یافت نشد — این آزمون رد شد (skip).'); return; }

  try {
    ok('صفحه در مرورگر واقعی بارگذاری شد', await page.evaluate('typeof ingestFile === "function"'));

    /* ---------- 1. SpreadsheetML reception, real DOMParser ---------- */
    console.log('\n۱. پذیرش تا ترخیص — Excel 2003 XML در مرورگر واقعی');
    const recv = await page.evaluate(`(async()=>{
      ${BYTES('u', b64(SSML.reception()))}
      const res = await ingestFile('t', new File([u],'b2b-t.xls'));
      if(!res.ok) return {ok:false, err:res.diag && res.diag.errorMessage};
      const st = computeReceptionStats(res.records,'1405/07/02');
      return {ok:true, format:res.diag.format, sheet:res.diag.pickedSheet, repairs:res.diag.repairs||[],
        cols:res.diag.grid[res.diag.headerRowIndex].length, valid:res.records.length, rejected:res.diag.rejectedRowCount,
        cards:new Set(res.records.map(r=>normKey(r.cardNo))).size, daily:st.daily.length,
        staff:st.staff.map(s=>s.count).sort((a,b)=>b-a), amp:res.records[0].productDesc.includes('ABS&ESC')};
    })()`);
    ok('فایل با DOMParser واقعی خوانده شد', recv.ok, recv.err);
    eq('قالب تشخیص‌داده‌شده', recv.format, 'spreadsheetml');
    eq('شیت', recv.sheet, 'لیست پذیرش ها');
    eq('تعداد ستون حفظ شد', recv.cols, SSML.T_EXPECTED.columns);
    eq('ردیف معتبر', recv.valid, SSML.T_EXPECTED.valid);
    eq('ردیف ردشده (جمع انتهای گزارش)', recv.rejected, SSML.T_EXPECTED.rejected);
    eq('کارت یکتا', recv.cards, SSML.T_EXPECTED.uniqueCards);
    ok('«&» بدون escape درست بازسازی شد', recv.amp === true);
    ok('بی‌نظمی‌های فایل گزارش شدند', Array.isArray(recv.repairs) && recv.repairs.length === 2, JSON.stringify(recv.repairs));

    /* ---------- 2. import → store → render ---------- */
    console.log('\n۲. ورود به هداکس، ذخیره و نمایش');
    const imported = await page.evaluate(`(async()=>{
      ${BYTES('u', b64(SSML.reception()))}
      const scope=${JSON.stringify(T_SCOPE)};
      const payload={scope, receivedAt:Date.now(), fileName:'b2b-t.xls', base64:btoa(String.fromCharCode(...u))};
      const r = await importOperationReport(payload, scope);
      // today is outside the fetched range, so the tab must say so rather than show zeros
      STATE.receptionDay=null; switchTab('reception');
      const outside=document.getElementById('receptionBody').innerHTML;
      STATE.receptionDay='1405/07/02'; renderReception();
      const body=document.getElementById('receptionBody').innerHTML;
      return {count:r.count, excluded:r.excluded, duplicate:r.duplicate,
        stored:!!STATE.sources.t, origin:STATE.sources.t.meta.origin, html:body.length,
        outsideWarns: outside.includes('هنوز دریافت نشده'), outsideNoZero: outside.includes('به معنی صفر پذیرش'),
        hasStaffName: body.includes('پذیرشگر ازمایشی 1')||body.includes('پذیرشگر آزمایشی ۱'),
        showsRange: body.includes('1405/07/02') && body.includes('1405/07/03')};
    })()`);
    ok('روز خارج از بازه به‌جای صفر، هشدار می‌دهد', imported.outsideWarns === true);
    ok('و صراحتاً می‌گوید صفر پذیرش نیست', imported.outsideNoZero === true);
    eq('تعداد واردشده', imported.count, SSML.T_EXPECTED.valid);
    eq('کنارگذاشته‌شده‌ها گزارش شدند', imported.excluded, SSML.T_EXPECTED.rejected);
    ok('در STATE ذخیره شد', imported.stored === true);
    eq('منبع b2b علامت خورد', imported.origin, 'b2b');
    ok('تب پذیرش برای روز داخل بازه رندر شد', imported.html > 2000, String(imported.html));
    ok('محدودهٔ واقعی گزارش نمایش داده شد', imported.showsRange === true);
    ok('نام پذیرشگر در خروجی دیده می‌شود', imported.hasStaffName === true);

    /* ---------- 3. reload: IndexedDB ---------- */
    console.log('\n۳. ماندگاری پس از تازه‌سازی صفحه');
    await page.reload();
    const after = await page.evaluate(`(async()=>{
      await new Promise(r=>setTimeout(r,900));
      const s=STATE.sources.t;
      if(!s) return {restored:false};
      const st=computeReceptionStats(s.records,'1405/07/02');
      STATE.receptionDay='1405/07/02'; switchTab('reception');
      return {restored:true, count:s.records.length, origin:s.meta.origin, from:s.meta.fromDate, to:s.meta.toDate,
        daily:st.daily.length, staffTotal:st.staff.reduce((a,x)=>a+x.count,0), html:document.getElementById('receptionBody').innerHTML.length};
    })()`);
    ok('گزارش پذیرش از IndexedDB برگشت', after.restored === true, JSON.stringify(after));
    if (after.restored) {
      eq('تعداد ردیف پس از تازه‌سازی', after.count, SSML.T_EXPECTED.valid);
      eq('بازهٔ واقعی ثبت شده', after.from + '..' + after.to, T_SCOPE.fromDate + '..' + T_SCOPE.toDate);
      eq('پذیرش روز مبنا', after.daily, 3);
      eq('جمع پذیرشگرها برابر پذیرش همان روز', after.staffTotal, 3);
      ok('تب پذیرش پس از تازه‌سازی رندر شد', after.html > 2000);
    }

    /* ---------- 4. failure keeps the last valid data ---------- */
    console.log('\n۴. حفظ آخرین دادهٔ معتبر هنگام شکست');
    const broken = await page.evaluate(`(async()=>{
      ${BYTES('u', b64(SSML.broken()))}
      const scope=${JSON.stringify(T_SCOPE)};
      const payload={scope, receivedAt:Date.now(), fileName:'b2b-t.xls', base64:btoa(String.fromCharCode(...u))};
      let err=null;
      try { await importOperationReport(payload, scope); } catch(e){ err=e.message; }
      return {err, stillThere:!!STATE.sources.t, count:STATE.sources.t?STATE.sources.t.records.length:0};
    })()`);
    ok('فایل خراب رد شد', typeof broken.err === 'string' && broken.err.length > 10, broken.err);
    eq('آخرین دادهٔ معتبر حفظ شد', broken.count, SSML.T_EXPECTED.valid);

    const mismatched = await page.evaluate(`(async()=>{
      ${BYTES('u', b64(SSML.reception()))}
      const scope=${JSON.stringify(T_SCOPE)};
      const payload={scope:{...scope,toDate:'1405/07/09'}, receivedAt:Date.now(), fileName:'b2b-t.xls', base64:btoa(String.fromCharCode(...u))};
      let err=null;
      try { await importOperationReport(payload, scope); } catch(e){ err=e.message; }
      return {err, count:STATE.sources.t?STATE.sources.t.records.length:0};
    })()`);
    ok('محدودهٔ ناهم‌خوان رد شد', typeof mismatched.err === 'string', mismatched.err);
    eq('و داده دست‌نخورده ماند', mismatched.count, SSML.T_EXPECTED.valid);

    /* ---------- 5. nobat import, duplicate, revision ---------- */
    console.log('\n۵. نوبت‌دهی — ورود، تکرار و نسخهٔ تازه');
    const nob = await page.evaluate(`(async()=>{
      ${BYTES('u', b64(FX.sampleWorkbook()))}
      const scope=${JSON.stringify(N_SCOPE)};
      const payload={scope, receivedAt:Date.now(), fileName:'b2b-nobat.xlsx', base64:btoa(String.fromCharCode(...u))};
      const first=await importB2BReport(payload, scope);
      const again=await importB2BReport({...payload, receivedAt:Date.now()+1000}, scope);
      switchTab('nobat');
      const rep=activeNobatReport(), st=computeNobatStats(rep.records);
      return {first:first.duplicate, again:again.duplicate, reports:STATE.nobat.reports.length,
        rows:st.rowCount, cards:st.uniqueCards, noCard:st.rowsWithoutCard, revision:rep.revision,
        source:rep.source, html:document.getElementById('nobatBody').innerHTML.length};
    })()`);
    eq('ورود نخست تکراری نبود', nob.first, false);
    eq('ورود دوم تکراری تشخیص داده شد', nob.again, true);
    eq('گزارش دو برابر نشد', nob.reports, 1);
    eq('تعداد ردیف', nob.rows, FX.EXPECTED.rowCount);
    eq('کارت یکتا', nob.cards, FX.EXPECTED.uniqueCards);
    eq('ردیف بدون کارت', nob.noCard, FX.EXPECTED.rowsWithoutCard);
    eq('منبع b2b ثبت شد', nob.source, 'b2b');
    ok('تب نوبت‌دهی رندر شد', nob.html > 2000, String(nob.html));

    const rev = await page.evaluate(`(async()=>{
      ${BYTES('u', b64(FX.shuffledWorkbook()))}
      const scope=${JSON.stringify(N_SCOPE)};
      const r=await importB2BReport({scope, receivedAt:Date.now()+2000, fileName:'b2b-nobat.xlsx', base64:btoa(String.fromCharCode(...u))}, scope);
      const rep=activeNobatReport();
      return {duplicate:r.duplicate, revision:rep.revision, reports:STATE.nobat.reports.length, rows:computeNobatStats(rep.records).rowCount};
    })()`);
    eq('فایل متفاوت در همان دامنه نسخهٔ تازه شد', rev.revision, 2);
    eq('و به‌جای جمع‌شدن جایگزین شد', rev.rows, FX.EXPECTED.rowCount);
    eq('سابقهٔ نسخه‌ها نگه داشته شد', rev.reports, 2);

    /* ---------- 6. reload: both stores together ---------- */
    console.log('\n۶. تازه‌سازی دوباره — هر دو منبع');
    await page.reload();
    const both = await page.evaluate(`(async()=>{
      await new Promise(r=>setTimeout(r,1000));
      const rep=activeNobatReport();
      return {reception:STATE.sources.t?STATE.sources.t.records.length:0,
        nobatReports:STATE.nobat.reports.length, nobatRows:rep?computeNobatStats(rep.records).rowCount:0,
        nobatRevision:rep?rep.revision:0};
    })()`);
    eq('پذیرش هنوز هست', both.reception, SSML.T_EXPECTED.valid);
    eq('نسخه‌های نوبت‌دهی هنوز هستند', both.nobatReports, 2);
    eq('آخرین نسخه فعال است', both.nobatRevision, 2);
    eq('ردیف‌های نوبت‌دهی برگشتند', both.nobatRows, FX.EXPECTED.rowCount);

    /* ---------- 7. the inventory HTML table, real DOMParser ---------- */
    console.log('\n۷. موجودی (جدول HTML) در مرورگر واقعی');
    const inv = await page.evaluate(`(async()=>{
      const html='<html><head><meta charset="utf-8"></head><body><table>'+
        '<tr><th>کد کالا</th><th>شرح کالا</th><th>موجودی</th><th>قیمت فروش</th></tr>'+
        '<tr><td>A-100</td><td>قطعهٔ آزمایشی الف</td><td>5</td><td>250000</td></tr>'+
        '<tr><td>A-101</td><td>قطعهٔ آزمایشی ب</td><td>0</td><td>310000</td></tr></table></body></html>';
      const res=await ingestFile('alef', new File([new TextEncoder().encode(html)],'stkstock.xls'));
      return {ok:res.ok, err:res.diag&&res.diag.errorMessage, format:res.diag.format,
        n:res.ok?res.records.length:0, code:res.ok?res.records[0].code:null, stock:res.ok?res.records[1].stock:null};
    })()`);
    ok('جدول HTML موجودی هنوز خوانده می‌شود', inv.ok === true, inv.err);
    eq('قالب', inv.format, 'html');
    eq('تعداد ردیف', inv.n, 2);
    eq('کد کالا', inv.code, 'A-100');
    eq('موجودی صفر به‌صورت صفر خوانده شد', inv.stock, 0);

    /* ---------- 8. nobat xlsx still fine in the browser ---------- */
    const nx = await page.evaluate(`(async()=>{
      ${BYTES('u', b64(FX.sampleWorkbook()))}
      const res=await ingestFile('n', new File([u],'nobat.xlsx'));
      return {ok:res.ok, format:res.diag.format, n:res.ok?res.records.length:0};
    })()`);
    ok('xlsx نوبت‌دهی هنوز خوانده می‌شود', nx.ok === true);
    eq('قالب', nx.format, 'zip');
    eq('تعداد ردیف', nx.n, FX.EXPECTED.rowCount);

    /* ---------- 9. every tab still renders ---------- */
    console.log('\n۸. رندر همهٔ تب‌ها');
    const tabs = await page.evaluate(`(()=>{const out={};for(const t of Object.keys(TAB_RENDERERS)){try{switchTab(t);out[t]='ok';}catch(e){out[t]='ERROR: '+e.message;}}return out;})()`);
    Object.keys(tabs).forEach((t) => ok(`تب «${t}» بدون خطا`, tabs[t] === 'ok', tabs[t]));
  } finally {
    page.close();
  }

  console.log(`\n${'='.repeat(52)}\nموفق: ${passed}   ناموفق: ${failed}`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
